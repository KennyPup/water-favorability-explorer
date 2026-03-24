#!/usr/bin/env python3
"""
run_hf.py – HF v1 (Hydrogeologic Favorability) pipeline
=========================================================
Reads a JSON config from stdin, runs the full HF pipeline, and prints
exactly one status line to stdout:

  On success:  OK:PROJECTCODE:RESOLUTION:/abs/path/to/zip
  On error:    ERROR:descriptive message

Inputs (from stdin JSON):
  projectName  str
  projectCode  str (2-3 letters, upper)
  aoi          {type:"bbox", minLat, maxLat, minLon, maxLon}
  resolution   "30m" | "90m" | "1km"
  weights      {geology: float, soil: float, tca: float}
  outputsDir   str  (absolute path for outputs)

Outputs (all written to outputsDir/PROJECTCODE/):
  PROJECTCODE_HF_dem.tif
  PROJECTCODE_HF_geologyPerm.tif       ← now from Macrostrat API
  PROJECTCODE_HF_soilPerm.tif
  PROJECTCODE_HF_tca_raw.tif
  PROJECTCODE_HF_tca_norm.tif
  PROJECTCODE_HF_tca_rrz.tif
  PROJECTCODE_HF_tca_nrz.tif
  PROJECTCODE_HF_hydroFavor.tif
  PROJECTCODE_HF_weights_matrix.csv
  PROJECTCODE_HF_metadata.json
  PROJECTCODE_HF_outputs_RES.zip  ← everything above, archived

Geology data source
-------------------
Frontend map overlay: Macrostrat carto tiles  https://tiles.macrostrat.org/carto/{z}/{x}/{y}.png
HF geology raster:    Macrostrat GeoJSON API  https://macrostrat.org/api/v2/geologic_units/map
Both use the same underlying Macrostrat database, ensuring the geology the
user sees on the map is the same geology driving the HF permeability raster.
"""

import sys
import os
import json
import math
import zipfile
import traceback
import urllib.request
import urllib.parse
from pathlib import Path
from datetime import datetime

import numpy as np
import rasterio
from rasterio.transform import from_bounds
from rasterio.crs import CRS
from rasterio.warp import calculate_default_transform, reproject, Resampling
from rasterio.features import rasterize as rio_rasterize
import pyproj


# ─── Resolution helpers ───────────────────────────────────────────────────────

RES_M = {"30m": 30, "90m": 90, "1km": 1000}


def utm_epsg(centre_lat: float, centre_lon: float) -> int:
    """Return EPSG code for the central UTM zone of the AOI."""
    zone = math.floor((centre_lon + 180) / 6) + 1
    base = 32600 if centre_lat >= 0 else 32700
    return base + zone


def bbox_to_utm(minLat, maxLat, minLon, maxLon, epsg: int):
    """
    Project a geographic bbox to UTM and return (min_x, max_x, min_y, max_y).
    """
    wgs84 = pyproj.CRS("EPSG:4326")
    utm   = pyproj.CRS(f"EPSG:{epsg}")
    transformer = pyproj.Transformer.from_crs(wgs84, utm, always_xy=True)
    corners_lon = [minLon, maxLon, minLon, maxLon]
    corners_lat = [minLat, minLat, maxLat, maxLat]
    xs, ys = transformer.transform(corners_lon, corners_lat)
    return min(xs), max(xs), min(ys), max(ys)


def make_grid(min_x, max_x, min_y, max_y, res_m: int):
    """Return (transform, ncols, nrows) for the UTM grid."""
    ncols = math.ceil((max_x - min_x) / res_m)
    nrows = math.ceil((max_y - min_y) / res_m)
    transform = from_bounds(min_x, min_y, max_x, max_y, ncols, nrows)
    return transform, ncols, nrows


# ─── DEM (Copernicus stub) ────────────────────────────────────────────────────

def fetch_copernicus_dem(aoi: dict, res_m: int, utm_crs, grid_transform, ncols, nrows, out_path: str):
    """
    Fetch or synthesise a DEM for the AOI.

    REAL IMPLEMENTATION TODO:
    --------------------------
    1. Query the Copernicus DEM 30m GLO-30 tiles from AWS open-data:
       https://registry.opendata.aws/copernicus-dem/
       Tile naming: Copernicus_DSM_COG_10_N{lat}_00_E{lon}_00_DEM/
    2. Download the relevant 1°×1° tiles covering the AOI.
    3. Mosaic them with rasterio.merge.
    4. Reproject/resample to UTM at the target resolution.
    5. Clip to the AOI grid.

    STUB (Phase 1):
    ---------------
    Generates a synthetic sinusoidal DEM so the rest of the pipeline
    (flow direction, TCA, RRZ/NRZ) can run end-to-end without real data.
    """
    print("[run_hf] DEM: generating synthetic DEM (Copernicus stub)", file=sys.stderr)

    x_idx = np.tile(np.arange(ncols), (nrows, 1)).astype(np.float32)
    y_idx = np.tile(np.arange(nrows)[:, np.newaxis], (1, ncols)).astype(np.float32)

    data = (
        500.0
        + 300.0 * (y_idx / nrows)
        + 80.0  * np.sin(2 * np.pi * x_idx / ncols * 4)
        + 40.0  * np.sin(2 * np.pi * y_idx / nrows * 6)
        + 10.0  * np.random.default_rng(42).random((nrows, ncols)).astype(np.float32)
    ).astype(np.float32)

    profile = {
        "driver": "GTiff", "dtype": "float32",
        "width": ncols, "height": nrows, "count": 1,
        "crs": utm_crs, "transform": grid_transform,
        "nodata": -9999.0, "compress": "lzw",
    }
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(data, 1)

    print(f"[run_hf] DEM written: {nrows}×{ncols} px → {out_path}", file=sys.stderr)
    return data


# ─── Geology permeability from Macrostrat ────────────────────────────────────
#
# Data source: Macrostrat GeoJSON API — same database that backs the
# frontend carto tile overlay (https://tiles.macrostrat.org/carto/{z}/{x}/{y}.png).
#
# Permeability LUT
# ----------------
# Maps Macrostrat `lith` text fields → relative permeability score 0–1.
# Matching is keyword-based (substring, case-insensitive) so it is robust
# to the varied free-text values returned by the API.
# Adjust values here to refine the permeability model.
#
# Rule priority: first matching keyword wins (ordered highest→lowest perm).
#
GEOLOGY_LITH_PERM_LUT = [
    # keyword (lower)          perm   description
    ("unconsolidated",         0.95), # Alluvium, colluvium, loose sand/gravel
    ("alluvium",               0.95), # River alluvium
    ("gravel",                 0.92), # Gravel / conglomerate
    ("sand",                   0.90), # Sandy sediments
    ("conglomerate",           0.85), # Conglomerate
    ("sandstone",              0.82), # Sandstone – good secondary perm
    ("siliciclastic",          0.80), # Siliciclastic sedimentary rocks
    ("limestone",              0.78), # Carbonate – karst potential
    ("dolomite",               0.75), # Dolostone – karst potential
    ("carbonate",              0.72), # Generic carbonate
    ("chalk",                  0.70), # Chalk – porous carbonate
    ("tuff",                   0.65), # Volcanic tuff – variable perm
    ("pyroclastic",            0.62), # Pyroclastics – variable
    ("mudstone",               0.30), # Mudstone – low perm
    ("shale",                  0.25), # Shale – very low perm
    ("clay",                   0.20), # Clay – impermeable
    ("evaporite",              0.40), # Evaporites – variable
    ("gypsum",                 0.40), # Gypsum
    ("salt",                   0.38), # Salt / halite
    ("rhyolite",               0.35), # Acid volcanic
    ("andesite",               0.30), # Intermediate volcanic
    ("basalt",                 0.28), # Basic volcanic – low primary perm
    ("volcanic",               0.32), # Generic volcanic
    ("schist",                 0.18), # Metamorphic – low primary perm
    ("gneiss",                 0.20), # Metamorphic
    ("quartzite",              0.22), # Quartzite
    ("metamorphic",            0.20), # Generic metamorphic
    ("granite",                0.15), # Acid plutonic – low primary perm
    ("granodiorite",           0.15), # Granodiorite
    ("gabbro",                 0.18), # Basic plutonic
    ("plutonic",               0.15), # Generic plutonic
    ("igneous",                0.25), # Generic igneous (fallback)
    ("sedimentary",            0.55), # Generic sedimentary (fallback)
]
GEOLOGY_DEFAULT_PERM = 0.40  # fallback when no keyword matches

MACROSTRAT_SOURCE = "Macrostrat global geology database (macrostrat.org)"
MACROSTRAT_API_URL = "https://macrostrat.org/api/v2/geologic_units/map"
MACROSTRAT_TILE_URL = "https://tiles.macrostrat.org/carto/{z}/{x}/{y}.png"


def lith_to_perm(lith_text: str) -> float:
    """Map a Macrostrat lith string to a permeability score 0–1."""
    if not lith_text:
        return GEOLOGY_DEFAULT_PERM
    low = lith_text.lower()
    for keyword, perm in GEOLOGY_LITH_PERM_LUT:
        if keyword in low:
            return perm
    return GEOLOGY_DEFAULT_PERM


def _pick_scale(aoi_deg_width: float) -> str:
    """
    Choose the Macrostrat scale parameter based on AOI width.
      small  – continent-scale maps  (best for > ~10° wide AOIs)
      medium – regional maps         (best for ~2–10°)
      large  – local maps            (best for < ~2°)
    """
    if aoi_deg_width > 8:
        return "small"
    if aoi_deg_width > 2:
        return "medium"
    return "large"


def fetch_macrostrat_geology(minLat, maxLat, minLon, maxLon) -> list:
    """
    Fetch Macrostrat geology polygons for the AOI as a list of
    (geometry_dict, perm_value) tuples suitable for rasterio.rasterize.

    Strategy:
    - Query at the appropriate scale; if the primary scale returns no
      features, fall back to coarser scales automatically.
    - Each polygon is assigned a permeability score via lith_to_perm().

    Returns [] on complete failure (caller uses synthetic fallback).
    """
    aoi_w = maxLon - minLon
    scales = [_pick_scale(aoi_w)]
    # Always add fallback scales (coarser → finer order)
    for s in ["small", "medium", "large"]:
        if s not in scales:
            scales.append(s)

    # Use centre point + scale (Macrostrat v2 does not support bbox queries directly;
    # we request features at the centre and rely on the GeoJSON to cover the AOI).
    centre_lat = (minLat + maxLat) / 2
    centre_lon = (minLon + maxLon) / 2

    for scale in scales:
        params = urllib.parse.urlencode({
            "lat": round(centre_lat, 6),
            "lng": round(centre_lon, 6),
            "scale": scale,
            "format": "geojson",
        })
        url = f"{MACROSTRAT_API_URL}?{params}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "WaterFavorabilityExplorer/1.0"})
            with urllib.request.urlopen(req, timeout=20) as resp:
                body = json.loads(resp.read().decode())

            features = body.get("success", {}).get("data", {}).get("features", [])
            if not features:
                print(f"[run_hf] Macrostrat: scale={scale} returned 0 features, trying next scale",
                      file=sys.stderr)
                continue

            print(f"[run_hf] Macrostrat: scale={scale} → {len(features)} polygon(s)", file=sys.stderr)

            result = []
            for feat in features:
                geom = feat.get("geometry")
                if not geom:
                    continue
                lith = feat.get("properties", {}).get("lith") or ""
                perm = lith_to_perm(lith)
                result.append((geom, perm))

            if result:
                return result

        except Exception as e:
            print(f"[run_hf] Macrostrat fetch error (scale={scale}): {e}", file=sys.stderr)

    return []


def build_geology_perm_raster(
    minLat, maxLat, minLon, maxLon,
    utm_crs, grid_transform, ncols, nrows, out_path: str
) -> tuple:
    """
    Build the geology permeability raster for the AOI.

    1. Fetch Macrostrat GeoJSON polygons for the AOI.
    2. Reproject polygon geometries from WGS84 → UTM.
    3. Rasterize: burn permeability value per pixel (last polygon wins where
       they overlap; Macrostrat polygons at a given scale are non-overlapping).
    4. Fill any un-covered pixels with the default permeability.
    5. Min–max normalise 0–1 over the AOI.
    6. Write GeoTIFF.

    Returns (perm_norm_array, source_label, lut_used_bool).
    """
    from_wgs84 = pyproj.Transformer.from_crs(
        pyproj.CRS("EPSG:4326"), utm_crs, always_xy=True
    )

    features = fetch_macrostrat_geology(minLat, maxLat, minLon, maxLon)

    if features:
        # Reproject each geometry from WGS84 to UTM in-place
        def _reproject_geom(geom):
            """Reproject a GeoJSON geometry dict from WGS84 → UTM."""
            gtype = geom["type"]
            if gtype == "Polygon":
                rings = []
                for ring in geom["coordinates"]:
                    xs, ys = from_wgs84.transform(
                        [c[0] for c in ring], [c[1] for c in ring]
                    )
                    rings.append(list(zip(xs, ys)))
                return {"type": "Polygon", "coordinates": rings}
            elif gtype == "MultiPolygon":
                polys = []
                for poly in geom["coordinates"]:
                    rings = []
                    for ring in poly:
                        xs, ys = from_wgs84.transform(
                            [c[0] for c in ring], [c[1] for c in ring]
                        )
                        rings.append(list(zip(xs, ys)))
                    polys.append(rings)
                return {"type": "MultiPolygon", "coordinates": polys}
            return geom  # point / linestring fallback (should not occur)

        shapes = []
        for geom, perm in features:
            try:
                utm_geom = _reproject_geom(geom)
                # Scale perm to integer (×1000) for rasterization, decode after
                shapes.append((utm_geom, int(round(perm * 1000))))
            except Exception as e:
                print(f"[run_hf] Skipping polygon (reproject error): {e}", file=sys.stderr)

        if shapes:
            # Rasterize at ×1000 scale, then decode
            perm_int = rio_rasterize(
                shapes,
                out_shape=(nrows, ncols),
                transform=grid_transform,
                fill=0,          # 0 = un-covered (will be filled with default below)
                dtype="uint16",
                all_touched=False,
            )
            default_int = int(round(GEOLOGY_DEFAULT_PERM * 1000))
            # Fill un-covered pixels with default permeability
            perm_int = np.where(perm_int == 0, default_int, perm_int)
            perm = (perm_int / 1000.0).astype(np.float32)

            source_label = MACROSTRAT_SOURCE
            used_real = True
            print(f"[run_hf] Geology raster: rasterized {len(shapes)} Macrostrat polygons", file=sys.stderr)
        else:
            perm = None
            used_real = False
    else:
        perm = None
        used_real = False

    if perm is None:
        print("[run_hf] Geology: Macrostrat returned no usable polygons – using synthetic fallback",
              file=sys.stderr)
        rng = np.random.default_rng(1)
        lo = rng.random((nrows // 8 + 1, ncols // 8 + 1)).astype(np.float32)
        from scipy.ndimage import zoom
        try:
            perm = zoom(lo, (nrows / lo.shape[0], ncols / lo.shape[1]), order=1)[:nrows, :ncols].astype(np.float32)
        except Exception:
            perm = np.full((nrows, ncols), 0.5, dtype=np.float32)
        source_label = "Synthetic (Macrostrat unavailable)"
        used_real = False

    # Min–max normalise 0–1 over valid pixels
    valid = np.isfinite(perm)
    if valid.any():
        mn, mx = float(perm[valid].min()), float(perm[valid].max())
        if mx > mn:
            perm_norm = np.where(valid, (perm - mn) / (mx - mn), np.nan).astype(np.float32)
        else:
            perm_norm = np.where(valid, 0.5, np.nan).astype(np.float32)
        print(f"[run_hf] Geology perm: raw range [{mn:.3f}, {mx:.3f}] → normalised [0, 1]",
              file=sys.stderr)
    else:
        perm_norm = np.full((nrows, ncols), 0.5, dtype=np.float32)

    profile = {
        "driver": "GTiff", "dtype": "float32",
        "width": ncols, "height": nrows, "count": 1,
        "crs": utm_crs, "transform": grid_transform,
        "nodata": float("nan"), "compress": "lzw",
    }
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(perm_norm, 1)

    print(f"[run_hf] Geology permeability written → {out_path}", file=sys.stderr)
    return perm_norm, source_label, used_real


# ─── Soil permeability (synthetic / real) ────────────────────────────────────

SOIL_PERM_LUT = {
    # FAO/HWSD soil class codes → permeability 0–1
    # Refine these values when a real soil raster is integrated.
    1:  0.90,  # Sandy / coarse
    2:  0.80,  # Loamy sand
    3:  0.70,  # Sandy loam
    4:  0.60,  # Loam
    5:  0.45,  # Silt loam
    6:  0.35,  # Silt
    7:  0.30,  # Clay loam
    8:  0.20,  # Silty clay loam
    9:  0.15,  # Silty clay
    10: 0.10,  # Clay
    0:  0.50,  # Default / unknown
}


def load_or_synthesise_soil_perm(
    aoi, utm_crs, grid_transform, ncols, nrows, out_path, config_paths
) -> np.ndarray:
    """
    Load a real soil raster (HWSD / iSDA) from data_sources.json, OR
    generate a synthetic spatially-coherent soil permeability surface.
    """
    src_path = config_paths.get("soil")
    perm = None

    if src_path and os.path.isfile(src_path):
        print(f"[run_hf] Soil: loading real data from {src_path}", file=sys.stderr)
        try:
            with rasterio.open(src_path) as src:
                raw = np.zeros((nrows, ncols), dtype=np.float32)
                reproject(
                    source=rasterio.band(src, 1),
                    destination=raw,
                    src_transform=src.transform, src_crs=src.crs,
                    dst_transform=grid_transform, dst_crs=utm_crs,
                    resampling=Resampling.nearest,
                )
            default_val = SOIL_PERM_LUT.get(0, 0.50)
            perm = np.vectorize(lambda v: SOIL_PERM_LUT.get(int(v), default_val))(raw).astype(np.float32)
        except Exception as e:
            print(f"[run_hf] Soil: real data failed ({e}), using synthetic", file=sys.stderr)
            perm = None
    else:
        if src_path:
            print(f"[run_hf] Soil: configured path not found ({src_path}), using synthetic", file=sys.stderr)
        else:
            print("[run_hf] Soil: no data source configured, using synthetic", file=sys.stderr)

    if perm is None:
        rng = np.random.default_rng(2)
        lo = rng.random((nrows // 8 + 1, ncols // 8 + 1)).astype(np.float32)
        from scipy.ndimage import zoom
        try:
            perm = zoom(lo, (nrows / lo.shape[0], ncols / lo.shape[1]), order=1)[:nrows, :ncols].astype(np.float32)
        except Exception:
            perm = np.full((nrows, ncols), 0.5, dtype=np.float32)

    # Min–max normalise
    valid = np.isfinite(perm) & (perm != -9999)
    if valid.any():
        mn, mx = perm[valid].min(), perm[valid].max()
        if mx > mn:
            perm = np.where(valid, (perm - mn) / (mx - mn), np.nan).astype(np.float32)
        else:
            perm = np.where(valid, 0.5, np.nan).astype(np.float32)
    else:
        perm = np.full((nrows, ncols), np.nan, dtype=np.float32)

    profile = {
        "driver": "GTiff", "dtype": "float32",
        "width": ncols, "height": nrows, "count": 1,
        "crs": utm_crs, "transform": grid_transform,
        "nodata": float("nan"), "compress": "lzw",
    }
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(perm.astype(np.float32), 1)

    print(f"[run_hf] Soil permeability written → {out_path}", file=sys.stderr)
    return perm.astype(np.float32)


# ─── TCA and RRZ/NRZ ─────────────────────────────────────────────────────────

def run_tca_pipeline(dem, grid_transform, utm_crs, ncols, nrows, out_dir, code):
    """
    Compute flow accumulation (TCA) from the DEM using pysheds or whitebox.
    Falls back to a deterministic synthetic TCA if no library is available.
    """

    def _write_tif(data, path, dtype="float32", nodata=None):
        profile = {
            "driver": "GTiff", "dtype": dtype,
            "width": ncols, "height": nrows, "count": 1,
            "crs": utm_crs, "transform": grid_transform,
            "nodata": nodata if nodata is not None else float("nan"), "compress": "lzw",
        }
        with rasterio.open(path, "w", **profile) as dst:
            dst.write(data.astype(dtype), 1)

    tca_raw_path  = os.path.join(out_dir, f"{code}_HF_tca_raw.tif")
    tca_norm_path = os.path.join(out_dir, f"{code}_HF_tca_norm.tif")
    tca_rrz_path  = os.path.join(out_dir, f"{code}_HF_tca_rrz.tif")
    tca_nrz_path  = os.path.join(out_dir, f"{code}_HF_tca_nrz.tif")

    tca_raw = None

    # ── Try pysheds ──────────────────────────────────────────────────────────
    try:
        from pysheds.grid import Grid
        import tempfile

        print("[run_hf] TCA: using pysheds D8 flow accumulation", file=sys.stderr)

        with tempfile.TemporaryDirectory() as tmpdir:
            dem_path_tmp = os.path.join(tmpdir, "dem.tif")
            _write_tif(dem, dem_path_tmp)
            grid = Grid.from_raster(dem_path_tmp)
            dem_data = grid.read_raster(dem_path_tmp)
            pit_filled = grid.fill_pits(dem_data)
            flooded    = grid.fill_depressions(pit_filled)
            inflated   = grid.resolve_flats(flooded)
            fdir = grid.flowdir(inflated)
            acc = grid.accumulation(fdir).astype(np.float32)
            tca_raw = acc

    except ImportError:
        print("[run_hf] TCA: pysheds not found, trying whitebox…", file=sys.stderr)

    # ── Try whitebox ─────────────────────────────────────────────────────────
    if tca_raw is None:
        try:
            import whitebox
            import tempfile

            print("[run_hf] TCA: using WhiteboxTools", file=sys.stderr)
            wbt = whitebox.WhiteboxTools()
            wbt.verbose = False

            with tempfile.TemporaryDirectory() as tmpdir:
                dem_in   = os.path.join(tmpdir, "dem.tif")
                filled   = os.path.join(tmpdir, "filled.tif")
                fdir_out = os.path.join(tmpdir, "fdir.tif")
                acc_out  = os.path.join(tmpdir, "acc.tif")
                _write_tif(dem, dem_in)
                wbt.fill_depressions(dem_in, filled)
                wbt.d8_pointer(filled, fdir_out)
                wbt.d8_flow_accumulation(fdir_out, acc_out, out_type="cells")
                with rasterio.open(acc_out) as src:
                    tca_raw = src.read(1).astype(np.float32)

        except ImportError:
            print("[run_hf] TCA: whitebox not found, using synthetic TCA", file=sys.stderr)

    # ── Synthetic TCA fallback ───────────────────────────────────────────────
    if tca_raw is None:
        print("[run_hf] TCA: generating synthetic flow accumulation from DEM gradient",
              file=sys.stderr)
        from scipy.ndimage import gaussian_filter
        smoothed = gaussian_filter(dem.astype(np.float64), sigma=2)
        dy, dx = np.gradient(smoothed)
        slope_mag = np.sqrt(dx**2 + dy**2) + 1e-6
        inverted = 1.0 / slope_mag
        cumulative = np.cumsum(np.cumsum(inverted, axis=0), axis=1)
        tca_raw = (cumulative / cumulative.max() * 1e6).astype(np.float32)

    _write_tif(tca_raw, tca_raw_path)
    print(f"[run_hf] TCA raw written → {tca_raw_path}", file=sys.stderr)

    # Log-normalise TCA 0–1
    valid_mask = np.isfinite(tca_raw) & (tca_raw >= 0)
    tca_log = np.where(valid_mask, np.log10(tca_raw + 1), np.nan).astype(np.float64)
    valid_log = np.isfinite(tca_log)
    if valid_log.any():
        mn = tca_log[valid_log].min()
        mx = tca_log[valid_log].max()
        if mx > mn:
            tca_norm = np.where(valid_log, (tca_log - mn) / (mx - mn), np.nan).astype(np.float32)
        else:
            tca_norm = np.where(valid_log, 0.5, np.nan).astype(np.float32)
    else:
        tca_norm = np.full((nrows, ncols), np.nan, dtype=np.float32)

    _write_tif(tca_norm, tca_norm_path)
    print(f"[run_hf] TCA normalised written → {tca_norm_path}", file=sys.stderr)

    valid_vals = tca_raw[np.isfinite(tca_raw) & (tca_raw >= 0)]
    if valid_vals.size > 0:
        p60 = float(np.percentile(valid_vals, 60))
        p80 = float(np.percentile(valid_vals, 80))
    else:
        p60, p80 = 0.0, 0.0

    rrz = np.where((tca_raw >= p80) & np.isfinite(tca_raw), 1.0, np.nan).astype(np.float32)
    _write_tif(rrz, tca_rrz_path, nodata=float("nan"))
    print(f"[run_hf] TCA RRZ written (P80={p80:.1f}) → {tca_rrz_path}", file=sys.stderr)

    nrz = np.where(
        (tca_raw >= p60) & (tca_raw < p80) & np.isfinite(tca_raw), 1.0, np.nan
    ).astype(np.float32)
    _write_tif(nrz, tca_nrz_path, nodata=float("nan"))
    print(f"[run_hf] TCA NRZ written (P60={p60:.1f}) → {tca_nrz_path}", file=sys.stderr)

    return tca_raw, tca_norm, p60, p80


# ─── HF calculation ──────────────────────────────────────────────────────────

def compute_hf(geology_norm, soil_norm, tca_norm, weights, grid_transform, utm_crs, ncols, nrows, out_path):
    """
    HF = (w_geo * G_norm + w_soil * S_norm + w_tca * TCA_norm) / (w_geo + w_soil + w_tca)
    Only valid where all three inputs are valid (finite).
    """
    w_geo  = weights.get("geology", 1.0)
    w_soil = weights.get("soil",    1.0)
    w_tca  = weights.get("tca",     1.0)
    w_sum  = w_geo + w_soil + w_tca

    valid = (
        np.isfinite(geology_norm) &
        np.isfinite(soil_norm)    &
        np.isfinite(tca_norm)
    )

    hf = np.full((nrows, ncols), np.nan, dtype=np.float64)
    hf[valid] = (
        w_geo  * geology_norm[valid].astype(np.float64) +
        w_soil * soil_norm[valid].astype(np.float64)    +
        w_tca  * tca_norm[valid].astype(np.float64)
    ) / w_sum
    hf = hf.astype(np.float32)

    profile = {
        "driver": "GTiff", "dtype": "float32",
        "width": ncols, "height": nrows, "count": 1,
        "crs": utm_crs, "transform": grid_transform,
        "nodata": float("nan"), "compress": "lzw",
    }
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(hf, 1)

    valid_hf = hf[np.isfinite(hf)]
    mn   = float(valid_hf.min())  if valid_hf.size else 0.0
    mx   = float(valid_hf.max())  if valid_hf.size else 0.0
    mean = float(valid_hf.mean()) if valid_hf.size else 0.0
    print(f"[run_hf] HF raster written (min={mn:.3f} mean={mean:.3f} max={mx:.3f}) → {out_path}",
          file=sys.stderr)
    return hf


# ─── Main pipeline ────────────────────────────────────────────────────────────

def main():
    # ── 1. Read config from stdin ────────────────────────────────────────────
    raw = sys.stdin.read().strip()
    if not raw:
        print("ERROR:No configuration received on stdin", flush=True)
        sys.exit(1)

    try:
        cfg = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"ERROR:JSON parse error: {e}", flush=True)
        sys.exit(1)

    project_name = cfg.get("projectName", "HF Project")
    code         = cfg.get("projectCode", "HF").upper()
    aoi          = cfg.get("aoi", {})
    resolution   = cfg.get("resolution", "90m")
    weights      = cfg.get("weights", {"geology": 1.0, "soil": 1.0, "tca": 1.0})
    outputs_dir  = cfg.get("outputsDir", os.path.join(os.getcwd(), "data", "outputs"))

    res_m = RES_M.get(resolution, 90)

    minLat = float(aoi.get("minLat", 0))
    maxLat = float(aoi.get("maxLat", 1))
    minLon = float(aoi.get("minLon", 0))
    maxLon = float(aoi.get("maxLon", 1))

    print(f"[run_hf] Starting HF v1: project={code} resolution={resolution} "
          f"aoi=[{minLat},{maxLat},{minLon},{maxLon}]", file=sys.stderr)

    # ── 2. Create per-project output directory ───────────────────────────────
    out_dir = os.path.join(outputs_dir, code)
    os.makedirs(out_dir, exist_ok=True)

    # ── 3. Load data-source config (soil raster path) ────────────────────────
    ds_config_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "data", "geology_config", "data_sources.json"
    )
    data_sources = {}
    if os.path.isfile(ds_config_path):
        with open(ds_config_path) as f:
            data_sources = json.load(f)
    else:
        print(f"[run_hf] data_sources.json not found; soil will use synthetic", file=sys.stderr)

    # ── 4. Compute UTM grid ──────────────────────────────────────────────────
    centre_lat = (minLat + maxLat) / 2
    centre_lon = (minLon + maxLon) / 2
    epsg_code  = utm_epsg(centre_lat, centre_lon)
    utm_crs    = CRS.from_epsg(epsg_code)

    min_x, max_x, min_y, max_y = bbox_to_utm(minLat, maxLat, minLon, maxLon, epsg_code)
    grid_transform, ncols, nrows = make_grid(min_x, max_x, min_y, max_y, res_m)

    pixel_count = ncols * nrows
    output_size_bytes = pixel_count * 4 * 8
    output_size_mb    = round(output_size_bytes / (1024 * 1024), 1)

    print(f"[run_hf] UTM CRS: EPSG:{epsg_code}, grid: {ncols}×{nrows} = {pixel_count:,} px, "
          f"~{output_size_mb} MB", file=sys.stderr)

    # ── 5. DEM ───────────────────────────────────────────────────────────────
    dem_path = os.path.join(out_dir, f"{code}_HF_dem.tif")
    dem = fetch_copernicus_dem(aoi, res_m, utm_crs, grid_transform, ncols, nrows, dem_path)

    # ── 6. Geology permeability (from Macrostrat) ────────────────────────────
    geo_out = os.path.join(out_dir, f"{code}_HF_geologyPerm.tif")
    geology_norm, geology_source_label, geology_used_real = build_geology_perm_raster(
        minLat, maxLat, minLon, maxLon,
        utm_crs, grid_transform, ncols, nrows, geo_out
    )

    # ── 7. Soil permeability ─────────────────────────────────────────────────
    soil_out = os.path.join(out_dir, f"{code}_HF_soilPerm.tif")
    soil_norm = load_or_synthesise_soil_perm(
        aoi, utm_crs, grid_transform, ncols, nrows, soil_out, data_sources
    )

    # ── 8. TCA, RRZ, NRZ ────────────────────────────────────────────────────
    tca_raw, tca_norm, p60, p80 = run_tca_pipeline(
        dem, grid_transform, utm_crs, ncols, nrows, out_dir, code
    )

    # ── 9. HF raster ─────────────────────────────────────────────────────────
    hf_out = os.path.join(out_dir, f"{code}_HF_hydroFavor.tif")
    hf = compute_hf(geology_norm, soil_norm, tca_norm, weights,
                    grid_transform, utm_crs, ncols, nrows, hf_out)

    # ── 10. Weights matrix CSV ───────────────────────────────────────────────
    csv_path = os.path.join(out_dir, f"{code}_HF_weights_matrix.csv")
    with open(csv_path, "w") as f:
        f.write("layer,weight\n")
        f.write(f"geology,{weights.get('geology', 1.0)}\n")
        f.write(f"soil,{weights.get('soil', 1.0)}\n")
        f.write(f"tca,{weights.get('tca', 1.0)}\n")
    print(f"[run_hf] Weights matrix written → {csv_path}", file=sys.stderr)

    # ── 11. Metadata JSON ────────────────────────────────────────────────────
    lut_summary = {kw: perm for kw, perm in GEOLOGY_LITH_PERM_LUT}

    meta = {
        "projectName":       project_name,
        "projectCode":       code,
        "createdAt":         datetime.utcnow().isoformat() + "Z",
        "aoi": {
            "type":   "bbox",
            "minLat": minLat, "maxLat": maxLat,
            "minLon": minLon, "maxLon": maxLon,
        },
        "utmCrs":            f"EPSG:{epsg_code}",
        "resolution":        resolution,
        "resolutionMetres":  res_m,
        "gridCols":          ncols,
        "gridRows":          nrows,
        "pixelCount":        pixel_count,
        "estimatedOutputMB": output_size_mb,
        "demSource":         "Copernicus GLO-30 (STUB – synthetic in Phase 1)",
        "geologySource": {
            "name":          geology_source_label,
            "apiUrl":        MACROSTRAT_API_URL,
            "tileUrl":       MACROSTRAT_TILE_URL,
            "note":          "Same data as the map overlay – geology visible on map = geology used in HF",
            "usedRealData":  geology_used_real,
        },
        "geologyPermLUT": {
            "description":   "Keyword-based mapping of Macrostrat lith text → permeability score 0–1",
            "defaultPerm":   GEOLOGY_DEFAULT_PERM,
            "normalised":    True,
            "normalisationNote": "Min–max normalised to 0–1 over AOI valid pixels",
            "keywords":      lut_summary,
        },
        "soilSource":        data_sources.get("soil", "synthetic (no soil raster configured)"),
        "tcaPercentiles": {
            "P60": round(p60, 2),
            "P80": round(p80, 2),
            "RRZ_definition": "TCA >= P80",
            "NRZ_definition": "P60 <= TCA < P80",
        },
        "weights":           weights,
        "hfFormula":         "HF = (w_geo*G + w_soil*S + w_tca*TCA) / sum(weights)",
        "phases":            {"HF_v1": "complete", "RF": "planned", "WF": "planned"},
    }
    meta_path = os.path.join(out_dir, f"{code}_HF_metadata.json")
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)
    print(f"[run_hf] Metadata written → {meta_path}", file=sys.stderr)

    # ── 12. Zip all outputs ───────────────────────────────────────────────────
    zip_name = f"{code}_HF_outputs_{resolution}.zip"
    zip_path = os.path.join(outputs_dir, zip_name)

    files_to_zip = [
        f"{code}_HF_dem.tif",
        f"{code}_HF_geologyPerm.tif",
        f"{code}_HF_soilPerm.tif",
        f"{code}_HF_tca_raw.tif",
        f"{code}_HF_tca_norm.tif",
        f"{code}_HF_tca_rrz.tif",
        f"{code}_HF_tca_nrz.tif",
        f"{code}_HF_hydroFavor.tif",
        f"{code}_HF_weights_matrix.csv",
        f"{code}_HF_metadata.json",
    ]

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for fname in files_to_zip:
            fpath = os.path.join(out_dir, fname)
            if os.path.isfile(fpath):
                zf.write(fpath, fname)
            else:
                print(f"[run_hf] WARNING: expected output not found: {fpath}", file=sys.stderr)

    zip_size_mb = round(os.path.getsize(zip_path) / (1024 * 1024), 1)
    print(f"[run_hf] Zip written ({zip_size_mb} MB) → {zip_path}", file=sys.stderr)

    # ── 13. Success status line ───────────────────────────────────────────────
    print(f"OK:{code}:{resolution}:{zip_path}", flush=True)
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        tb = traceback.format_exc()
        print(f"ERROR:{exc}", flush=True)
        print(tb, file=sys.stderr)
        sys.exit(1)

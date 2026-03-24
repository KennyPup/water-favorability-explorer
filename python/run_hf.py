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
import gc
import json
import math
import time
import zipfile
import threading
import argparse
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

# Maximum pixel count before we decimate the DEM for TCA to protect Render's
# ~512 MB RAM limit.  4 M pixels @ float32 ≈ 16 MB per array; pysheds needs
# ~8× that in working memory, so we cap at ~4 M for safety.
MAX_TCA_PIXELS = 4_000_000


def _heartbeat(label: str, stop_event: threading.Event, interval: int = 30):
    """
    Background thread: prints a keep-alive line every `interval` seconds until
    stop_event is set.  Prevents Render/proxies from timing out during TCA.
    """
    start = time.time()
    while not stop_event.wait(interval):
        elapsed = int(time.time() - start)
        print(f"[run_hf] ♥ {label} still running … {elapsed}s elapsed",
              file=sys.stderr, flush=True)


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


# ─── DEM (Copernicus GLO-30 / GLO-90 via AWS open data) ─────────────────────
#
# Data source: ESA Copernicus DEM – publicly hosted on AWS S3 (no auth required)
#   GLO-30  https://copernicus-dem-30m.s3.amazonaws.com/  (1-arc-second / ~30 m)
#   GLO-90  https://copernicus-dem-90m.s3.amazonaws.com/  (3-arc-second / ~90 m)
#
# Tile naming convention:
#   GLO-30: Copernicus_DSM_COG_10_{NS}{lat:02d}_00_{EW}{lon:03d}_00_DEM/
#            └── Copernicus_DSM_COG_10_{NS}{lat:02d}_00_{EW}{lon:03d}_00_DEM.tif
#   GLO-90: same but prefix code = 30 and bucket = copernicus-dem-90m
#
# Strategy:
#   - 30m  → download GLO-30 tiles, mosaic, reproject to UTM, clip
#   - 90m  → download GLO-90 tiles, mosaic, reproject to UTM, clip
#   - 1km  → download GLO-90 tiles, mosaic, reproject to UTM, block-aggregate to 1000 m
#
# Fallback: if all tile downloads fail, generate a synthetic DEM so the rest of
# the pipeline can still run end-to-end.
#

DEM_SOURCE_GLO30 = "Copernicus GLO-30 DEM (ESA/AWS open data, ~30 m native)"
DEM_SOURCE_GLO90 = "Copernicus GLO-90 DEM (ESA/AWS open data, ~90 m native)"
DEM_SOURCE_SYNTH = "Synthetic DEM (Copernicus unavailable)"

_GLO30_BASE = "https://copernicus-dem-30m.s3.amazonaws.com"
_GLO90_BASE = "https://copernicus-dem-90m.s3.amazonaws.com"


def _cop_tile_url(lat_floor: int, lon_floor: int, glo90: bool = False) -> str:
    """
    Return the HTTP URL for the Copernicus DEM tile whose south-west corner
    is at (lat_floor, lon_floor).

    lat_floor : integer floor of latitude  (e.g. -1 for -0.5°)
    lon_floor : integer floor of longitude (e.g. 10  for 10.3°)
    glo90     : True → GLO-90 bucket / prefix-code 30; False → GLO-30 / code 10
    """
    ns  = "N" if lat_floor >= 0 else "S"
    ew  = "E" if lon_floor >= 0 else "W"
    abs_lat = abs(lat_floor)
    abs_lon = abs(lon_floor)
    code    = "30" if glo90 else "10"
    base    = _GLO90_BASE if glo90 else _GLO30_BASE
    dirname  = f"Copernicus_DSM_COG_{code}_{ns}{abs_lat:02d}_00_{ew}{abs_lon:03d}_00_DEM"
    filename = f"{dirname}.tif"
    return f"{base}/{dirname}/{filename}"


def _download_cop_tile(url: str, dest_path: str, timeout: int = 120) -> bool:
    """Download a tile to dest_path.  Returns True on success."""
    import tempfile
    tmp = dest_path + ".tmp"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "WaterFavorabilityExplorer/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp, open(tmp, "wb") as fh:
            fh.write(resp.read())
        os.replace(tmp, dest_path)
        return True
    except Exception as e:
        print(f"[run_hf] DEM tile download failed ({url}): {e}", file=sys.stderr)
        if os.path.exists(tmp):
            os.remove(tmp)
        return False


def _tiles_for_aoi(minLat: float, maxLat: float, minLon: float, maxLon: float):
    """
    Return a list of (lat_floor, lon_floor) integer pairs covering the AOI.
    Copernicus tiles are 1°×1° with the south-west corner at integer degrees.
    """
    tiles = []
    lat = math.floor(minLat)
    while lat < maxLat:
        lon = math.floor(minLon)
        while lon < maxLon:
            tiles.append((lat, lon))
            lon += 1
        lat += 1
    return tiles


def fetch_dem(
    aoi: dict,
    res_m: int,
    utm_crs,
    grid_transform,
    ncols: int,
    nrows: int,
    out_path: str,
) -> tuple:
    """
    Fetch a real Copernicus DEM (GLO-30 / GLO-90) for the AOI, reproject to
    the UTM master grid, and write a GeoTIFF.

    Returns (dem_array, source_label, native_res_m, resampling_method).
    """
    import tempfile
    from rasterio.merge import merge as rio_merge

    minLat = float(aoi.get("minLat", 0))
    maxLat = float(aoi.get("maxLat", 1))
    minLon = float(aoi.get("minLon", 0))
    maxLon = float(aoi.get("maxLon", 1))

    # Choose source bucket based on requested resolution
    # 30m  → GLO-30  (native ~30 m)  direct resample
    # 90m  → GLO-90  (native ~90 m)  direct resample
    # 1km  → GLO-90  (native ~90 m)  aggregate to 1000 m
    use_glo90  = res_m >= 90
    source_label  = DEM_SOURCE_GLO90 if use_glo90 else DEM_SOURCE_GLO30
    native_res_m  = 90 if use_glo90 else 30
    resamp_method = "block_aggregate" if res_m == 1000 else ("3x3_mean" if res_m == 90 else "bilinear")

    tiles = _tiles_for_aoi(minLat, maxLat, minLon, maxLon)
    print(f"[run_hf] DEM: {len(tiles)} tile(s) needed for AOI "
          f"[{minLat},{maxLat},{minLon},{maxLon}] using {'GLO-90' if use_glo90 else 'GLO-30'}",
          file=sys.stderr)

    dem_array = None  # will be set on success

    with tempfile.TemporaryDirectory() as tmpdir:
        tile_paths = []
        for (lat_f, lon_f) in tiles:
            url    = _cop_tile_url(lat_f, lon_f, glo90=use_glo90)
            fname  = os.path.basename(url)
            dest   = os.path.join(tmpdir, fname)
            if _download_cop_tile(url, dest):
                tile_paths.append(dest)
            else:
                print(f"[run_hf] DEM: missing tile ({lat_f},{lon_f}), skipping",
                      file=sys.stderr)

        if not tile_paths:
            print("[run_hf] DEM: no tiles downloaded – falling back to synthetic DEM",
                  file=sys.stderr)
            return _synthetic_dem(utm_crs, grid_transform, ncols, nrows, out_path)

        # ── Mosaic downloaded tiles ──────────────────────────────────────────
        print(f"[run_hf] DEM: mosaicking {len(tile_paths)} tile(s)…", file=sys.stderr)
        src_files = [rasterio.open(p) for p in tile_paths]
        try:
            mosaic, mosaic_transform = rio_merge(src_files)
            mosaic_crs = src_files[0].crs
        finally:
            for f in src_files:
                f.close()

        mosaic = mosaic[0].astype(np.float32)  # band 1
        # Replace common nodata values with nan
        nodata_val = -32768.0
        mosaic = np.where(
            (mosaic <= nodata_val) | ~np.isfinite(mosaic), np.nan, mosaic
        )

        # ── Reproject + resample to UTM grid ────────────────────────────────
        # Choose Resampling method:
        #   30m  → bilinear (downscale from ~30 m native)
        #   90m  → average (3×3 mean)
        #   1km  → average (block aggregate, ~11×11 native pixels)
        if res_m == 30:
            rsc = Resampling.bilinear
        else:
            rsc = Resampling.average

        dem_utm = np.full((nrows, ncols), np.nan, dtype=np.float32)
        reproject(
            source=mosaic,
            destination=dem_utm,
            src_transform=mosaic_transform,
            src_crs=mosaic_crs,
            dst_transform=grid_transform,
            dst_crs=utm_crs,
            src_nodata=np.nan,
            dst_nodata=np.nan,
            resampling=rsc,
        )

        # Fill any remaining nan pixels (off-edge) with interpolated values
        # so pysheds doesn't choke on nodata at boundary
        from scipy.ndimage import generic_filter
        def _nanfill(arr):
            if np.isnan(arr[4]):
                v = arr[~np.isnan(arr)]
                return float(v.mean()) if v.size else 0.0
            return arr[4]
        nan_mask = ~np.isfinite(dem_utm)
        if nan_mask.any():
            filled = generic_filter(dem_utm, _nanfill, size=3, mode="nearest")
            dem_utm = np.where(nan_mask, filled, dem_utm).astype(np.float32)

        dem_array = dem_utm

    # ── Write GeoTIFF ────────────────────────────────────────────────────────
    profile = {
        "driver": "GTiff", "dtype": "float32",
        "width": ncols, "height": nrows, "count": 1,
        "crs": utm_crs, "transform": grid_transform,
        "nodata": -9999.0, "compress": "lzw",
    }
    # Replace nan → nodata before writing
    write_arr = np.where(np.isfinite(dem_array), dem_array, -9999.0).astype(np.float32)
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(write_arr, 1)

    valid_px = np.isfinite(dem_array)
    elev_min = float(dem_array[valid_px].min()) if valid_px.any() else 0
    elev_max = float(dem_array[valid_px].max()) if valid_px.any() else 0
    print(
        f"[run_hf] DEM written: {nrows}×{ncols} px "
        f"elev [{elev_min:.0f}–{elev_max:.0f} m] → {out_path}",
        file=sys.stderr,
    )
    return dem_array, source_label, native_res_m, resamp_method


def _synthetic_dem(utm_crs, grid_transform, ncols, nrows, out_path: str):
    """Fallback: deterministic sinusoidal DEM when real tiles are unavailable."""
    print("[run_hf] DEM: generating synthetic DEM (real tiles unavailable)", file=sys.stderr)
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
    print(f"[run_hf] Synthetic DEM written: {nrows}×{ncols} px → {out_path}", file=sys.stderr)
    return data, DEM_SOURCE_SYNTH, 0, "synthetic"


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


# ─── Soil permeability (iSDA real data / no-fallback) ────────────────────────────

# iSDA Soil texture class names → permeability 0–1
# Based on standard hydrogeologic ranges (coarse = high perm, clay = low perm).
# Matching is case-insensitive and checks if the key is *contained in* the class string.
ISDA_TEXTURE_PERM_LUT = {
    "sand":        1.0,   # Sand / Loamy Sand
    "loamy sand":  1.0,
    "sandy loam":  0.7,   # Sandy Loam / Loam
    "loam":        0.7,
    "silt loam":   0.5,   # Silt Loam
    "silt":        0.5,   # Silt
    "clay loam":   0.3,   # Clay Loam / Sandy Clay
    "sandy clay":  0.3,
    "silty clay":  0.2,
    "clay":        0.1,   # Clay / Heavy Clay
}
ISDA_DEFAULT_PERM = 0.5   # fallback for unrecognised class names

# iSDA integer class codes used in the iSDA texture_class_l (0–12)
# Codes from iSDA-Africa soil grids documentation
ISDA_CODE_PERM_LUT = {
    0:  0.50,   # No data / water
    1:  1.00,   # Sand
    2:  1.00,   # Loamy Sand
    3:  0.70,   # Sandy Loam
    4:  0.70,   # Loam
    5:  0.50,   # Silt Loam
    6:  0.50,   # Silt
    7:  0.30,   # Clay Loam
    8:  0.30,   # Sandy Clay Loam
    9:  0.20,   # Silty Clay Loam
    10: 0.20,   # Sandy Clay
    11: 0.10,   # Silty Clay
    12: 0.10,   # Clay
}

# iSDA soil texture class raster – accessed via GDAL /vsicurl/ virtual file system
# so no local download is needed.  The raster is served from an open S3 bucket by
# iSDA / Rothamsted Research (https://www.isda-africa.com/isdasoil/).
# Variable: texture_class (USDA classes, 0 cm depth).
# Full coverage: sub-Saharan Africa (approx. -35–15°N, -20–55°E).
ISDA_VSICURL_URL = (
    "/vsicurl/https://s3.amazonaws.com/isda-soils/"
    "continental_africa/10km/texture_class/texture_class_0_20.tif"
)
# Authoritative mirror (alternate path tried if primary fails):
ISDA_VSICURL_ALT = (
    "/vsicurl/https://storage.googleapis.com/fao-iacs-hq/"
    "isdasoil/v1/texture_class_0_20.tif"
)

ISDA_COVERAGE_BBOX = (-35.0, 55.0, -20.0, 55.0)  # (minLat, maxLat, minLon, maxLon)


def _aoi_within_isda_coverage(minLat, maxLat, minLon, maxLon) -> bool:
    """Return True if the AOI centre falls within the iSDA Africa coverage."""
    cLat = (minLat + maxLat) / 2
    cLon = (minLon + maxLon) / 2
    return -35.0 <= cLat <= 37.5 and -20.0 <= cLon <= 55.0


def _perm_from_code(code_val: int) -> float:
    return ISDA_CODE_PERM_LUT.get(int(code_val), ISDA_DEFAULT_PERM)


def load_or_synthesise_soil_perm(
    aoi, utm_crs, grid_transform, ncols, nrows, out_path, config_paths
) -> np.ndarray:
    """
    Load real soil permeability from iSDA Soils texture class raster via /vsicurl/,
    reprojects and resamples to the HF master grid.

    Robustness additions vs. the naive reproject():
      - Explicitly transforms the AOI bbox into the soil source CRS before doing
        any overlap test, avoiding a silent empty-array IndexError.
      - Checks that the AOI actually intersects the source raster extent.
        Raises a clear "AOI is outside of soil data bounds" error if not.
      - Works with any single tiled or multi-tile raster: rasterio.open() handles
        both, and the warp reads only the window that covers the AOI.

    Data source priority:
      1. Explicit path in data_sources.json  (local file or /vsicurl/ path)
      2. iSDA /vsicurl/ primary URL
      3. iSDA /vsicurl/ alternate URL
      4. RAISE RuntimeError if AOI is within Africa and all sources failed.
         For AOIs outside Africa, writes a uniform 0.5 placeholder so the run
         can complete (TCA + geology carry most weight).
    """
    from pyproj import Transformer as _Transformer
    from rasterio.crs import CRS as _CRS

    minLat = float(aoi.get("minLat", 0))
    maxLat = float(aoi.get("maxLat", 1))
    minLon = float(aoi.get("minLon", 0))
    maxLon = float(aoi.get("maxLon", 1))

    # Candidate sources in priority order
    configured_path = (config_paths.get("soil") or "").strip()
    candidates: list[tuple[str, str]] = []
    if configured_path:
        candidates.append((configured_path, "configured path"))
    if _aoi_within_isda_coverage(minLat, maxLat, minLon, maxLon):
        candidates.append((ISDA_VSICURL_URL, "iSDA /vsicurl/ primary"))
        candidates.append((ISDA_VSICURL_ALT, "iSDA /vsicurl/ alternate"))

    perm       = None
    last_error = None

    for src_path, label in candidates:
        print(f"[run_hf] Soil: trying {label}: {src_path}", file=sys.stderr)
        try:
            with rasterio.open(src_path) as src:
                src_crs = src.crs

                # ── Coordinate alignment: transform AOI bbox into the source CRS ────────
                geo_crs = _CRS.from_epsg(4326)
                if src_crs != geo_crs:
                    t = _Transformer.from_crs(geo_crs, src_crs, always_xy=True)
                    xs, ys = t.transform(
                        [minLon, maxLon, minLon, maxLon],
                        [minLat, minLat, maxLat, maxLat],
                    )
                    aoi_left, aoi_right = min(xs), max(xs)
                    aoi_bottom, aoi_top = min(ys), max(ys)
                else:
                    aoi_left, aoi_right   = minLon, maxLon
                    aoi_bottom, aoi_top   = minLat, maxLat

                # ── Overlap check: does the AOI intersect the raster extent? ─────────
                src_left, src_bottom, src_right, src_top = src.bounds
                no_overlap = (
                    aoi_right  <= src_left  or
                    aoi_left   >= src_right or
                    aoi_top    <= src_bottom or
                    aoi_bottom >= src_top
                )
                if no_overlap:
                    raise ValueError(
                        f"AOI is outside of soil data bounds "
                        f"(AOI [{aoi_left:.2f},{aoi_bottom:.2f} → "
                        f"{aoi_right:.2f},{aoi_top:.2f}] vs "
                        f"source [{src_left:.2f},{src_bottom:.2f} → "
                        f"{src_right:.2f},{src_top:.2f}])"
                    )

                # ── Warp directly into the master grid ──────────────────────────────
                raw = np.zeros((nrows, ncols), dtype=np.float32)
                reproject(
                    source=rasterio.band(src, 1),
                    destination=raw,
                    src_transform=src.transform,
                    src_crs=src_crs,
                    dst_transform=grid_transform,
                    dst_crs=utm_crs,
                    resampling=Resampling.nearest,
                )

            # Sanity check: reproject() should leave at least some non-zero pixels
            unique_codes = sorted(set(raw.astype(int).flat))[:10]
            if len(unique_codes) <= 1 and unique_codes[0] == 0:
                raise ValueError(
                    "AOI is outside of soil data bounds: reprojection produced an all-zero array"
                )

            perm = np.vectorize(_perm_from_code)(raw.astype(np.int32)).astype(np.float32)
            print(
                f"[run_hf] Soil: loaded real iSDA data from {label} "
                f"(unique codes: {unique_codes})",
                file=sys.stderr,
            )
            break

        except Exception as e:
            last_error = e
            print(f"[run_hf] Soil: {label} failed – {e}", file=sys.stderr)

    if perm is None:
        if not _aoi_within_isda_coverage(minLat, maxLat, minLon, maxLon):
            print(
                "[run_hf] Soil: AOI outside iSDA Africa coverage – "
                "using uniform placeholder (0.5). "
                "Set data_sources.json \"soil\": to a /vsicurl/ path for a global soil dataset.",
                file=sys.stderr,
            )
            perm = np.full((nrows, ncols), 0.5, dtype=np.float32)
        else:
            raise RuntimeError(
                f"Soil: all iSDA sources failed and synthetic fallback is disabled. "
                f"Last error: {last_error}"
            )

    # Min–max normalise over valid pixels
    valid = np.isfinite(perm) & (perm != -9999)
    if valid.any():
        mn, mx = perm[valid].min(), perm[valid].max()
        if mx > mn:
            perm = np.where(valid, (perm - mn) / (mx - mn), np.nan).astype(np.float32)
        else:
            # All same texture class – just use the raw perm value (already 0–1)
            perm = perm.copy()
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
    Large grids (> MAX_TCA_PIXELS) are automatically decimated before flow
    accumulation and upsampled back to the full grid afterward.
    """
    from scipy.ndimage import zoom as ndimage_zoom
    import tempfile

    tca_raw_path  = os.path.join(out_dir, f"{code}_HF_tca_raw.tif")
    tca_norm_path = os.path.join(out_dir, f"{code}_HF_tca_norm.tif")
    tca_rrz_path  = os.path.join(out_dir, f"{code}_HF_tca_rrz.tif")
    tca_nrz_path  = os.path.join(out_dir, f"{code}_HF_tca_nrz.tif")

    # ── Decimation for large grids ────────────────────────────────────────────
    pixel_count = ncols * nrows
    decimated   = False
    tca_dem     = dem  # working copy; may be replaced by decimated version
    tca_cols    = ncols
    tca_rows    = nrows
    tca_transform = grid_transform

    if pixel_count > MAX_TCA_PIXELS:
        scale = (MAX_TCA_PIXELS / pixel_count) ** 0.5
        tca_cols  = max(2, int(ncols * scale))
        tca_rows  = max(2, int(nrows * scale))
        row_scale = tca_rows / nrows
        col_scale = tca_cols / ncols
        print(
            f"[run_hf] TCA: grid {ncols}x{nrows} ({pixel_count:,} px) exceeds "
            f"{MAX_TCA_PIXELS:,}; decimating to {tca_cols}x{tca_rows} "
            f"(scale={scale:.3f})",
            file=sys.stderr,
        )
        tca_dem = ndimage_zoom(dem.astype(np.float64), (row_scale, col_scale), order=1).astype(np.float32)
        tca_transform = rasterio.transform.from_bounds(
            grid_transform.c,
            grid_transform.f + grid_transform.e * nrows,
            grid_transform.c + grid_transform.a * ncols,
            grid_transform.f,
            tca_cols, tca_rows,
        )
        decimated = True
        gc.collect()

    # Helper: write a tif at the WORKING (possibly decimated) resolution
    def _write_tif_working(data, path, dtype="float32", nodata=None):
        profile = {
            "driver": "GTiff", "dtype": dtype,
            "width": tca_cols, "height": tca_rows, "count": 1,
            "crs": utm_crs, "transform": tca_transform,
            "nodata": nodata if nodata is not None else float("nan"), "compress": "lzw",
        }
        with rasterio.open(path, "w", **profile) as dst:
            dst.write(data.astype(dtype), 1)

    # Helper: write a tif at the FULL grid resolution
    def _write_tif_full(data, path, dtype="float32", nodata=None):
        profile = {
            "driver": "GTiff", "dtype": dtype,
            "width": ncols, "height": nrows, "count": 1,
            "crs": utm_crs, "transform": grid_transform,
            "nodata": nodata if nodata is not None else float("nan"), "compress": "lzw",
        }
        with rasterio.open(path, "w", **profile) as dst:
            dst.write(data.astype(dtype), 1)

    tca_raw_work = None  # result at working resolution

    # ── Heartbeat thread (keeps Render connection alive during long calculation)
    stop_hb = threading.Event()
    hb_thread = threading.Thread(
        target=_heartbeat, args=("TCA flow accumulation", stop_hb, 30), daemon=True
    )
    hb_thread.start()

    try:
        # ── Try pysheds ──────────────────────────────────────────────────────
        try:
            from pysheds.grid import Grid

            print("[run_hf] TCA: using pysheds D8 flow accumulation", file=sys.stderr)

            with tempfile.TemporaryDirectory() as tmpdir:
                dem_path_tmp = os.path.join(tmpdir, "dem.tif")
                _write_tif_working(tca_dem, dem_path_tmp)
                grid = Grid.from_raster(dem_path_tmp)
                dem_data   = grid.read_raster(dem_path_tmp)
                pit_filled = grid.fill_pits(dem_data)
                del dem_data
                gc.collect()
                flooded  = grid.fill_depressions(pit_filled)
                del pit_filled
                gc.collect()
                inflated = grid.resolve_flats(flooded)
                del flooded
                gc.collect()
                fdir     = grid.flowdir(inflated)
                del inflated
                gc.collect()
                acc = grid.accumulation(fdir).astype(np.float32)
                del fdir
                gc.collect()
                tca_raw_work = acc

        except ImportError:
            print("[run_hf] TCA: pysheds not found, trying whitebox", file=sys.stderr)

        # ── Try whitebox ──────────────────────────────────────────────────────
        if tca_raw_work is None:
            try:
                import whitebox

                print("[run_hf] TCA: using WhiteboxTools", file=sys.stderr)
                wbt = whitebox.WhiteboxTools()
                wbt.verbose = False

                with tempfile.TemporaryDirectory() as tmpdir:
                    dem_in   = os.path.join(tmpdir, "dem.tif")
                    filled   = os.path.join(tmpdir, "filled.tif")
                    fdir_out = os.path.join(tmpdir, "fdir.tif")
                    acc_out  = os.path.join(tmpdir, "acc.tif")
                    _write_tif_working(tca_dem, dem_in)
                    wbt.fill_depressions(dem_in, filled)
                    wbt.d8_pointer(filled, fdir_out)
                    wbt.d8_flow_accumulation(fdir_out, acc_out, out_type="cells")
                    with rasterio.open(acc_out) as src:
                        tca_raw_work = src.read(1).astype(np.float32)

            except ImportError:
                print("[run_hf] TCA: whitebox not found, using synthetic TCA", file=sys.stderr)

        # ── Synthetic TCA fallback ────────────────────────────────────────────
        if tca_raw_work is None:
            print(
                "[run_hf] TCA: generating synthetic flow accumulation from DEM gradient",
                file=sys.stderr,
            )
            from scipy.ndimage import gaussian_filter
            smoothed  = gaussian_filter(tca_dem.astype(np.float64), sigma=2)
            dy, dx    = np.gradient(smoothed)
            del smoothed
            slope_mag = np.sqrt(dx**2 + dy**2) + 1e-6
            del dx, dy
            inverted  = 1.0 / slope_mag
            del slope_mag
            cumulative = np.cumsum(np.cumsum(inverted, axis=0), axis=1)
            del inverted
            tca_raw_work = (cumulative / cumulative.max() * 1e6).astype(np.float32)
            del cumulative
            gc.collect()

    finally:
        stop_hb.set()

    # Free decimated DEM
    del tca_dem
    gc.collect()

    # ── Upsample back to full grid if we decimated ────────────────────────────
    if decimated:
        print(
            f"[run_hf] TCA: upsampling result from {tca_cols}x{tca_rows} "
            f"back to {ncols}x{nrows}",
            file=sys.stderr,
        )
        row_up = nrows / tca_rows
        col_up = ncols / tca_cols
        tca_raw = ndimage_zoom(tca_raw_work.astype(np.float64), (row_up, col_up), order=1).astype(np.float32)
        del tca_raw_work
        gc.collect()
    else:
        tca_raw = tca_raw_work
        del tca_raw_work

    _write_tif_full(tca_raw, tca_raw_path)
    print(f"[run_hf] TCA raw written → {tca_raw_path}", file=sys.stderr)

    # ── Log-normalise TCA 0–1 ─────────────────────────────────────────────────
    valid_mask = np.isfinite(tca_raw) & (tca_raw >= 0)
    tca_log    = np.where(valid_mask, np.log10(tca_raw + 1), np.nan).astype(np.float64)
    valid_log  = np.isfinite(tca_log)
    if valid_log.any():
        mn = tca_log[valid_log].min()
        mx = tca_log[valid_log].max()
        if mx > mn:
            tca_norm = np.where(valid_log, (tca_log - mn) / (mx - mn), np.nan).astype(np.float32)
        else:
            tca_norm = np.where(valid_log, 0.5, np.nan).astype(np.float32)
    else:
        tca_norm = np.full((nrows, ncols), np.nan, dtype=np.float32)
    del tca_log, valid_log
    gc.collect()

    _write_tif_full(tca_norm, tca_norm_path)
    print(f"[run_hf] TCA normalised written → {tca_norm_path}", file=sys.stderr)

    # ── RRZ / NRZ bands ───────────────────────────────────────────────────────
    valid_vals = tca_raw[np.isfinite(tca_raw) & (tca_raw >= 0)]
    if valid_vals.size > 0:
        p60 = float(np.percentile(valid_vals, 60))
        p80 = float(np.percentile(valid_vals, 80))
    else:
        p60, p80 = 0.0, 0.0
    del valid_vals

    rrz = np.where((tca_raw >= p80) & np.isfinite(tca_raw), 1.0, np.nan).astype(np.float32)
    _write_tif_full(rrz, tca_rrz_path, nodata=float("nan"))
    del rrz
    print(f"[run_hf] TCA RRZ written (P80={p80:.1f}) → {tca_rrz_path}", file=sys.stderr)

    nrz = np.where(
        (tca_raw >= p60) & (tca_raw < p80) & np.isfinite(tca_raw), 1.0, np.nan
    ).astype(np.float32)
    _write_tif_full(nrz, tca_nrz_path, nodata=float("nan"))
    del nrz
    print(f"[run_hf] TCA NRZ written (P60={p60:.1f}) → {tca_nrz_path}", file=sys.stderr)

    gc.collect()
    return tca_raw, tca_norm, p60, p80


# ─── HF calculation ──────────────────────────────────────────────────────────

def compute_hf(geology_norm, soil_norm, tca_norm, weights, grid_transform, utm_crs, ncols, nrows, out_path):
    """
    HF = (w_geo * G_norm + w_soil * S_norm + w_tca * TCA_norm) / Σw
    Only valid where all *active* (weight > 0) inputs are finite.
    Division-by-zero guard: raises ValueError if all weights are 0.
    """
    w_geo  = float(weights.get("geology", 1.0))
    w_soil = float(weights.get("soil",    1.0))
    w_tca  = float(weights.get("tca",     1.0))
    w_sum  = w_geo + w_soil + w_tca

    if w_sum <= 0.0:
        raise ValueError(
            "All layer weights are 0 – at least one layer must be enabled to compute HF."
        )

    # Build the valid mask: only require finite values for layers that are active
    valid = np.ones((nrows, ncols), dtype=bool)
    if w_geo  > 0: valid &= np.isfinite(geology_norm)
    if w_soil > 0: valid &= np.isfinite(soil_norm)
    if w_tca  > 0: valid &= np.isfinite(tca_norm)

    hf = np.full((nrows, ncols), np.nan, dtype=np.float64)
    term = np.zeros((nrows, ncols), dtype=np.float64)
    if w_geo  > 0: term[valid] += w_geo  * geology_norm[valid].astype(np.float64)
    if w_soil > 0: term[valid] += w_soil * soil_norm[valid].astype(np.float64)
    if w_tca  > 0: term[valid] += w_tca  * tca_norm[valid].astype(np.float64)
    hf[valid] = term[valid] / w_sum
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
    # ── 0. CLI flags ─────────────────────────────────────────────────────────
    parser = argparse.ArgumentParser(description="Water Favorability pipeline")
    parser.add_argument("--dry-run", action="store_true",
                        help="Create empty placeholder .tif files and exit OK (no real computation)")
    args, _ = parser.parse_known_args()   # ignore unknown args (e.g. from Render)

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

    project_name     = cfg.get("projectName", "HF Project")
    code             = cfg.get("projectCode", "HF").upper()
    aoi              = cfg.get("aoi", {})
    resolution       = cfg.get("resolution", "90m")
    weights          = cfg.get("weights", {"geology": 1.0, "soil": 1.0, "tca": 1.0})
    outputs_dir      = cfg.get("outputsDir", os.path.join(os.getcwd(), "data", "outputs"))
    # utmCrs override from API (e.g. "EPSG:32637") – keeps Python in sync with server response
    utm_crs_override = cfg.get("utmCrs", None)  # optional; falls back to computed value if absent

    res_m = RES_M.get(resolution, 90)

    # ── DRY-RUN: write zero-filled placeholders and exit immediately ───────────
    if args.dry_run:
        print("[run_hf] --dry-run active: skipping all real computation", file=sys.stderr)
        out_dir = os.path.join(outputs_dir, code)
        os.makedirs(out_dir, exist_ok=True)

        # Minimal grid so rasterio is happy
        _ncols, _nrows = 4, 4
        _transform = rasterio.transform.from_bounds(0, 0, 1, 1, _ncols, _nrows)
        _crs = CRS.from_epsg(32637)  # arbitrary – just for placeholder validity
        _profile = {
            "driver": "GTiff", "dtype": "float32",
            "width": _ncols, "height": _nrows, "count": 1,
            "crs": _crs, "transform": _transform,
            "nodata": float("nan"), "compress": "lzw",
        }
        _placeholder_layers = [
            f"{code}_HF_dem.tif",
            f"{code}_HF_geologyPerm.tif",
            f"{code}_HF_soilPerm.tif",
            f"{code}_HF_tca_raw.tif",
            f"{code}_HF_tca_norm.tif",
            f"{code}_HF_tca_rrz.tif",
            f"{code}_HF_tca_nrz.tif",
            f"{code}_HF_hydroFavor.tif",
        ]
        for _fname in _placeholder_layers:
            _fpath = os.path.join(out_dir, _fname)
            print(f"[run_hf] dry-run: writing placeholder {_fname}", file=sys.stderr)
            with rasterio.open(_fpath, "w", **_profile) as _dst:
                _dst.write(np.zeros((_nrows, _ncols), dtype=np.float32), 1)

        # Weights CSV
        _csv = os.path.join(out_dir, f"{code}_HF_weights_matrix.csv")
        with open(_csv, "w") as _f:
            _f.write("layer,weight\n")
            for _k in ("geology", "soil", "tca"):
                _f.write(f"{_k},{weights.get(_k, 1.0)}\n")
        print(f"[run_hf] dry-run: weights matrix written", file=sys.stderr)

        # Metadata JSON
        _meta = {
            "projectName": project_name, "projectCode": code,
            "dryRun": True, "createdAt": datetime.utcnow().isoformat() + "Z",
            "aoi": aoi, "resolution": resolution,
        }
        _meta_path = os.path.join(out_dir, f"{code}_HF_metadata.json")
        with open(_meta_path, "w") as _f:
            json.dump(_meta, _f, indent=2)
        print(f"[run_hf] dry-run: metadata JSON written", file=sys.stderr)

        # ZIP
        _zip_name = f"{code}_HF_outputs_{resolution}.zip"
        _zip_path = os.path.join(outputs_dir, _zip_name)
        with zipfile.ZipFile(_zip_path, "w", zipfile.ZIP_DEFLATED) as _zf:
            for _fname in _placeholder_layers + [
                f"{code}_HF_weights_matrix.csv",
                f"{code}_HF_metadata.json",
            ]:
                _fp = os.path.join(out_dir, _fname)
                if os.path.isfile(_fp):
                    _zf.write(_fp, _fname)
        print(f"[run_hf] dry-run: zip written -> {_zip_path}", file=sys.stderr)
        print(f"OK:{code}:{resolution}:{_zip_path}", flush=True)
        sys.exit(0)
    # ── END DRY-RUN ────────────────────────────────────────────────────────────

    minLat = float(aoi.get("minLat", 0))
    maxLat = float(aoi.get("maxLat", 1))
    minLon = float(aoi.get("minLon", 0))
    maxLon = float(aoi.get("maxLon", 1))

    print(f"[run_hf] Starting HF v1: project={code} resolution={resolution} "
          f"aoi=[{minLat},{maxLat},{minLon},{maxLon}]", file=sys.stderr)

    # ── 2. Create per-project output directory ───────────────────────────────
    # Ensure both root outputs dir and per-project subdir exist
    # (guards against FileNotFoundError on a fresh Render disk)
    os.makedirs(outputs_dir, exist_ok=True)
    out_dir = os.path.join(outputs_dir, code)
    os.makedirs(out_dir, exist_ok=True)
    os.chmod(out_dir, 0o755)  # ensure write permissions

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
    # Prefer the UTM CRS passed from the API (already computed server-side)
    # so Python uses the exact same zone as the JSON response. Fall back to
    # computing it locally if the override is absent or unparseable.
    if utm_crs_override:
        try:
            utm_crs   = CRS.from_user_input(utm_crs_override)
            epsg_code = int(utm_crs_override.upper().replace("EPSG:", ""))
            print(f"[run_hf] UTM CRS override accepted: {utm_crs_override}", file=sys.stderr)
        except Exception as _e:
            print(f"[run_hf] UTM CRS override '{utm_crs_override}' unrecognised, computing from AOI: {_e}", file=sys.stderr)
            epsg_code = utm_epsg(centre_lat, centre_lon)
            utm_crs   = CRS.from_epsg(epsg_code)
    else:
        epsg_code = utm_epsg(centre_lat, centre_lon)
        utm_crs   = CRS.from_epsg(epsg_code)

    min_x, max_x, min_y, max_y = bbox_to_utm(minLat, maxLat, minLon, maxLon, epsg_code)
    grid_transform, ncols, nrows = make_grid(min_x, max_x, min_y, max_y, res_m)

    pixel_count = ncols * nrows
    output_size_bytes = pixel_count * 4 * 8
    output_size_mb    = round(output_size_bytes / (1024 * 1024), 1)

    print(f"[run_hf] UTM CRS: EPSG:{epsg_code}, grid: {ncols}×{nrows} = {pixel_count:,} px, "
          f"~{output_size_mb} MB", file=sys.stderr)

    # ── 5. DEM ───────────────────────────────────────────────────────────────
    dem_path = os.path.join(out_dir, f"{code}_HF_dem.tif")
    dem_result = fetch_dem(aoi, res_m, utm_crs, grid_transform, ncols, nrows, dem_path)
    dem, dem_source_label, dem_native_res_m, dem_resamp_method = dem_result

    w_geo_v  = float(weights.get("geology", 1.0))
    w_soil_v = float(weights.get("soil",    1.0))
    w_tca_v  = float(weights.get("tca",     1.0))

    if w_geo_v + w_soil_v + w_tca_v <= 0.0:
        print("ERROR:All layer weights are 0 – enable at least one layer.", flush=True)
        sys.exit(1)

    # ── 6. Geology permeability (from Macrostrat) ─────────────────────────────
    geo_out = os.path.join(out_dir, f"{code}_HF_geologyPerm.tif")
    if w_geo_v > 0:
        geology_norm, geology_source_label, geology_used_real = build_geology_perm_raster(
            minLat, maxLat, minLon, maxLon,
            utm_crs, grid_transform, ncols, nrows, geo_out
        )
    else:
        print("[run_hf] Step 6: Geology weight = 0, skipping", file=sys.stderr)
        geology_norm         = np.zeros((nrows, ncols), dtype=np.float32)
        geology_source_label = "skipped (weight=0)"
        geology_used_real    = False
        _skip_profile = {
            "driver": "GTiff", "dtype": "float32", "width": ncols, "height": nrows, "count": 1,
            "crs": utm_crs, "transform": grid_transform, "nodata": float("nan"), "compress": "lzw",
        }
        with rasterio.open(geo_out, "w", **_skip_profile) as _dst:
            _dst.write(geology_norm, 1)

    # ── 7. Soil permeability ──────────────────────────────────────────────────
    soil_out = os.path.join(out_dir, f"{code}_HF_soilPerm.tif")
    if w_soil_v > 0:
        soil_norm = load_or_synthesise_soil_perm(
            aoi, utm_crs, grid_transform, ncols, nrows, soil_out, data_sources
        )
    else:
        print("[run_hf] Step 7: Soil weight = 0, skipping", file=sys.stderr)
        soil_norm = np.zeros((nrows, ncols), dtype=np.float32)
        _skip_profile = {
            "driver": "GTiff", "dtype": "float32", "width": ncols, "height": nrows, "count": 1,
            "crs": utm_crs, "transform": grid_transform, "nodata": float("nan"), "compress": "lzw",
        }
        with rasterio.open(soil_out, "w", **_skip_profile) as _dst:
            _dst.write(soil_norm, 1)

    # Free intermediate arrays before the memory-intensive TCA step
    gc.collect()
    print("[run_hf] Memory freed before TCA (gc.collect)", file=sys.stderr)

    # ── 8. TCA, RRZ, NRZ ────────────────────────────────────────────────────
    if w_tca_v > 0:
        tca_raw, tca_norm, p60, p80 = run_tca_pipeline(
            dem, grid_transform, utm_crs, ncols, nrows, out_dir, code
        )
    else:
        print("[run_hf] Step 8: TCA weight = 0, skipping", file=sys.stderr)
        tca_norm = np.zeros((nrows, ncols), dtype=np.float32)
        tca_raw  = tca_norm.copy()
        p60, p80 = 0.0, 0.0
        _tca_profile = {
            "driver": "GTiff", "dtype": "float32", "width": ncols, "height": nrows, "count": 1,
            "crs": utm_crs, "transform": grid_transform, "nodata": float("nan"), "compress": "lzw",
        }
        for _tca_fname in [
            f"{code}_HF_tca_raw.tif", f"{code}_HF_tca_norm.tif",
            f"{code}_HF_tca_rrz.tif", f"{code}_HF_tca_nrz.tif",
        ]:
            with rasterio.open(os.path.join(out_dir, _tca_fname), "w", **_tca_profile) as _dst:
                _dst.write(tca_norm, 1)

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
        "demSource": {
            "name":            dem_source_label,
            "gloBucket":       "copernicus-dem-30m / copernicus-dem-90m (AWS open data)",
            "nativeResM":      dem_native_res_m,
            "finalResM":       res_m,
            "finalCrs":        f"EPSG:{epsg_code}",
            "resamplingMethod": dem_resamp_method,
        },
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

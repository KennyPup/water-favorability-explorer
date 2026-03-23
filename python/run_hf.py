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
  projectCode  str (3-4 letters, upper)
  aoi          {type:"bbox", minLat, maxLat, minLon, maxLon}
  resolution   "30m" | "90m" | "1km"
  weights      {geology: float, soil: float, tca: float}
  outputsDir   str  (absolute path for outputs)

Outputs (all written to outputsDir/PROJECTCODE/):
  PROJECTCODE_HF_dem.tif
  PROJECTCODE_HF_geologyPerm.tif
  PROJECTCODE_HF_soilPerm.tif
  PROJECTCODE_HF_tca_raw.tif
  PROJECTCODE_HF_tca_norm.tif
  PROJECTCODE_HF_tca_rrz.tif
  PROJECTCODE_HF_tca_nrz.tif
  PROJECTCODE_HF_hydroFavor.tif
  PROJECTCODE_HF_weights_matrix.csv
  PROJECTCODE_HF_metadata.json
  PROJECTCODE_HF_outputs_RES.zip  ← everything above, archived
"""

import sys
import os
import json
import math
import zipfile
import traceback
from pathlib import Path
from datetime import datetime

import numpy as np
import rasterio
from rasterio.transform import from_bounds
from rasterio.crs import CRS
from rasterio.warp import calculate_default_transform, reproject, Resampling
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
    Uses pyproj for the corner reprojection.
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
    Replace the `data` array below with real Copernicus tiles.
    """
    print("[run_hf] DEM: generating synthetic DEM (Copernicus stub)", file=sys.stderr)

    # Synthetic terrain: tilted plane + sinusoidal ridges – realistic enough for TCA
    x_idx = np.tile(np.arange(ncols), (nrows, 1)).astype(np.float32)
    y_idx = np.tile(np.arange(nrows)[:, np.newaxis], (1, ncols)).astype(np.float32)

    # Gentle northward slope + two sinusoidal ridges
    data = (
        500.0
        + 300.0 * (y_idx / nrows)                          # north-south slope
        + 80.0  * np.sin(2 * np.pi * x_idx / ncols * 4)   # E-W ridges
        + 40.0  * np.sin(2 * np.pi * y_idx / nrows * 6)   # N-S ridges
        + 10.0  * np.random.default_rng(42).random((nrows, ncols)).astype(np.float32)
    ).astype(np.float32)

    profile = {
        "driver": "GTiff",
        "dtype": "float32",
        "width": ncols,
        "height": nrows,
        "count": 1,
        "crs": utm_crs,
        "transform": grid_transform,
        "nodata": -9999.0,
        "compress": "lzw",
    }
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(data, 1)

    print(f"[run_hf] DEM written: {nrows}×{ncols} px → {out_path}", file=sys.stderr)
    return data


# ─── Geology and soil permeability ───────────────────────────────────────────

# Default permeability lookup tables.
# Keys match common lithological class codes from GLIM / WHYMAP.
# Values are relative permeability scores 0–1.
# Adjust mappings as needed when real geology rasters are integrated.
GEOLOGY_PERM_LUT = {
    # Unconsolidated sediments (high permeability)
    "su":  0.95,  # Unconsolidated sediments, coarse
    "ss":  0.85,  # Siliciclastic sedimentary rocks
    "py":  0.75,  # Pyroclastics
    # Carbonate / karst
    "cr":  0.80,  # Carbonate rocks
    "ev":  0.45,  # Evaporites (variable)
    # Crystalline / metamorphic (low primary porosity)
    "mt":  0.20,  # Metamorphic rocks
    "pa":  0.15,  # Acid plutonic rocks
    "pb":  0.20,  # Basic plutonic rocks
    "va":  0.35,  # Acid volcanic rocks
    "vb":  0.30,  # Basic volcanic rocks
    # Default fallback
    "default": 0.40,
}

SOIL_PERM_LUT = {
    # FAO/HWSD soil class codes → permeability 0–1
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
    # Default
    0:  0.50,
}


def load_or_synthesise_perm(
    kind: str,               # "geology" or "soil"
    aoi: dict,
    utm_crs,
    grid_transform,
    ncols: int,
    nrows: int,
    out_path: str,
    config_paths: dict,
) -> np.ndarray:
    """
    Load a real geology/soil raster from a configured path and reproject to
    the AOI UTM grid, OR generate a synthetic permeability surface if no
    real data is configured.

    REAL IMPLEMENTATION TODO:
    --------------------------
    1. Obtain global geology raster: GLIM (Hartmann & Moosdorf 2012) or
       AQUASTAT / WHYMAP hydrogeology.
    2. Obtain global soil raster: HWSD v1.2 or iSDA Africa.
    3. Store absolute paths in data/geology_config/data_sources.json.
    4. This function will reproject those rasters to UTM + AOI extent.
    5. Apply LUT class → permeability score.
    6. Min–max normalise over AOI (ignoring NoData).

    STUB (Phase 1):
    ---------------
    Synthesises spatially coherent permeability surfaces using seeded RNG
    so the HF equation has meaningful variation to work with.
    """
    src_path = config_paths.get(kind)
    if src_path and os.path.isfile(src_path):
        print(f"[run_hf] {kind}: loading real data from {src_path}", file=sys.stderr)
        # --- Real data path ---
        with rasterio.open(src_path) as src:
            dst_crs = utm_crs
            transform_out, width_out, height_out = calculate_default_transform(
                src.crs, dst_crs, src.width, src.height, *src.bounds
            )
            # Clip to AOI grid
            raw = np.zeros((nrows, ncols), dtype=np.float32)
            reproject(
                source=rasterio.band(src, 1),
                destination=raw,
                src_transform=src.transform,
                src_crs=src.crs,
                dst_transform=grid_transform,
                dst_crs=dst_crs,
                resampling=Resampling.nearest,
            )
        # Apply LUT if integer class raster
        lut = GEOLOGY_PERM_LUT if kind == "geology" else SOIL_PERM_LUT
        default_val = lut.get("default", lut.get(0, 0.5))
        if kind == "geology":
            # Assume string class codes stored as categories; adapt as needed
            perm = np.full_like(raw, default_val, dtype=np.float32)
        else:
            perm = np.vectorize(lambda v: lut.get(int(v), default_val))(raw).astype(np.float32)
    else:
        if src_path:
            print(f"[run_hf] {kind}: configured path not found ({src_path}), using synthetic", file=sys.stderr)
        else:
            print(f"[run_hf] {kind}: no data source configured, using synthetic", file=sys.stderr)

        # Synthetic: smooth random field with spatial coherence
        rng = np.random.default_rng(1 if kind == "geology" else 2)
        # Low-res noise, upsampled → spatially coherent patterns
        lo = rng.random((nrows // 8 + 1, ncols // 8 + 1)).astype(np.float32)
        from scipy.ndimage import zoom
        try:
            scale_r = nrows / lo.shape[0]
            scale_c = ncols / lo.shape[1]
            perm = zoom(lo, (scale_r, scale_c), order=1)[:nrows, :ncols].astype(np.float32)
        except Exception:
            perm = np.full((nrows, ncols), 0.5, dtype=np.float32)

    # Min–max normalise 0–1 over valid pixels
    valid = np.isfinite(perm) & (perm != -9999)
    if valid.any():
        mn, mx = perm[valid].min(), perm[valid].max()
        if mx > mn:
            perm = np.where(valid, (perm - mn) / (mx - mn), np.nan)
        else:
            perm = np.where(valid, 0.5, np.nan)
    else:
        perm = np.full((nrows, ncols), np.nan, dtype=np.float32)

    # Save
    profile = {
        "driver": "GTiff",
        "dtype": "float32",
        "width": ncols,
        "height": nrows,
        "count": 1,
        "crs": utm_crs,
        "transform": grid_transform,
        "nodata": float("nan"),
        "compress": "lzw",
    }
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(perm.astype(np.float32), 1)

    print(f"[run_hf] {kind} permeability written → {out_path}", file=sys.stderr)
    return perm.astype(np.float32)


# ─── TCA and RRZ/NRZ ─────────────────────────────────────────────────────────

def run_tca_pipeline(dem: np.ndarray, grid_transform, utm_crs, ncols, nrows, out_dir, code):
    """
    Compute flow accumulation (TCA) from the DEM using pysheds or whitebox.
    Falls back to a deterministic synthetic TCA if no library is available.

    PREFERRED LIBRARIES (install via requirements.txt):
      pysheds  – pure-Python D8 flow routing, easy to use
      whitebox – WhiteboxTools wrapper, more complete suite

    Returns:
      tca_raw  np.ndarray  (float32)
      tca_norm np.ndarray  (float32, log-normalised 0–1)
    """

    def _write_tif(data, path, dtype="float32", nodata=None):
        profile = {
            "driver": "GTiff",
            "dtype": dtype,
            "width": ncols,
            "height": nrows,
            "count": 1,
            "crs": utm_crs,
            "transform": grid_transform,
            "nodata": nodata if nodata is not None else float("nan"),
            "compress": "lzw",
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
        import tempfile, shutil

        print("[run_hf] TCA: using pysheds D8 flow accumulation", file=sys.stderr)

        with tempfile.TemporaryDirectory() as tmpdir:
            dem_path_tmp = os.path.join(tmpdir, "dem.tif")
            _write_tif(dem, dem_path_tmp)

            grid = Grid.from_raster(dem_path_tmp)
            dem_data = grid.read_raster(dem_path_tmp)

            # Condition DEM: fill pits then fill depressions
            pit_filled = grid.fill_pits(dem_data)
            flooded    = grid.fill_depressions(pit_filled)
            inflated   = grid.resolve_flats(flooded)

            # D8 flow direction
            fdir = grid.flowdir(inflated)

            # Flow accumulation
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
        # Simple upslope area approximation from DEM gradient magnitude
        from scipy.ndimage import gaussian_filter
        smoothed = gaussian_filter(dem.astype(np.float64), sigma=2)
        dy, dx = np.gradient(smoothed)
        slope_mag = np.sqrt(dx**2 + dy**2) + 1e-6

        # Accumulate along slope (very rough proxy – replace with real TCA)
        # We propagate a "weight" that increases as slope decreases (valley bottom)
        inverted = 1.0 / slope_mag
        cumulative = np.cumsum(np.cumsum(inverted, axis=0), axis=1)
        tca_raw = (cumulative / cumulative.max() * 1e6).astype(np.float32)

    # ── Write raw TCA ────────────────────────────────────────────────────────
    _write_tif(tca_raw, tca_raw_path, dtype="float32")
    print(f"[run_hf] TCA raw written → {tca_raw_path}", file=sys.stderr)

    # ── Log-normalise TCA 0–1 ────────────────────────────────────────────────
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

    # ── RRZ and NRZ ──────────────────────────────────────────────────────────
    valid_vals = tca_raw[np.isfinite(tca_raw) & (tca_raw >= 0)]
    if valid_vals.size > 0:
        p60 = float(np.percentile(valid_vals, 60))
        p80 = float(np.percentile(valid_vals, 80))
    else:
        p60, p80 = 0.0, 0.0

    # RRZ: TCA >= P80  (value=1, else NaN)
    rrz = np.where((tca_raw >= p80) & np.isfinite(tca_raw), 1.0, np.nan).astype(np.float32)
    _write_tif(rrz, tca_rrz_path, nodata=float("nan"))
    print(f"[run_hf] TCA RRZ written (P80={p80:.1f}) → {tca_rrz_path}", file=sys.stderr)

    # NRZ: P60 <= TCA < P80  (value=1, else NaN)
    nrz = np.where(
        (tca_raw >= p60) & (tca_raw < p80) & np.isfinite(tca_raw),
        1.0, np.nan
    ).astype(np.float32)
    _write_tif(nrz, tca_nrz_path, nodata=float("nan"))
    print(f"[run_hf] TCA NRZ written (P60={p60:.1f}) → {tca_nrz_path}", file=sys.stderr)

    return tca_raw, tca_norm, p60, p80


# ─── HF calculation ──────────────────────────────────────────────────────────

def compute_hf(geology_norm, soil_norm, tca_norm, weights: dict, grid_transform, utm_crs, ncols, nrows, out_path):
    """
    HF = (w_geo * G_norm + w_soil * S_norm + w_tca * TCA_norm) / (w_geo + w_soil + w_tca)
    Only valid where all three inputs are valid.
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
        "driver": "GTiff",
        "dtype": "float32",
        "width": ncols,
        "height": nrows,
        "count": 1,
        "crs": utm_crs,
        "transform": grid_transform,
        "nodata": float("nan"),
        "compress": "lzw",
    }
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(hf, 1)

    valid_hf = hf[np.isfinite(hf)]
    mn = float(valid_hf.min()) if valid_hf.size else 0.0
    mx = float(valid_hf.max()) if valid_hf.size else 0.0
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

    # ── 3. Load data-source config (geology/soil raster paths) ───────────────
    ds_config_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "data", "geology_config", "data_sources.json"
    )
    data_sources = {}
    if os.path.isfile(ds_config_path):
        with open(ds_config_path) as f:
            data_sources = json.load(f)
    else:
        print(f"[run_hf] data_sources.json not found at {ds_config_path}; using synthetic layers",
              file=sys.stderr)

    # ── 4. Compute UTM grid ──────────────────────────────────────────────────
    centre_lat = (minLat + maxLat) / 2
    centre_lon = (minLon + maxLon) / 2
    epsg_code  = utm_epsg(centre_lat, centre_lon)
    utm_crs    = CRS.from_epsg(epsg_code)

    min_x, max_x, min_y, max_y = bbox_to_utm(minLat, maxLat, minLon, maxLon, epsg_code)
    grid_transform, ncols, nrows = make_grid(min_x, max_x, min_y, max_y, res_m)

    pixel_count = ncols * nrows
    output_size_bytes = pixel_count * 4 * 8  # 8 float32 rasters
    output_size_mb    = round(output_size_bytes / (1024 * 1024), 1)

    print(f"[run_hf] UTM CRS: EPSG:{epsg_code}, grid: {ncols}×{nrows} = {pixel_count:,} px, "
          f"~{output_size_mb} MB", file=sys.stderr)

    # ── 5. DEM ───────────────────────────────────────────────────────────────
    dem_path = os.path.join(out_dir, f"{code}_HF_dem.tif")
    dem = fetch_copernicus_dem(
        aoi, res_m, utm_crs, grid_transform, ncols, nrows, dem_path
    )

    # ── 6. Geology and soil permeability ─────────────────────────────────────
    geo_out  = os.path.join(out_dir, f"{code}_HF_geologyPerm.tif")
    soil_out = os.path.join(out_dir, f"{code}_HF_soilPerm.tif")

    geology_norm = load_or_synthesise_perm(
        "geology", aoi, utm_crs, grid_transform, ncols, nrows, geo_out, data_sources
    )
    soil_norm = load_or_synthesise_perm(
        "soil", aoi, utm_crs, grid_transform, ncols, nrows, soil_out, data_sources
    )

    # ── 7. TCA, RRZ, NRZ ────────────────────────────────────────────────────
    tca_raw, tca_norm, p60, p80 = run_tca_pipeline(
        dem, grid_transform, utm_crs, ncols, nrows, out_dir, code
    )

    # ── 8. HF raster ─────────────────────────────────────────────────────────
    hf_out = os.path.join(out_dir, f"{code}_HF_hydroFavor.tif")
    hf = compute_hf(geology_norm, soil_norm, tca_norm, weights,
                    grid_transform, utm_crs, ncols, nrows, hf_out)

    # ── 9. Weights matrix CSV ────────────────────────────────────────────────
    csv_path = os.path.join(out_dir, f"{code}_HF_weights_matrix.csv")
    with open(csv_path, "w") as f:
        f.write("layer,weight\n")
        f.write(f"geology,{weights.get('geology', 1.0)}\n")
        f.write(f"soil,{weights.get('soil', 1.0)}\n")
        f.write(f"tca,{weights.get('tca', 1.0)}\n")
    print(f"[run_hf] Weights matrix written → {csv_path}", file=sys.stderr)

    # ── 10. Metadata JSON ────────────────────────────────────────────────────
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
        "geologySrc":        data_sources.get("geology", "synthetic"),
        "soilSrc":           data_sources.get("soil", "synthetic"),
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

    # ── 11. Zip all outputs ───────────────────────────────────────────────────
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

    # ── 12. Success status line ───────────────────────────────────────────────
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

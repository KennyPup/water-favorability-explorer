# Water Favorability Explorer

**Phase 1 – HF v1 (Hydrogeologic Favorability)**

Africa-focused MCDA web app for groundwater resource assessment
(boreholes, sand dams, MAR). Mirrors the architecture of the
[GRACE–TC–Geology Explorer](https://github.com/KennyPup/grace-lwe-explorer).

---

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + Vite + Tailwind CSS |
| Backend | Node.js / Express 5 (TypeScript, `tsx`) |
| Compute | Python 3 (`run_hf.py`) via `child_process.spawn` + stdin/stdout |
| State | TanStack Query (no DB in Phase 1) |

---

## Quick start

### 1. Install Node dependencies

```bash
npm install
```

### 2. Install Python dependencies

```bash
pip install -r python/requirements.txt
```

### 3. Start the dev server

```bash
npm run dev
```

Open http://localhost:5000.

---

## API

### `POST /api/hf/run`

Run the HF v1 pipeline.

```json
{
  "projectName": "Shabelle HF Test",
  "projectCode": "SHB",
  "aoi": { "type": "bbox", "minLat": -2, "maxLat": 2, "minLon": 42, "maxLon": 46 },
  "resolution": "90m",
  "weights": { "geology": 1.0, "soil": 1.0, "tca": 1.0 }
}
```

Returns JSON with `status`, `utmCrs`, `estimatedPixels`, `estimatedOutputSizeMB`, and `outputs` map.

### `GET /api/hf/download?projectCode=SHB&resolution=90m`

Streams the output ZIP.

### `GET /api/hf/status`

Lists completed project ZIPs in `data/outputs/`.

---

## HF v1 formula

```
HF = (w_geo·G_norm + w_soil·S_norm + w_tca·TCA_norm) / (w_geo + w_soil + w_tca)
```

- **G_norm** – geology permeability normalised 0–1 (GLIM / WHYMAP classes)
- **S_norm** – soil permeability normalised 0–1 (HWSD / iSDA-Africa)
- **TCA_norm** – log₁₀-normalised flow accumulation 0–1
- **RRZ** – TCA ≥ P80
- **NRZ** – P60 ≤ TCA < P80

---

## Output files (per run)

| File | Description |
|------|-------------|
| `SHB_HF_dem.tif` | DEM (Copernicus GLO-30; stub in Phase 1) |
| `SHB_HF_geologyPerm.tif` | Geology permeability 0–1 |
| `SHB_HF_soilPerm.tif` | Soil permeability 0–1 |
| `SHB_HF_tca_raw.tif` | Raw flow accumulation (cells) |
| `SHB_HF_tca_norm.tif` | Log-normalised TCA 0–1 |
| `SHB_HF_tca_rrz.tif` | Recharge Response Zone (TCA ≥ P80) |
| `SHB_HF_tca_nrz.tif` | Near-Recharge Zone (P60 ≤ TCA < P80) |
| `SHB_HF_hydroFavor.tif` | **HF raster** (float32, 0–1) |
| `SHB_HF_weights_matrix.csv` | Weights used |
| `SHB_HF_metadata.json` | Full run metadata |

---

## Configuring real data sources

Edit `data/geology_config/data_sources.json`:

```json
{
  "geology": "/path/to/GLIM_global.tif",
  "soil":    "/path/to/HWSD_soil.tif"
}
```

For the DEM, implement `fetch_copernicus_dem()` in `python/run_hf.py` to
download GLO-30 tiles from [AWS open-data](https://registry.opendata.aws/copernicus-dem/).

---

## Planned phases

| Phase | Component | Inputs |
|-------|-----------|--------|
| 1 (this) | HF v1 | Geology + Soil + TCA |
| 2 | RF (Recharge Favorability) | TerraClimate (ppt, aet, ro) |
| 3 | WF (Water Favorability) | HF + RF combined |

---

## Production build

```bash
npm run build
npm start
```

## Deploy to Render

See `render.yaml`. Uses `npm run build` + `npm start`, Python 3 required in the build environment.

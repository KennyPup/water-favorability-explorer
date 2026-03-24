/**
 * routes.ts – Water Favorability Explorer
 *
 * Mirrors the spawn-from-stdin pattern of the GRACE–TC–Geology Explorer.
 * All heavy compute is delegated to python/run_hf.py via stdin/stdout.
 *
 * API surface:
 *   POST /api/hf/run            – run HF pipeline, returns JSON + per-layer URLs
 *   GET  /api/hf/download       – stream full ZIP
 *   GET  /api/hf/file           – stream individual GeoTIFF/CSV/JSON layer
 *   GET  /api/hf/preview        – return PNG preview of HF raster for map overlay
 *   GET  /api/hf/status         – list completed runs
 */

import type { Express } from "express";
import type { Server } from "http";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { z } from "zod";

// ─── Layer definitions ────────────────────────────────────────────────────────

const LAYER_MAP: Record<string, string> = {
  hf:          "_HF_hydroFavor.tif",
  geology:     "_HF_geologyPerm.tif",
  soil:        "_HF_soilPerm.tif",
  tca_raw:     "_HF_tca_raw.tif",
  tca_norm:    "_HF_tca_norm.tif",
  rrz:         "_HF_tca_rrz.tif",
  nrz:         "_HF_tca_nrz.tif",
  dem:         "_HF_dem.tif",
  weights:     "_HF_weights_matrix.csv",
  metadata:    "_HF_metadata.json",
};

const LAYER_MIME: Record<string, string> = {
  ".tif":  "image/tiff",
  ".tiff": "image/tiff",
  ".csv":  "text/csv",
  ".json": "application/json",
  ".png":  "image/png",
};

// ─── Validation schema ────────────────────────────────────────────────────────

const HfRunSchema = z.object({
  projectName: z.string().min(1, "projectName is required"),
  projectCode: z
    .string()
    .min(2, "projectCode must be 2–4 characters")
    .max(4, "projectCode must be 2–4 characters")
    .regex(/^[A-Za-z]+$/, "projectCode must be letters only"),
  aoi: z.object({
    type: z.enum(["bbox", "country"]),
    minLat: z.number().optional(),
    maxLat: z.number().optional(),
    minLon: z.number().optional(),
    maxLon: z.number().optional(),
    name: z.string().optional(),
  }),
  resolution: z.enum(["30m", "90m", "1km"]),
  weights: z
    .object({
      geology: z.number().positive().optional(),
      soil:    z.number().positive().optional(),
      tca:     z.number().positive().optional(),
    })
    .optional(),
});

type HfRunBody = z.infer<typeof HfRunSchema>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const OUTPUTS_DIR = path.join(process.cwd(), "data", "outputs");

function ensureOutputsDir() {
  if (!fs.existsSync(OUTPUTS_DIR)) fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
}

function estimatePixels(minLat: number, maxLat: number, minLon: number, maxLon: number, resolution: string): number {
  const centreLat  = (minLat + maxLat) / 2;
  const mPerDegLat = 111_132;
  const mPerDegLon = 111_132 * Math.cos((centreLat * Math.PI) / 180);
  const resM       = resolution === "30m" ? 30 : resolution === "90m" ? 90 : 1000;
  return Math.ceil(((maxLat - minLat) * mPerDegLat) / resM) *
         Math.ceil(((maxLon - minLon) * mPerDegLon) / resM);
}

function estimateOutputSizeMB(pixels: number): number {
  return Math.ceil((pixels * 4 * 8) / (1024 * 1024));
}

function centreUtmEpsg(minLat: number, maxLat: number, minLon: number, maxLon: number): string {
  const zone = Math.floor(((minLon + maxLon) / 2 + 180) / 6) + 1;
  const base = (minLat + maxLat) / 2 >= 0 ? 32600 : 32700;
  return `EPSG:${base + zone}`;
}

function pythonScriptPath(): string {
  const candidates = [
    path.join(process.cwd(), "python", "run_hf.py"),
    path.join(path.dirname(process.argv[1] || ""), "run_hf.py"),
  ];
  for (const p of candidates) { if (fs.existsSync(p)) return p; }
  return candidates[0];
}

/** Build per-layer download URL map for the response */
function buildLayerUrls(code: string, resolution: string): Record<string, string> {
  const urls: Record<string, string> = {};
  for (const [layerKey, suffix] of Object.entries(LAYER_MAP)) {
    urls[layerKey] = `/api/hf/file?projectCode=${code}&resolution=${resolution}&layer=${layerKey}`;
  }
  return urls;
}

// ─── Route registration ───────────────────────────────────────────────────────

export function registerRoutes(httpServer: Server, app: Express) {
  ensureOutputsDir();

  // ── POST /api/hf/run ──────────────────────────────────────────────────────
  app.post("/api/hf/run", (req, res) => {
    const parseResult = HfRunSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        status: "error",
        error: parseResult.error.issues.map((i) => i.message).join("; "),
      });
    }

    const body: HfRunBody = parseResult.data;
    const code = body.projectCode.toUpperCase();
    const { resolution, aoi } = body;

    if (aoi.type === "bbox") {
      const { minLat, maxLat, minLon, maxLon } = aoi;
      if (minLat === undefined || maxLat === undefined || minLon === undefined || maxLon === undefined)
        return res.status(400).json({ status: "error", error: "bbox AOI requires minLat, maxLat, minLon, maxLon" });
      if (minLat >= maxLat)
        return res.status(400).json({ status: "error", error: "minLat must be < maxLat" });
      if (minLon >= maxLon)
        return res.status(400).json({ status: "error", error: "minLon must be < maxLon" });
      if (minLat < -90 || maxLat > 90)
        return res.status(400).json({ status: "error", error: "Latitude out of range" });
      if (minLon < -180 || maxLon > 180)
        return res.status(400).json({ status: "error", error: "Longitude out of range" });
    } else {
      return res.status(400).json({ status: "error", error: "Country AOI not yet implemented – use bbox." });
    }

    const { minLat, maxLat, minLon, maxLon } = aoi as Required<typeof aoi>;
    const utmCrs              = centreUtmEpsg(minLat!, maxLat!, minLon!, maxLon!);
    const estimatedPixels     = estimatePixels(minLat!, maxLat!, minLon!, maxLon!, resolution);
    const estimatedOutputSizeMB = estimateOutputSizeMB(estimatedPixels);

    const weights = {
      geology: body.weights?.geology ?? 1.0,
      soil:    body.weights?.soil    ?? 1.0,
      tca:     body.weights?.tca     ?? 1.0,
    };

    const payload = {
      projectName: body.projectName,
      projectCode: code,
      aoi: { type: "bbox", minLat: minLat!, maxLat: maxLat!, minLon: minLon!, maxLon: maxLon! },
      resolution,
      weights,
      outputsDir: OUTPUTS_DIR,
    };

    const script = pythonScriptPath();
    console.log(`[HF] Spawning ${script} for ${code} @ ${resolution}`);

    const py = spawn("python3", [script], { timeout: 30 * 60 * 1000 });
    let stdout = "", stderr = "";
    py.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    py.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    py.on("close", (code_: number | null) => {
      if (stderr.trim()) console.error("[HF Python stderr]", stderr.slice(0, 1000));

      const line = stdout.trim().split("\n").pop() ?? "";

      if (code_ !== 0 || !line.startsWith("OK:")) {
        const errMsg = line.startsWith("ERROR:") ? line.slice(6) : stderr.slice(0, 400) || `exit ${code_}`;
        return res.status(500).json({ status: "error", error: errMsg });
      }

      const parts  = line.split(":");
      const zipPath = parts.slice(3).join(":");

      return res.json({
        status: "ok",
        projectCode: code,
        resolution,
        utmCrs,
        estimatedPixels,
        estimatedOutputSizeMB,
        // AOI echoed back so frontend can use it for map overlay bounds
        aoi: { minLat: minLat!, maxLat: maxLat!, minLon: minLon!, maxLon: maxLon! },
        outputs: {
          hfRaster:      `${code}_HF_hydroFavor.tif`,
          geologyNorm:   `${code}_HF_geologyPerm.tif`,
          soilNorm:      `${code}_HF_soilPerm.tif`,
          tcaRaw:        `${code}_HF_tca_raw.tif`,
          tcaNorm:       `${code}_HF_tca_norm.tif`,
          tcaRRZ:        `${code}_HF_tca_rrz.tif`,
          tcaNRZ:        `${code}_HF_tca_nrz.tif`,
          dem:           `${code}_HF_dem.tif`,
          weightsMatrix: `${code}_HF_weights_matrix.csv`,
          metadata:      `${code}_HF_metadata.json`,
          zipName:       path.basename(zipPath),
          zipPath,
        },
        // Per-layer direct download URLs (new in this update)
        layerUrls: buildLayerUrls(code, resolution),
        // Preview PNG URL for HF map overlay
        previewUrl: `/api/hf/preview?projectCode=${code}&resolution=${resolution}`,
        // Preview PNG URL for TCA overlay (light→dark blue ramp)
        tcaPreviewUrl: `/api/hf/preview?projectCode=${code}&resolution=${resolution}&layer=tca`,
      });
    });

    py.on("error", (err: Error) => {
      return res.status(500).json({ status: "error", error: `Failed to spawn pipeline: ${err.message}` });
    });

    py.stdin.write(JSON.stringify(payload));
    py.stdin.end();
  });

  // ── GET /api/hf/download ──────────────────────────────────────────────────
  app.get("/api/hf/download", (req, res) => {
    const projectCode = (req.query.projectCode as string | undefined)?.toUpperCase();
    const resolution  = req.query.resolution as string | undefined;

    if (!projectCode)
      return res.status(400).json({ error: "projectCode required" });

    let zipPath: string | undefined;
    if (resolution) {
      const c = path.join(OUTPUTS_DIR, `${projectCode}_HF_outputs_${resolution}.zip`);
      if (fs.existsSync(c)) zipPath = c;
    }
    if (!zipPath) {
      try {
        const match = fs.readdirSync(OUTPUTS_DIR)
          .filter((f) => f.startsWith(`${projectCode}_HF_`) && f.endsWith(".zip"))
          .sort().pop();
        if (match) zipPath = path.join(OUTPUTS_DIR, match);
      } catch { /* ignore */ }
    }
    if (!zipPath || !fs.existsSync(zipPath))
      return res.status(404).json({ error: `No ZIP found for ${projectCode}` });

    const filename = path.basename(zipPath);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    const stream = fs.createReadStream(zipPath);
    stream.pipe(res);
    stream.on("error", (e: Error) => { console.error("[HF Download]", e); res.destroy(); });
  });

  // ── GET /api/hf/file – stream individual layer file ───────────────────────
  // Query params: projectCode, resolution (optional), layer
  // layer values: hf | geology | soil | tca_raw | tca_norm | rrz | nrz | dem | weights | metadata
  app.get("/api/hf/file", (req, res) => {
    const projectCode = (req.query.projectCode as string | undefined)?.toUpperCase();
    const layer       = req.query.layer as string | undefined;
    const resolution  = req.query.resolution as string | undefined;

    if (!projectCode) return res.status(400).json({ error: "projectCode required" });
    if (!layer)       return res.status(400).json({ error: "layer required" });

    const suffix = LAYER_MAP[layer];
    if (!suffix)
      return res.status(400).json({ error: `Unknown layer "${layer}". Valid: ${Object.keys(LAYER_MAP).join(", ")}` });

    // Files are stored under OUTPUTS_DIR/CODE/
    const projectDir = path.join(OUTPUTS_DIR, projectCode);
    const filename   = `${projectCode}${suffix}`;
    const filePath   = path.join(projectDir, filename);

    if (!fs.existsSync(filePath))
      return res.status(404).json({ error: `File not found: ${filename}. Run /api/hf/run first.` });

    const ext  = path.extname(filename).toLowerCase();
    const mime = LAYER_MIME[ext] || "application/octet-stream";
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on("error", (e: Error) => { console.error("[HF File]", e); res.destroy(); });
  });

  // ── GET /api/hf/preview – render HF or TCA raster as PNG for Leaflet overlay
  // Query params:
  //   projectCode  – required
  //   layer        – "hf" (default) | "tca"   selects which GeoTIFF to render
  //   resolution   – optional (unused for routing, kept for cache-busting)
  //
  // Returns {ok, pngUrl, bounds} so the frontend can use L.imageOverlay.
  //
  // Colour ramps:
  //   hf  → blue → green → yellow → red  (low→high favorability)
  //   tca → light blue → dark blue        (low→high flow accumulation)
  app.get("/api/hf/preview", (req, res) => {
    const projectCode = (req.query.projectCode as string | undefined)?.toUpperCase();
    const layer       = (req.query.layer as string | undefined) ?? "hf";
    const resolution  = req.query.resolution as string | undefined;

    if (!projectCode) return res.status(400).json({ error: "projectCode required" });
    if (layer !== "hf" && layer !== "tca")
      return res.status(400).json({ error: `Unknown layer "${layer}". Valid: hf, tca` });

    const projectDir = path.join(OUTPUTS_DIR, projectCode);
    const metaPath   = path.join(projectDir, `${projectCode}_HF_metadata.json`);

    const tifPath  = layer === "tca"
      ? path.join(projectDir, `${projectCode}_HF_tca_norm.tif`)
      : path.join(projectDir, `${projectCode}_HF_hydroFavor.tif`);

    const tifLabel = layer === "tca" ? "TCA" : "HF";

    if (!fs.existsSync(tifPath))
      return res.status(404).json({ error: `${tifLabel} raster not found for ${projectCode}. Run pipeline first.` });

    // Read metadata for bounds
    let bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number } | null = null;
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        bounds = meta.aoi;
      } catch { /* ignore */ }
    }

    // PNG output path (layer-specific so HF and TCA PNGs don't collide)
    const pngSuffix = layer === "tca" ? "_TCA_preview.png" : "_HF_preview.png";
    const pngPath   = path.join(projectDir, `${projectCode}${pngSuffix}`);

    // Inline Python renderer – parameterised by colour ramp
    const pyCode = `
import sys, json, numpy as np, rasterio

tif_path  = sys.argv[1]
png_path  = sys.argv[2]
layer_key = sys.argv[3]  # 'hf' or 'tca'

with rasterio.open(tif_path) as src:
    data = src.read(1).astype(np.float64)
    nodata = src.nodata
    bounds_raster = src.bounds
    crs = src.crs

if nodata is not None:
    data = np.where((data == nodata) | (data < -9990), np.nan, data)

# Normalise to 0-1
valid = np.isfinite(data)
if valid.any():
    mn, mx = data[valid].min(), data[valid].max()
    if mx > mn:
        data = np.where(valid, (data - mn) / (mx - mn), np.nan)

h, w = data.shape
rgba = np.zeros((h, w, 4), dtype=np.uint8)

# Colour ramp definition
if layer_key == 'tca':
    # Light blue → dark blue (low TCA = pale, high TCA = deep blue channels)
    stops = [
        (0.00, (200, 230, 255)),  # very light blue
        (0.33, (100, 180, 255)),  # sky blue
        (0.66, ( 30, 100, 220)),  # medium blue
        (1.00, (  0,  20, 140)),  # deep dark blue
    ]
else:
    # Blue → Green → Yellow → Red (HF favorability)
    stops = [
        (0.00, (  0,   0, 200)),
        (0.33, (  0, 180,  80)),
        (0.66, (255, 220,   0)),
        (1.00, (220,  30,  30)),
    ]

def lerp_color(v):
    for i in range(len(stops) - 1):
        t0, c0 = stops[i]
        t1, c1 = stops[i + 1]
        if t0 <= v <= t1:
            f = (v - t0) / (t1 - t0)
            return tuple(int(c0[j] + f * (c1[j] - c0[j])) for j in range(3))
    return stops[-1][1]

for i in range(h):
    for j in range(w):
        v = data[i, j]
        if not np.isfinite(v):
            rgba[i, j] = (0, 0, 0, 0)
        else:
            r, g, b = lerp_color(float(v))
            rgba[i, j] = (r, g, b, 200)

from PIL import Image
Image.fromarray(rgba, 'RGBA').save(png_path)

# Reproject bounds to WGS84 if needed
try:
    from pyproj import Transformer
    if not crs.is_geographic:
        t = Transformer.from_crs(crs, 'EPSG:4326', always_xy=True)
        minx, miny = bounds_raster.left, bounds_raster.bottom
        maxx, maxy = bounds_raster.right, bounds_raster.top
        lons, lats = t.transform([minx, maxx, minx, maxx], [miny, miny, maxy, maxy])
        geo_bounds = {'minLat': min(lats), 'maxLat': max(lats), 'minLon': min(lons), 'maxLon': max(lons)}
    else:
        geo_bounds = {'minLat': bounds_raster.bottom, 'maxLat': bounds_raster.top, 'minLon': bounds_raster.left, 'maxLon': bounds_raster.right}
except Exception as e:
    geo_bounds = {'error': str(e)}

print(json.dumps({'ok': True, 'bounds': geo_bounds}))
`;

    const py = spawn("python3", ["-c", pyCode, tifPath, pngPath, layer], { timeout: 60_000 });
    let stdout = "", stderr = "";
    py.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    py.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    py.on("close", (code_: number | null) => {
      if (code_ !== 0) {
        console.error(`[HF Preview/${layer}] Python error:`, stderr.slice(0, 400));
        return res.status(500).json({ error: `Preview render failed: ${stderr.slice(0, 200)}` });
      }
      try {
        const result = JSON.parse(stdout.trim());
        // layer-specific image URL so HF and TCA don't clash
        const pngUrl = `/api/hf/preview-image?projectCode=${projectCode}&layer=${layer}`;
        return res.json({ ok: true, pngUrl, bounds: result.bounds ?? bounds });
      } catch {
        return res.status(500).json({ error: "Preview parse failed: " + stdout.slice(0, 100) });
      }
    });
  });

  // ── GET /api/hf/preview-image – serve the rendered PNG ──────────────────
  app.get("/api/hf/preview-image", (req, res) => {
    const projectCode = (req.query.projectCode as string | undefined)?.toUpperCase();
    const layer       = (req.query.layer as string | undefined) ?? "hf";
    if (!projectCode) return res.status(400).json({ error: "projectCode required" });

    const pngSuffix = layer === "tca" ? "_TCA_preview.png" : "_HF_preview.png";
    const pngPath   = path.join(OUTPUTS_DIR, projectCode, `${projectCode}${pngSuffix}`);
    if (!fs.existsSync(pngPath))
      return res.status(404).json({ error: "Preview PNG not found. Call /api/hf/preview first." });

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-cache");
    fs.createReadStream(pngPath).pipe(res);
  });

  // ── GET /api/hf/status ────────────────────────────────────────────────────
  app.get("/api/hf/status", (_req, res) => {
    try {
      const files    = fs.existsSync(OUTPUTS_DIR) ? fs.readdirSync(OUTPUTS_DIR) : [];
      const zips     = files.filter((f) => f.endsWith(".zip"));
      const projects = [...new Set(zips.map((z) => z.split("_")[0]))];
      res.json({ status: "ready", outputsDir: OUTPUTS_DIR, zips, projects });
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
}

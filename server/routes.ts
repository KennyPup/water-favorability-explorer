/**
 * routes.ts – Water Favorability Explorer
 *
 * Async job model: POST /api/hf/run returns a jobId immediately; the Python
 * process runs in the background. The frontend polls GET /api/hf/job/:jobId
 * every 3 s to get live progress notes and final result.
 *
 * API surface:
 *   POST /api/hf/run             – enqueue job, return { jobId } immediately
 *   GET  /api/hf/job/:jobId      – poll job status + logs + result
 *   GET  /api/hf/download        – stream full ZIP
 *   GET  /api/hf/file            – stream individual layer file
 *   GET  /api/hf/preview         – render HF or TCA raster → PNG metadata
 *   GET  /api/hf/preview-image   – serve rendered PNG
 *   GET  /api/hf/status          – list completed runs (legacy)
 */

import type { Express } from "express";
import type { Server } from "http";
import { spawn, execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { z } from "zod";
import type { HfJob, HfJobStatusResponse } from "@shared/types";

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

// ─── In-memory job store ──────────────────────────────────────────────────────
// Keeps the last 20 jobs in memory. Sufficient for a single-user deployment.

const JOB_STORE = new Map<string, HfJob>();
const MAX_JOBS = 20;

function pruneJobs() {
  if (JOB_STORE.size <= MAX_JOBS) return;
  // Delete oldest finished jobs first
  const finished = [...JOB_STORE.entries()]
    .filter(([, j]) => j.status === "ok" || j.status === "error")
    .sort((a, b) => a[1].startedAt.localeCompare(b[1].startedAt));
  for (const [id] of finished.slice(0, JOB_STORE.size - MAX_JOBS)) {
    JOB_STORE.delete(id);
  }
}

// ─── Validation schema ────────────────────────────────────────────────────────

const HfRunSchema = z.object({
  projectName: z.string().min(1, "projectName is required"),
  projectCode: z
    .string()
    .min(2, "projectCode must be 2–3 characters")
    .max(3, "projectCode must be 2–3 characters")
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
      geology: z.coerce.number().positive().optional(),
      soil:    z.coerce.number().positive().optional(),
      tca:     z.coerce.number().positive().optional(),
    })
    .optional(),
});

type HfRunBody = z.infer<typeof HfRunSchema>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const OUTPUTS_DIR = path.join(process.cwd(), "data", "outputs");

function ensureOutputsDir() {
  fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
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

/**
 * Resolve the correct Python executable.
 * Render (and most Linux hosts) only have `python3`.
 */
function pythonExecutable(): string {
  for (const cmd of ["python3", "python"]) {
    try {
      execFileSync(cmd, ["--version"], { stdio: "ignore" });
      return cmd;
    } catch { /* not found */ }
  }
  return "python3";
}

/** Build per-layer download URL map */
function buildLayerUrls(code: string, resolution: string): Record<string, string> {
  const urls: Record<string, string> = {};
  for (const [layerKey] of Object.entries(LAYER_MAP)) {
    urls[layerKey] = `/api/hf/file?projectCode=${code}&resolution=${resolution}&layer=${layerKey}`;
  }
  return urls;
}

/**
 * Spawn the Python pipeline for a job. Updates job in-place via JOB_STORE.
 * All stderr lines are appended to job.logs so the frontend can display them.
 */
function spawnPipeline(job: HfJob, payload: object) {
  const script    = pythonScriptPath();
  const pythonCmd = pythonExecutable();

  console.log(`[HF job:${job.jobId}] Spawning ${pythonCmd} ${script}`);
  job.logs.push(`Spawning pipeline (${pythonCmd})…`);

  // Ensure per-project output directory exists before Python tries to write
  const projectDir = path.join(OUTPUTS_DIR, job.projectCode);
  fs.mkdirSync(projectDir, { recursive: true });

  const py = spawn(pythonCmd, [script], { timeout: 30 * 60 * 1000 });
  let stdout = "";

  py.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });

  py.stderr.on("data", (d: Buffer) => {
    // Each stderr line from Python is a progress note (e.g. "[run_hf] Step 3…")
    const lines = d.toString().split("\n").map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      console.log(`[HF job:${job.jobId}] ${line}`);
      // Strip the "[run_hf] " prefix for cleaner display
      job.logs.push(line.replace(/^\[run_hf\]\s*/, ""));
    }
  });

  py.on("error", (err: Error) => {
    console.error(`[HF job:${job.jobId}] spawn error:`, err.message);
    job.status     = "error";
    job.error      = `Failed to spawn pipeline: ${err.message}`;
    job.finishedAt = new Date().toISOString();
  });

  py.on("close", (exitCode: number | null) => {
    job.finishedAt = new Date().toISOString();
    const lastLine = stdout.trim().split("\n").pop() ?? "";

    if (exitCode !== 0 || !lastLine.startsWith("OK:")) {
      const errMsg = lastLine.startsWith("ERROR:")
        ? lastLine.slice(6)
        : job.logs.slice(-5).join(" | ") || `exit ${exitCode}`;
      console.error(`[HF job:${job.jobId}] FAILED (exit ${exitCode}): ${errMsg}`);
      job.status = "error";
      job.error  = errMsg;
      return;
    }

    // Parse "OK:CODE:RESOLUTION:/path/to/zip"
    const parts   = lastLine.split(":");
    const zipPath = parts.slice(3).join(":");
    const code    = job.projectCode;
    const resolution = job.resolution;

    job.status = "ok";
    job.logs.push("Pipeline complete ✓");
    job.result = {
      projectCode:           code,
      resolution,
      utmCrs:                job.utmCrs,
      estimatedPixels:       job.estimatedPixels,
      estimatedOutputSizeMB: job.estimatedOutputSizeMB,
      aoi:                   job.aoi,
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
      layerUrls:     buildLayerUrls(code, resolution) as any,
      previewUrl:    `/api/hf/preview?projectCode=${code}&resolution=${resolution}`,
      tcaPreviewUrl: `/api/hf/preview?projectCode=${code}&resolution=${resolution}&layer=tca`,
    };

    console.log(`[HF job:${job.jobId}] SUCCESS → ${zipPath}`);
  });

  py.stdin.write(JSON.stringify(payload));
  py.stdin.end();
}

// ─── Route registration ───────────────────────────────────────────────────────

export function registerRoutes(httpServer: Server, app: Express) {
  ensureOutputsDir();

  // ── POST /api/hf/run – enqueue job, return jobId immediately ─────────────
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
    const utmCrs               = centreUtmEpsg(minLat!, maxLat!, minLon!, maxLon!);
    const estimatedPixels      = estimatePixels(minLat!, maxLat!, minLon!, maxLon!, resolution);
    const estimatedOutputSizeMB = estimateOutputSizeMB(estimatedPixels);

    const weights = {
      geology: body.weights?.geology ?? 1.0,
      soil:    body.weights?.soil    ?? 1.0,
      tca:     body.weights?.tca     ?? 1.0,
    };

    const jobId = randomUUID();
    const job: HfJob = {
      jobId,
      status:      "running",
      projectCode: code,
      resolution,
      utmCrs,
      estimatedPixels,
      estimatedOutputSizeMB,
      aoi: { minLat: minLat!, maxLat: maxLat!, minLon: minLon!, maxLon: maxLon! },
      logs:      [],
      startedAt: new Date().toISOString(),
    };
    pruneJobs();
    JOB_STORE.set(jobId, job);

    const payload = {
      projectName: body.projectName,
      projectCode: code,
      aoi: { type: "bbox", minLat: minLat!, maxLat: maxLat!, minLon: minLon!, maxLon: maxLon! },
      resolution,
      weights,
      outputsDir: OUTPUTS_DIR,
      utmCrs,
    };

    // Fire-and-forget – response returns immediately
    spawnPipeline(job, payload);

    return res.json({ status: "queued", jobId });
  });

  // ── GET /api/hf/job/:jobId – poll for status + logs ──────────────────────
  app.get("/api/hf/job/:jobId", (req, res) => {
    const job = JOB_STORE.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });

    const response: HfJobStatusResponse = {
      jobId:  job.jobId,
      status: job.status,
      logs:   job.logs,
      error:  job.error,
      result: job.result,
    };
    return res.json(response);
  });

  // ── GET /api/hf/download ──────────────────────────────────────────────────
  app.get("/api/hf/download", (req, res) => {
    const projectCode = (req.query.projectCode as string | undefined)?.toUpperCase();
    const resolution  = req.query.resolution as string | undefined;

    if (!projectCode)
      return res.status(400).json({ error: "projectCode required" });

    let zipPath: string | undefined;
    if (resolution) {
      const c = path.join(OUTPUTS_DIR, projectCode, `${projectCode}_HF_outputs_${resolution}.zip`);
      if (fs.existsSync(c)) zipPath = c;
    }
    if (!zipPath) {
      // Also check root outputs dir for backward compat
      for (const dir of [path.join(OUTPUTS_DIR, projectCode), OUTPUTS_DIR]) {
        try {
          const match = fs.readdirSync(dir)
            .filter((f) => f.startsWith(`${projectCode}_HF_`) && f.endsWith(".zip"))
            .sort().pop();
          if (match) { zipPath = path.join(dir, match); break; }
        } catch { /* ignore */ }
      }
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

  // ── GET /api/hf/file – stream individual layer file ──────────────────────
  app.get("/api/hf/file", (req, res) => {
    const projectCode = (req.query.projectCode as string | undefined)?.toUpperCase();
    const layer       = req.query.layer as string | undefined;
    const resolution  = req.query.resolution as string | undefined;

    if (!projectCode) return res.status(400).json({ error: "projectCode required" });
    if (!layer)       return res.status(400).json({ error: "layer required" });

    const suffix = LAYER_MAP[layer];
    if (!suffix)
      return res.status(400).json({ error: `Unknown layer "${layer}". Valid: ${Object.keys(LAYER_MAP).join(", ")}` });

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

  // ── GET /api/hf/preview – render HF or TCA raster as PNG ─────────────────
  app.get("/api/hf/preview", (req, res) => {
    const projectCode = (req.query.projectCode as string | undefined)?.toUpperCase();
    const layer       = (req.query.layer as string | undefined) ?? "hf";
    const resolution  = req.query.resolution as string | undefined;

    if (!projectCode) return res.status(400).json({ error: "projectCode required" });
    if (layer !== "hf" && layer !== "tca")
      return res.status(400).json({ error: `Unknown layer "${layer}". Valid: hf, tca` });

    const projectDir = path.join(OUTPUTS_DIR, projectCode);
    const metaPath   = path.join(projectDir, `${projectCode}_HF_metadata.json`);

    const tifPath = layer === "tca"
      ? path.join(projectDir, `${projectCode}_HF_tca_norm.tif`)
      : path.join(projectDir, `${projectCode}_HF_hydroFavor.tif`);

    const tifLabel = layer === "tca" ? "TCA" : "HF";

    if (!fs.existsSync(tifPath))
      return res.status(404).json({ error: `${tifLabel} raster not found for ${projectCode}. Run pipeline first.` });

    let bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number } | null = null;
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        bounds = meta.aoi;
      } catch { /* ignore */ }
    }

    const pngSuffix = layer === "tca" ? "_TCA_preview.png" : "_HF_preview.png";
    const pngPath   = path.join(projectDir, `${projectCode}${pngSuffix}`);

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

valid = np.isfinite(data)
if valid.any():
    mn, mx = data[valid].min(), data[valid].max()
    if mx > mn:
        data = np.where(valid, (data - mn) / (mx - mn), np.nan)

h, w = data.shape
rgba = np.zeros((h, w, 4), dtype=np.uint8)

if layer_key == 'tca':
    stops = [
        (0.00, (200, 230, 255)),
        (0.33, (100, 180, 255)),
        (0.66, ( 30, 100, 220)),
        (1.00, (  0,  20, 140)),
    ]
else:
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

    const pythonCmd = pythonExecutable();
    const py = spawn(pythonCmd, ["-c", pyCode, tifPath, pngPath, layer], { timeout: 60_000 });
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
        const pngUrl = `/api/hf/preview-image?projectCode=${projectCode}&layer=${layer}`;
        return res.json({ ok: true, pngUrl, bounds: result.bounds ?? bounds });
      } catch {
        return res.status(500).json({ error: "Preview parse failed: " + stdout.slice(0, 100) });
      }
    });
  });

  // ── GET /api/hf/preview-image – serve the rendered PNG ───────────────────
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

  // ── GET /api/hf/status – list completed runs (legacy / health check) ──────
  app.get("/api/hf/status", (_req, res) => {
    try {
      const jobs = [...JOB_STORE.values()].map(j => ({
        jobId:      j.jobId,
        status:     j.status,
        projectCode: j.projectCode,
        resolution:  j.resolution,
        startedAt:   j.startedAt,
        finishedAt:  j.finishedAt,
      }));
      res.json({ status: "ready", outputsDir: OUTPUTS_DIR, jobs });
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
}

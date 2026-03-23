/**
 * routes.ts – Water Favorability Explorer
 *
 * Mirrors the spawn-from-stdin pattern of the GRACE–TC–Geology Explorer.
 * All heavy compute is delegated to python/run_hf.py via stdin/stdout.
 */

import type { Express } from "express";
import type { Server } from "http";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { z } from "zod";

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
    // bbox fields (required when type === "bbox")
    minLat: z.number().optional(),
    maxLat: z.number().optional(),
    minLon: z.number().optional(),
    maxLon: z.number().optional(),
    // country stub
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
  if (!fs.existsSync(OUTPUTS_DIR)) {
    fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
  }
}

/** Approximate pixel count for a bbox at a given resolution */
function estimatePixels(
  minLat: number, maxLat: number, minLon: number, maxLon: number,
  resolution: string
): number {
  const latDeg = maxLat - minLat;
  const lonDeg = maxLon - minLon;
  // Approx meters per degree at AOI centre
  const centreLat = (minLat + maxLat) / 2;
  const mPerDegLat = 111_132;
  const mPerDegLon = 111_132 * Math.cos((centreLat * Math.PI) / 180);
  const heightM = latDeg * mPerDegLat;
  const widthM  = lonDeg * mPerDegLon;

  const resM = resolution === "30m" ? 30 : resolution === "90m" ? 90 : 1000;
  const rows = Math.ceil(heightM / resM);
  const cols = Math.ceil(widthM  / resM);
  return rows * cols;
}

/** Rough output size in MB given pixel count (7 float32 rasters + a few small files) */
function estimateOutputSizeMB(pixels: number): number {
  const rasterCount = 7; // dem, geologyPerm, soilPerm, tca_raw, tca_norm, tca_rrz, tca_nrz + hf
  const bytesPerPixel = 4; // float32
  const totalBytes = pixels * bytesPerPixel * (rasterCount + 1);
  return Math.ceil(totalBytes / (1024 * 1024));
}

/** Derive central UTM EPSG from bbox centre */
function centreUtmEpsg(minLat: number, maxLat: number, minLon: number, maxLon: number): string {
  const centreLon = (minLon + maxLon) / 2;
  const centreLat = (minLat + maxLat) / 2;
  const zone = Math.floor((centreLon + 180) / 6) + 1;
  const base = centreLat >= 0 ? 32600 : 32700;
  return `EPSG:${base + zone}`;
}

/** Resolve path to the Python script (works in dev and prod builds) */
function pythonScriptPath(): string {
  const candidates = [
    path.join(process.cwd(), "python", "run_hf.py"),
    path.join(path.dirname(process.argv[1] || ""), "run_hf.py"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Return first candidate – Python will produce a clear error
  return candidates[0];
}

// ─── Route registration ───────────────────────────────────────────────────────

export function registerRoutes(httpServer: Server, app: Express) {
  ensureOutputsDir();

  // ── POST /api/hf/run ───────────────────────────────────────────────────────
  app.post("/api/hf/run", (req, res) => {
    // 1. Validate input
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

    // 2. Validate AOI completeness
    if (aoi.type === "bbox") {
      const { minLat, maxLat, minLon, maxLon } = aoi;
      if (
        minLat === undefined || maxLat === undefined ||
        minLon === undefined || maxLon === undefined
      ) {
        return res.status(400).json({
          status: "error",
          error: "bbox AOI requires minLat, maxLat, minLon, maxLon",
        });
      }
      if (minLat >= maxLat)
        return res.status(400).json({ status: "error", error: "minLat must be < maxLat" });
      if (minLon >= maxLon)
        return res.status(400).json({ status: "error", error: "minLon must be < maxLon" });
      if (minLat < -90 || maxLat > 90)
        return res.status(400).json({ status: "error", error: "Latitude out of range [-90, 90]" });
      if (minLon < -180 || maxLon > 180)
        return res.status(400).json({ status: "error", error: "Longitude out of range [-180, 180]" });
    } else {
      // Country stub – just acknowledge
      if (!aoi.name)
        return res.status(400).json({ status: "error", error: "country AOI requires 'name'" });
      return res.status(400).json({
        status: "error",
        error: "Country AOI is not yet implemented in Phase 1 – use bbox.",
      });
    }

    const { minLat, maxLat, minLon, maxLon } = aoi as Required<typeof aoi>;
    const utmCrs = centreUtmEpsg(minLat!, maxLat!, minLon!, maxLon!);
    const estimatedPixels = estimatePixels(minLat!, maxLat!, minLon!, maxLon!, resolution);
    const estimatedOutputSizeMB = estimateOutputSizeMB(estimatedPixels);

    // 3. Build payload for Python
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
    console.log(`[HF] Spawning ${script} for project ${code} at ${resolution}…`);

    // 4. Spawn Python, pass payload via stdin
    const py = spawn("python3", [script], {
      timeout: 30 * 60 * 1000, // 30 min hard cap
    });

    let stdout = "";
    let stderr = "";
    py.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    py.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    py.on("close", (code_: number | null) => {
      if (stderr.trim()) console.error("[HF Python stderr]", stderr.slice(0, 1000));

      const line = stdout.trim().split("\n").pop() ?? "";

      if (code_ !== 0 || !line.startsWith("OK:")) {
        const errMsg = line.startsWith("ERROR:")
          ? line.slice(6)
          : stderr.slice(0, 400) || `Python exited with code ${code_}`;
        console.error("[HF] Pipeline error:", errMsg);
        return res.status(500).json({ status: "error", error: errMsg });
      }

      // Line format: OK:CODE:RES:/abs/path/to/zip
      const parts = line.split(":");
      const zipPath = parts.slice(3).join(":"); // handle Windows drive letters

      return res.json({
        status: "ok",
        projectCode:           code,
        resolution,
        utmCrs,
        estimatedPixels,
        estimatedOutputSizeMB,
        outputs: {
          hfRaster:       `${code}_HF_hydroFavor.tif`,
          geologyNorm:    `${code}_HF_geologyPerm.tif`,
          soilNorm:       `${code}_HF_soilPerm.tif`,
          tcaRaw:         `${code}_HF_tca_raw.tif`,
          tcaNorm:        `${code}_HF_tca_norm.tif`,
          tcaRRZ:         `${code}_HF_tca_rrz.tif`,
          tcaNRZ:         `${code}_HF_tca_nrz.tif`,
          dem:            `${code}_HF_dem.tif`,
          weightsMatrix:  `${code}_HF_weights_matrix.csv`,
          metadata:       `${code}_HF_metadata.json`,
          zipName:        path.basename(zipPath),
          zipPath,
        },
      });
    });

    py.on("error", (err: Error) => {
      console.error("[HF] Failed to spawn Python:", err);
      return res.status(500).json({
        status: "error",
        error: `Failed to spawn HF pipeline: ${err.message}`,
      });
    });

    py.stdin.write(JSON.stringify(payload));
    py.stdin.end();
  });

  // ── GET /api/hf/download ──────────────────────────────────────────────────
  app.get("/api/hf/download", (req, res) => {
    const projectCode = (req.query.projectCode as string | undefined)?.toUpperCase();
    const resolution  = req.query.resolution  as string | undefined;

    if (!projectCode) {
      return res.status(400).json({ error: "projectCode query parameter is required" });
    }

    // Find matching zip in outputs directory
    let zipPath: string | undefined;
    if (resolution) {
      const candidate = path.join(OUTPUTS_DIR, `${projectCode}_HF_outputs_${resolution}.zip`);
      if (fs.existsSync(candidate)) zipPath = candidate;
    }

    if (!zipPath) {
      // Scan outputs dir for any matching zip
      try {
        const files = fs.readdirSync(OUTPUTS_DIR);
        const match = files
          .filter((f) => f.startsWith(`${projectCode}_HF_`) && f.endsWith(".zip"))
          .sort()
          .pop();
        if (match) zipPath = path.join(OUTPUTS_DIR, match);
      } catch {
        /* ignore */
      }
    }

    if (!zipPath || !fs.existsSync(zipPath)) {
      return res.status(404).json({
        error: `No HF outputs found for project ${projectCode}${resolution ? ` at ${resolution}` : ""}. Run /api/hf/run first.`,
      });
    }

    const filename = path.basename(zipPath);
    console.log(`[HF Download] Streaming ${filename}`);

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    const stream = fs.createReadStream(zipPath);
    stream.pipe(res);
    stream.on("error", (e: Error) => {
      console.error("[HF Download] Stream error:", e);
      res.destroy();
    });
  });

  // ── GET /api/hf/status ────────────────────────────────────────────────────
  // Returns list of completed project outputs
  app.get("/api/hf/status", (_req, res) => {
    try {
      const files = fs.existsSync(OUTPUTS_DIR) ? fs.readdirSync(OUTPUTS_DIR) : [];
      const zips = files.filter((f) => f.endsWith(".zip"));
      const projects = [...new Set(zips.map((z) => z.split("_")[0]))];
      res.json({ status: "ready", outputsDir: OUTPUTS_DIR, zips, projects });
    } catch (e: unknown) {
      const err = e as Error;
      res.status(500).json({ error: err.message });
    }
  });
}

/**
 * HFExplorer.tsx – Water Favorability Explorer · Phase 1 (HF v1)
 * ---------------------------------------------------------------
 * Mirrors the style and structure of the GRACE–TC–Geology Explorer page.
 * All backend comms go through /api/hf/run (POST) and /api/hf/download (GET).
 */

import React, { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { cn, formatNumber } from "@/lib/utils";
import { toast } from "@/components/ui/toaster";
import type { HfRunResponse } from "@shared/types";

// ─── Form schema ────────────────────────────────────────────────────────────

const formSchema = z.object({
  projectName: z.string().min(1, "Project name is required"),
  projectCode: z
    .string()
    .min(2, "2–4 letters")
    .max(4, "2–4 letters")
    .regex(/^[A-Za-z]+$/, "Letters only"),
  minLat: z.coerce.number().min(-90).max(90),
  maxLat: z.coerce.number().min(-90).max(90),
  minLon: z.coerce.number().min(-180).max(180),
  maxLon: z.coerce.number().min(-180).max(180),
  resolution: z.enum(["30m", "90m", "1km"]),
  wGeology: z.coerce.number().positive(),
  wSoil:    z.coerce.number().positive(),
  wTca:     z.coerce.number().positive(),
});

type FormValues = z.infer<typeof formSchema>;

const DEFAULT_VALUES: FormValues = {
  projectName: "Shabelle HF Test",
  projectCode: "SHB",
  minLat: -2.0,
  maxLat:  2.0,
  minLon: 42.0,
  maxLon: 46.0,
  resolution: "90m",
  wGeology: 1.0,
  wSoil:    1.0,
  wTca:     1.0,
};

// ─── Small UI primitives ────────────────────────────────────────────────────

function Label({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="block text-xs font-medium text-muted-foreground mb-1">
      {children}
    </label>
  );
}

function Input({
  id,
  className,
  error,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { id: string; error?: string }) {
  return (
    <div>
      <input
        id={id}
        className={cn(
          "w-full rounded-md border bg-input px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground",
          "focus:outline-none focus:ring-1 focus:ring-ring",
          error ? "border-destructive" : "border-border",
          className
        )}
        {...props}
      />
      {error && <p className="mt-0.5 text-xs text-destructive">{error}</p>}
    </div>
  );
}

function Select({
  id,
  children,
  className,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { id: string }) {
  return (
    <select
      id={id}
      className={cn(
        "w-full rounded-md border border-border bg-input px-3 py-1.5 text-sm text-foreground",
        "focus:outline-none focus:ring-1 focus:ring-ring",
        className
      )}
      {...props}
    >
      {children}
    </select>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3 mt-6 first:mt-0 border-b border-border pb-1">
      {children}
    </h3>
  );
}

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-lg border border-border bg-card p-4", className)}>
      {children}
    </div>
  );
}

function Badge({ children, variant = "default" }: { children: React.ReactNode; variant?: "default" | "success" | "error" | "warn" }) {
  const cls = {
    default: "bg-secondary text-secondary-foreground",
    success: "bg-green-900/50 text-green-300 border border-green-700",
    error:   "bg-red-900/50 text-red-300 border border-red-700",
    warn:    "bg-yellow-900/40 text-yellow-300 border border-yellow-700",
  }[variant];
  return (
    <span className={cn("inline-flex items-center rounded px-2 py-0.5 text-xs font-medium", cls)}>
      {children}
    </span>
  );
}

// ─── Result panel ─────────────────────────────────────────────────────────

function ResultPanel({
  result,
  onDownload,
  downloading,
}: {
  result: HfRunResponse;
  onDownload: () => void;
  downloading: boolean;
}) {
  if (result.status === "error") {
    return (
      <Card className="border-destructive/50">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-destructive font-semibold text-sm">Pipeline Error</span>
        </div>
        <pre className="text-xs text-muted-foreground whitespace-pre-wrap break-all">
          {result.error}
        </pre>
      </Card>
    );
  }

  const outputs = result.outputs!;

  return (
    <Card className="border-primary/30">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <span className="font-semibold text-sm text-foreground mr-2">{result.projectCode}</span>
          <Badge variant="success">HF v1 complete</Badge>
        </div>
        <button
          onClick={onDownload}
          disabled={downloading}
          className={cn(
            "rounded-md px-4 py-1.5 text-sm font-medium transition-colors",
            "bg-primary text-primary-foreground hover:bg-primary/80",
            "disabled:opacity-50 disabled:cursor-not-allowed"
          )}
        >
          {downloading ? "Downloading…" : "⬇ Download ZIP"}
        </button>
      </div>

      {/* Key metrics */}
      <div className="grid grid-cols-2 gap-3 mb-4 sm:grid-cols-4">
        {[
          { label: "Resolution",     value: result.resolution },
          { label: "UTM CRS",        value: result.utmCrs },
          { label: "Est. pixels",    value: result.estimatedPixels !== undefined ? formatNumber(result.estimatedPixels) : "—" },
          { label: "Est. output",    value: result.estimatedOutputSizeMB !== undefined ? `${result.estimatedOutputSizeMB} MB` : "—" },
        ].map(({ label, value }) => (
          <div key={label} className="rounded-md bg-secondary/40 px-3 py-2">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">{label}</p>
            <p className="font-mono text-sm text-foreground">{value}</p>
          </div>
        ))}
      </div>

      {/* Output file list */}
      <SectionHeader>Output files (in ZIP)</SectionHeader>
      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
        {Object.entries(outputs)
          .filter(([key]) => !["zipPath"].includes(key))
          .map(([key, value]) => (
            <div key={key} className="flex items-center gap-2 py-1 border-b border-border/40 last:border-0">
              <span className="text-[10px] uppercase text-muted-foreground w-28 shrink-0">{key}</span>
              <span className="font-mono text-xs text-foreground truncate">{value as string}</span>
            </div>
          ))}
      </div>
    </Card>
  );
}

// ─── Africa preset bounding boxes ─────────────────────────────────────────

const AFRICA_PRESETS: Array<{ label: string; minLat: number; maxLat: number; minLon: number; maxLon: number; code: string }> = [
  { label: "Shabelle Basin (Somalia)", minLat: -2,  maxLat: 6,  minLon: 41, maxLon: 46, code: "SHB" },
  { label: "Awash Valley (Ethiopia)",  minLat:  8,  maxLat: 12, minLon: 39, maxLon: 43, code: "AWV" },
  { label: "Blue Nile (Sudan)",        minLat: 11,  maxLat: 16, minLon: 31, maxLon: 36, code: "BNL" },
  { label: "Sahel (Niger)",            minLat: 13,  maxLat: 17, minLon:  3, maxLon:  9, code: "SAH" },
  { label: "Congo Basin (DRC)",        minLat: -5,  maxLat:  3, minLon: 17, maxLon: 25, code: "CON" },
];

// ─── Main component ─────────────────────────────────────────────────────────

export default function HFExplorer() {
  const [running,    setRunning]    = useState(false);
  const [result,     setResult]     = useState<HfRunResponse | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [logLines,   setLogLines]   = useState<string[]>([]);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: DEFAULT_VALUES });

  const selectedRes = watch("resolution");
  const projectCode = watch("projectCode");

  // ── Apply preset ──────────────────────────────────────────────────────────
  function applyPreset(p: typeof AFRICA_PRESETS[0]) {
    setValue("minLat", p.minLat);
    setValue("maxLat", p.maxLat);
    setValue("minLon", p.minLon);
    setValue("maxLon", p.maxLon);
    setValue("projectCode", p.code);
    setValue("projectName", p.label);
  }

  // ── Submit ────────────────────────────────────────────────────────────────
  async function onSubmit(values: FormValues) {
    setRunning(true);
    setResult(null);
    setLogLines([]);

    const addLog = (msg: string) => setLogLines((prev) => [...prev, msg]);
    addLog(`[${new Date().toLocaleTimeString()}] Starting HF v1 pipeline…`);
    addLog(`  Project: ${values.projectName} (${values.projectCode.toUpperCase()})`);
    addLog(`  AOI: [${values.minLat}, ${values.maxLat}, ${values.minLon}, ${values.maxLon}]`);
    addLog(`  Resolution: ${values.resolution}`);
    addLog(`  Weights: geo=${values.wGeology} soil=${values.wSoil} tca=${values.wTca}`);
    addLog("  Waiting for server…");

    try {
      const res = await fetch("/api/hf/run", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectName: values.projectName,
          projectCode: values.projectCode.toUpperCase(),
          aoi: {
            type:   "bbox",
            minLat: values.minLat,
            maxLat: values.maxLat,
            minLon: values.minLon,
            maxLon: values.maxLon,
          },
          resolution: values.resolution,
          weights: {
            geology: values.wGeology,
            soil:    values.wSoil,
            tca:     values.wTca,
          },
        }),
      });

      const data: HfRunResponse = await res.json();

      if (!res.ok || data.status === "error") {
        addLog(`[ERROR] ${data.error ?? "Unknown error"}`);
        toast({ title: "Pipeline failed", description: data.error, variant: "destructive" });
      } else {
        addLog(`[OK] HF pipeline complete → ${data.outputs?.zipName}`);
        toast({ title: "HF v1 complete", description: `${data.outputs?.zipName}` });
      }

      setResult(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog(`[ERROR] ${msg}`);
      setResult({ status: "error", error: msg });
      toast({ title: "Request failed", description: msg, variant: "destructive" });
    } finally {
      setRunning(false);
    }
  }

  // ── Download ──────────────────────────────────────────────────────────────
  async function handleDownload() {
    if (!result || result.status !== "ok") return;
    setDownloading(true);
    try {
      const params = new URLSearchParams({
        projectCode: result.projectCode!,
        resolution:  result.resolution!,
      });
      const res = await fetch(`/api/hf/download?${params}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Download failed" }));
        toast({ title: "Download failed", description: err.error, variant: "destructive" });
        return;
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = result.outputs!.zipName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      toast({ title: "Download error", description: String(err), variant: "destructive" });
    } finally {
      setDownloading(false);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Top bar */}
      <header className="border-b border-border bg-card/60 backdrop-blur sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden>
              <circle cx="11" cy="11" r="10" stroke="#1a7a4a" strokeWidth="1.5"/>
              <path d="M5 14 Q11 6 17 14" stroke="#1a7a4a" strokeWidth="1.5" fill="none"/>
            </svg>
            <span className="font-semibold text-sm tracking-tight text-foreground">
              Water Favorability Explorer
            </span>
            <Badge variant="warn">Phase 1 – HF v1</Badge>
          </div>
          <span className="text-xs text-muted-foreground hidden sm:block">
            Hydrogeologic Favorability · Africa MCDA
          </span>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-6">

        {/* ── LEFT PANEL: Form ─────────────────────────────────────────── */}
        <div>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-0">
            <Card>
              {/* Project */}
              <SectionHeader>Project</SectionHeader>
              <div className="space-y-3">
                <div>
                  <Label htmlFor="projectName">Project name</Label>
                  <Input
                    id="projectName"
                    placeholder="e.g. Shabelle HF Test"
                    error={errors.projectName?.message}
                    {...register("projectName")}
                  />
                </div>
                <div>
                  <Label htmlFor="projectCode">Project code (2–4 letters)</Label>
                  <Input
                    id="projectCode"
                    placeholder="e.g. SHB"
                    maxLength={4}
                    className="uppercase"
                    error={errors.projectCode?.message}
                    {...register("projectCode", {
                      setValueAs: (v: string) => v.toUpperCase(),
                    })}
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Used as prefix for all output file names.
                  </p>
                </div>
              </div>

              {/* Presets */}
              <SectionHeader>Africa presets</SectionHeader>
              <div className="flex flex-wrap gap-1.5">
                {AFRICA_PRESETS.map((p) => (
                  <button
                    key={p.code}
                    type="button"
                    onClick={() => applyPreset(p)}
                    className="rounded px-2 py-1 text-[11px] bg-secondary hover:bg-accent text-foreground transition-colors"
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              {/* AOI */}
              <SectionHeader>Area of Interest (bbox)</SectionHeader>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="minLat">Min latitude</Label>
                  <Input id="minLat" type="number" step="any" error={errors.minLat?.message} {...register("minLat")} />
                </div>
                <div>
                  <Label htmlFor="maxLat">Max latitude</Label>
                  <Input id="maxLat" type="number" step="any" error={errors.maxLat?.message} {...register("maxLat")} />
                </div>
                <div>
                  <Label htmlFor="minLon">Min longitude</Label>
                  <Input id="minLon" type="number" step="any" error={errors.minLon?.message} {...register("minLon")} />
                </div>
                <div>
                  <Label htmlFor="maxLon">Max longitude</Label>
                  <Input id="maxLon" type="number" step="any" error={errors.maxLon?.message} {...register("maxLon")} />
                </div>
              </div>

              {/* Resolution */}
              <SectionHeader>Resolution</SectionHeader>
              <Select id="resolution" {...register("resolution")}>
                <option value="30m">30 m (high detail, large files)</option>
                <option value="90m">90 m (recommended)</option>
                <option value="1km">1 km (fast, continental)</option>
              </Select>
              {selectedRes === "30m" && (
                <p className="mt-1.5 text-[11px] text-yellow-400/80">
                  ⚠ 30 m over large AOIs produces very large rasters. Confirm AOI is reasonably small.
                </p>
              )}

              {/* Weights */}
              <SectionHeader>Layer weights</SectionHeader>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label htmlFor="wGeology">Geology</Label>
                  <Input id="wGeology" type="number" step="0.1" min="0.01" error={errors.wGeology?.message} {...register("wGeology")} />
                </div>
                <div>
                  <Label htmlFor="wSoil">Soil</Label>
                  <Input id="wSoil" type="number" step="0.1" min="0.01" error={errors.wSoil?.message} {...register("wSoil")} />
                </div>
                <div>
                  <Label htmlFor="wTca">TCA</Label>
                  <Input id="wTca" type="number" step="0.1" min="0.01" error={errors.wTca?.message} {...register("wTca")} />
                </div>
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                HF = (w·G + w·S + w·TCA) / Σw — all default to 1.0 (equal weighting).
              </p>

              {/* Submit */}
              <div className="mt-5">
                <button
                  type="submit"
                  disabled={running}
                  className={cn(
                    "w-full rounded-md py-2.5 text-sm font-semibold transition-colors",
                    "bg-primary text-primary-foreground hover:bg-primary/80",
                    "disabled:opacity-50 disabled:cursor-not-allowed"
                  )}
                >
                  {running ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                      </svg>
                      Running HF pipeline…
                    </span>
                  ) : (
                    "▶ Run HF v1"
                  )}
                </button>
              </div>
            </Card>

            {/* HF formula reference */}
            <Card className="mt-4">
              <SectionHeader>HF v1 formula</SectionHeader>
              <div className="font-mono text-xs text-muted-foreground leading-relaxed space-y-1">
                <p className="text-foreground font-semibold">HF = (w_geo·G + w_soil·S + w_tca·TCA) / Σw</p>
                <p>G   = geology permeability (normalised 0–1)</p>
                <p>S   = soil permeability (normalised 0–1)</p>
                <p>TCA = log₁₀-normalised flow accumulation (0–1)</p>
                <p>RRZ = TCA ≥ P80  |  NRZ = P60 ≤ TCA &lt; P80</p>
              </div>
              <div className="mt-3 text-[11px] text-muted-foreground leading-relaxed">
                <p className="font-semibold text-foreground mb-1">Planned phases</p>
                <p>Phase 2 – RF (Recharge Favorability) via TerraClimate</p>
                <p>Phase 3 – WF = f(HF, RF) full water favorability</p>
              </div>
            </Card>
          </form>
        </div>

        {/* ── RIGHT PANEL: Log + Results ───────────────────────────────── */}
        <div className="space-y-4">
          {/* Log panel */}
          <Card>
            <SectionHeader>Run log</SectionHeader>
            {logLines.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">
                Fill in the form and click "Run HF v1" to start the pipeline.
              </p>
            ) : (
              <pre className="font-mono text-xs text-muted-foreground whitespace-pre-wrap max-h-48 overflow-y-auto leading-relaxed">
                {logLines.join("\n")}
                {running && "\n  …"}
              </pre>
            )}
          </Card>

          {/* Results */}
          {result && (
            <ResultPanel
              result={result}
              onDownload={handleDownload}
              downloading={downloading}
            />
          )}

          {/* Architecture note */}
          {!result && !running && (
            <Card className="opacity-70">
              <SectionHeader>Architecture</SectionHeader>
              <div className="text-xs text-muted-foreground space-y-2 leading-relaxed">
                <p>
                  <span className="text-foreground font-medium">Backend:</span>{" "}
                  Node/Express (TypeScript) → spawns <code className="font-mono">python/run_hf.py</code> via stdin/stdout.
                </p>
                <p>
                  <span className="text-foreground font-medium">Python pipeline:</span>{" "}
                  rasterio + numpy + pysheds/whitebox → DEM (Copernicus stub), geology/soil permeability, TCA/RRZ/NRZ, HF raster, ZIP export.
                </p>
                <p>
                  <span className="text-foreground font-medium">Data sources:</span>{" "}
                  Configure real geology/soil raster paths in <code className="font-mono">data/geology_config/data_sources.json</code>.
                  Leave empty to use synthetic layers (for pipeline testing).
                </p>
                <p>
                  <span className="text-foreground font-medium">Real DEM:</span>{" "}
                  Replace the Copernicus stub in <code className="font-mono">fetch_copernicus_dem()</code> with
                  GLO-30 tile downloads from AWS open-data.
                </p>
              </div>
            </Card>
          )}
        </div>
      </main>
    </div>
  );
}

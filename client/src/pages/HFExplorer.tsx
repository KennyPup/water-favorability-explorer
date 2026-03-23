/**
 * HFExplorer.tsx – Water Favorability Explorer · Phase 1 (HF v1)
 *
 * Map interaction and geology overlay mirrors the GRACE–TC–Geology Explorer:
 *   - Basemap: Esri World Topo (same as GRACE app)
 *   - Rectangle draw: two-click amber rectangle (same UX as GRACE app)
 *   - Geology: Macrostrat tile overlay + opacity slider (same as GRACE app)
 *   - AOI passed as minLat/maxLat/minLon/maxLon to /api/hf/run
 */

import React, { useEffect, useRef, useState, useCallback } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { cn, formatNumber } from "@/lib/utils";
import { toast } from "@/components/ui/toaster";
import type { HfRunResponse } from "@shared/types";

// Fix Leaflet default icon paths (same fix as GRACE app)
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon   from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({ iconRetinaUrl: markerIcon2x, iconUrl: markerIcon, shadowUrl: markerShadow });

// ─── Layout constants ────────────────────────────────────────────────────────
const LEFT_PANEL_W  = 300; // px – project/resolution/weights form
const RIGHT_PANEL_W = 280; // px – run summary + download
const HDR_H         = 48;  // px – top bar

// ─── Form schema (no AOI fields – derived from map) ──────────────────────────
const formSchema = z.object({
  projectName: z.string().min(1, "Required"),
  projectCode: z
    .string().min(2).max(4)
    .regex(/^[A-Za-z]+$/, "Letters only"),
  resolution: z.enum(["30m", "90m", "1km"]),
  wGeology: z.coerce.number().positive(),
  wSoil:    z.coerce.number().positive(),
  wTca:     z.coerce.number().positive(),
});
type FormValues = z.infer<typeof formSchema>;

const DEFAULT_VALUES: FormValues = {
  projectName: "Shabelle HF Test",
  projectCode: "SHB",
  resolution:  "90m",
  wGeology: 1.0,
  wSoil:    1.0,
  wTca:     1.0,
};

// ─── Africa presets ───────────────────────────────────────────────────────────
const AFRICA_PRESETS = [
  { label: "Shabelle (Somalia)", minLat: -2,  maxLat: 6,  minLon: 41, maxLon: 46, code: "SHB", center: [2,   43.5] as [number,number], zoom: 6 },
  { label: "Awash (Ethiopia)",   minLat:  8,  maxLat: 12, minLon: 39, maxLon: 43, code: "AWV", center: [10,  41]   as [number,number], zoom: 6 },
  { label: "Blue Nile (Sudan)",  minLat: 11,  maxLat: 16, minLon: 31, maxLon: 36, code: "BNL", center: [13.5,33.5] as [number,number], zoom: 6 },
  { label: "Sahel (Niger)",      minLat: 13,  maxLat: 17, minLon:  3, maxLon:  9, code: "SAH", center: [15,  6]    as [number,number], zoom: 6 },
  { label: "Congo (DRC)",        minLat: -5,  maxLat:  3, minLon: 17, maxLon: 25, code: "CON", center: [-1,  21]   as [number,number], zoom: 5 },
];

// ─── Small UI helpers ─────────────────────────────────────────────────────────
function Label({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return <label htmlFor={htmlFor} className="block text-[11px] font-medium text-muted-foreground mb-1">{children}</label>;
}

function Input({ id, className, error, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { id: string; error?: string }) {
  return (
    <div>
      <input
        id={id}
        className={cn(
          "w-full rounded border bg-input px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground",
          "focus:outline-none focus:ring-1 focus:ring-ring",
          error ? "border-destructive" : "border-border", className
        )}
        {...props}
      />
      {error && <p className="mt-0.5 text-[10px] text-destructive">{error}</p>}
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2 mt-4 first:mt-0 border-b border-border pb-1">{children}</h3>;
}

function Badge({ children, variant = "default" }: { children: React.ReactNode; variant?: "default"|"success"|"error"|"warn"|"blue" }) {
  const cls = { default: "bg-secondary text-secondary-foreground", success: "bg-green-900/60 text-green-300 border border-green-700", error: "bg-red-900/60 text-red-300 border border-red-700", warn: "bg-yellow-900/40 text-yellow-300 border border-yellow-700", blue: "bg-blue-900/50 text-blue-300 border border-blue-700" }[variant];
  return <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium", cls)}>{children}</span>;
}

// ─── Main component ──────────────────────────────────────────────────────────
export default function HFExplorer() {
  // Map refs
  const mapContainerRef  = useRef<HTMLDivElement>(null);
  const leafletMap       = useRef<L.Map | null>(null);
  const aoiLayerRef      = useRef<L.FeatureGroup | null>(null);
  const rectPreviewRef   = useRef<L.Rectangle | null>(null);
  const corner1Ref       = useRef<L.LatLng | null>(null);
  const corner1MarkerRef = useRef<L.CircleMarker | null>(null);
  const macroLayerRef    = useRef<L.TileLayer | null>(null);

  // Mutable draw-mode refs (avoid stale closure in map listeners)
  const drawModeRef = useRef<"rect">("rect");
  const rectStepRef = useRef<0|1>(0);

  // UI state
  const [rectStep,    setRectStep]    = useState<0|1>(0);
  const [geoOpacity,  setGeoOpacity]  = useState(45);
  const [aoi, setAoi] = useState<{ minLat:number; maxLat:number; minLon:number; maxLon:number } | null>(null);
  const [running,     setRunning]     = useState(false);
  const [runStatus,   setRunStatus]   = useState<"idle"|"running"|"success"|"error">("idle");
  const [result,      setResult]      = useState<HfRunResponse | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });

  const { register, handleSubmit, setValue, watch, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: DEFAULT_VALUES,
  });
  const selectedRes = watch("resolution");

  // Responsive size tracking
  useEffect(() => {
    const update = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const mapW = size.w - LEFT_PANEL_W - RIGHT_PANEL_W;
  const mapH = size.h - HDR_H;

  // ── Cancel rectangle helper ───────────────────────────────────────────────
  const cancelRect = useCallback(() => {
    corner1Ref.current  = null;
    rectStepRef.current = 0;
    setRectStep(0);
    if (leafletMap.current) {
      if (rectPreviewRef.current)   { leafletMap.current.removeLayer(rectPreviewRef.current);   rectPreviewRef.current   = null; }
      if (corner1MarkerRef.current) { leafletMap.current.removeLayer(corner1MarkerRef.current); corner1MarkerRef.current = null; }
    }
  }, []);

  // ── Map initialisation ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapContainerRef.current || leafletMap.current) return;

    const map = L.map(mapContainerRef.current, {
      center: [5, 30],   // Africa-centred
      zoom:   4,
      zoomControl: true,
    });

    // Basemap – Esri World Topo (same as GRACE app)
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
      {
        attribution: 'Tiles &copy; <a href="https://www.esri.com">Esri</a>',
        maxZoom: 19,
      }
    ).addTo(map);

    // AOI persistent layer
    aoiLayerRef.current = L.featureGroup().addTo(map);

    // ── Mouse-move: live rectangle preview ──────────────────────────────────
    map.on("mousemove", (e: L.LeafletMouseEvent) => {
      if (rectStepRef.current !== 1 || !corner1Ref.current) return;
      const c1 = corner1Ref.current;
      const c2 = e.latlng;
      const bounds: L.LatLngBoundsExpression = [
        [Math.min(c1.lat, c2.lat), Math.min(c1.lng, c2.lng)],
        [Math.max(c1.lat, c2.lat), Math.max(c1.lng, c2.lng)],
      ];
      if (rectPreviewRef.current) {
        rectPreviewRef.current.setBounds(bounds);
      } else {
        rectPreviewRef.current = L.rectangle(bounds, {
          color:       "#f59e0b",
          weight:       2,
          dashArray:   "6 3",
          fill:         true,
          fillColor:   "#f59e0b",
          fillOpacity:  0.08,
          interactive:  false,
        }).addTo(map);
      }
    });

    // ── Click: first corner → second corner → commit AOI ─────────────────
    map.on("click", (e: L.LeafletMouseEvent) => {
      const { lat, lng } = e.latlng;

      if (rectStepRef.current === 0) {
        // First corner
        corner1Ref.current  = e.latlng;
        rectStepRef.current = 1;
        setRectStep(1);
        if (corner1MarkerRef.current) map.removeLayer(corner1MarkerRef.current);
        corner1MarkerRef.current = L.circleMarker([lat, lng], {
          radius: 5, color: "#f59e0b", fillColor: "#f59e0b",
          fillOpacity: 1, weight: 2, interactive: false,
        }).addTo(map);
      } else {
        // Second corner – commit AOI
        const c1     = corner1Ref.current!;
        const minLat = Math.min(c1.lat, lat);
        const maxLat = Math.max(c1.lat, lat);
        const minLon = Math.min(c1.lng, lng);
        const maxLon = Math.max(c1.lng, lng);

        // Clean up preview
        if (rectPreviewRef.current)   { map.removeLayer(rectPreviewRef.current);   rectPreviewRef.current   = null; }
        if (corner1MarkerRef.current) { map.removeLayer(corner1MarkerRef.current); corner1MarkerRef.current = null; }
        corner1Ref.current  = null;
        rectStepRef.current = 0;
        setRectStep(0);

        // Draw persistent AOI outline
        if (aoiLayerRef.current) {
          aoiLayerRef.current.clearLayers();
          L.rectangle(
            [[minLat, minLon], [maxLat, maxLon]],
            { color: "#22d3ee", weight: 2, fill: true, fillColor: "#22d3ee", fillOpacity: 0.06, interactive: false }
          ).addTo(aoiLayerRef.current);
          // Label
          L.marker([(minLat + maxLat) / 2, (minLon + maxLon) / 2], {
            icon: L.divIcon({
              className: "",
              html: `<div style="background:rgba(0,0,0,0.55);color:#22d3ee;font-size:10px;padding:2px 5px;border-radius:3px;white-space:nowrap;border:1px solid #22d3ee55">AOI</div>`,
              iconAnchor: [16, 8],
            }),
            interactive: false,
          }).addTo(aoiLayerRef.current);
        }

        setAoi({ minLat, maxLat, minLon, maxLon });
      }
    });

    // Escape cancels rectangle mid-draw
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") cancelRect(); };
    window.addEventListener("keydown", onKey);

    leafletMap.current = map;
    return () => {
      window.removeEventListener("keydown", onKey);
      map.remove();
      leafletMap.current = null;
    };
  }, [cancelRect]);

  // ── Macrostrat geology overlay + opacity slider ────────────────────────────
  useEffect(() => {
    if (!leafletMap.current) return;
    if (geoOpacity === 0) {
      if (macroLayerRef.current) {
        leafletMap.current.removeLayer(macroLayerRef.current);
        macroLayerRef.current = null;
      }
    } else {
      if (!macroLayerRef.current) {
        macroLayerRef.current = L.tileLayer(
          "https://tiles.macrostrat.org/cartodb/{z}/{x}/{y}.png",
          {
            opacity:     geoOpacity / 100,
            maxZoom:     19,
            attribution: 'Geology © <a href="https://macrostrat.org">Macrostrat</a>',
          }
        );
        macroLayerRef.current.addTo(leafletMap.current);
        macroLayerRef.current.setZIndex(200);
        if (aoiLayerRef.current) aoiLayerRef.current.bringToFront();
      } else {
        macroLayerRef.current.setOpacity(geoOpacity / 100);
      }
    }
  }, [geoOpacity]);

  // ── Apply preset: fly map + draw AOI + set form fields ──────────────────────
  function applyPreset(p: typeof AFRICA_PRESETS[0]) {
    setValue("projectCode", p.code);
    setValue("projectName", p.label);
    cancelRect();

    if (leafletMap.current) {
      leafletMap.current.flyTo(p.center, p.zoom, { duration: 1 });
    }

    const { minLat, maxLat, minLon, maxLon } = p;
    setAoi({ minLat, maxLat, minLon, maxLon });

    if (aoiLayerRef.current) {
      aoiLayerRef.current.clearLayers();
      L.rectangle(
        [[minLat, minLon], [maxLat, maxLon]],
        { color: "#22d3ee", weight: 2, fill: true, fillColor: "#22d3ee", fillOpacity: 0.06, interactive: false }
      ).addTo(aoiLayerRef.current);
    }
  }

  // ── Run HF pipeline ──────────────────────────────────────────────────────
  async function onSubmit(values: FormValues) {
    if (!aoi) {
      toast({ title: "No AOI", description: "Draw a rectangle on the map first.", variant: "destructive" });
      return;
    }
    setRunning(true);
    setRunStatus("running");
    setResult(null);

    try {
      const res = await fetch("/api/hf/run", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectName: values.projectName,
          projectCode: values.projectCode.toUpperCase(),
          aoi:         { type: "bbox", ...aoi },
          resolution:  values.resolution,
          weights:     { geology: values.wGeology, soil: values.wSoil, tca: values.wTca },
        }),
      });
      const data: HfRunResponse = await res.json();

      if (!res.ok || data.status === "error") {
        setRunStatus("error");
        toast({ title: "Pipeline failed", description: data.error, variant: "destructive" });
      } else {
        setRunStatus("success");
        toast({ title: "HF v1 complete", description: data.outputs?.zipName });
      }
      setResult(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setRunStatus("error");
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
      const params = new URLSearchParams({ projectCode: result.projectCode!, resolution: result.resolution! });
      const res = await fetch(`/api/hf/download?${params}`);
      if (!res.ok) {
        const e = await res.json().catch(() => ({ error: "Download failed" }));
        toast({ title: "Download failed", description: e.error, variant: "destructive" });
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
    <div className="flex flex-col bg-background text-foreground" style={{ height: "100dvh", overflow: "hidden" }}>

      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <header
        className="flex items-center justify-between px-4 border-b border-border bg-card/70 backdrop-blur shrink-0"
        style={{ height: HDR_H }}
      >
        <div className="flex items-center gap-2.5">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
            <circle cx="10" cy="10" r="9" stroke="#1a7a4a" strokeWidth="1.5"/>
            <path d="M4 13 Q10 5 16 13" stroke="#1a7a4a" strokeWidth="1.5" fill="none"/>
          </svg>
          <span className="font-semibold text-sm">Water Favorability Explorer</span>
          <Badge variant="warn">HF v1</Badge>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {aoi ? (
            <span className="font-mono">
              [{aoi.minLat.toFixed(2)}, {aoi.maxLat.toFixed(2)}, {aoi.minLon.toFixed(2)}, {aoi.maxLon.toFixed(2)}]
            </span>
          ) : (
            <span className="italic">Click map to draw AOI rectangle</span>
          )}
        </div>
      </header>

      {/* ── Body row ─────────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden" style={{ height: mapH }}>

        {/* ── LEFT PANEL: Project form ────────────────────────────────── */}
        <div
          className="flex flex-col overflow-y-auto border-r border-border bg-card shrink-0"
          style={{ width: LEFT_PANEL_W }}
        >
          <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col flex-1 p-3">

            <SectionHeader>Project</SectionHeader>
            <div className="space-y-2">
              <div>
                <Label htmlFor="projectName">Name</Label>
                <Input id="projectName" placeholder="e.g. Shabelle HF Test" error={errors.projectName?.message} {...register("projectName")} />
              </div>
              <div>
                <Label htmlFor="projectCode">Code (2–4 letters)</Label>
                <Input id="projectCode" placeholder="SHB" maxLength={4} className="uppercase" error={errors.projectCode?.message}
                  {...register("projectCode", { setValueAs: (v: string) => v.toUpperCase() })} />
              </div>
            </div>

            <SectionHeader>Presets</SectionHeader>
            <div className="flex flex-col gap-1">
              {AFRICA_PRESETS.map((p) => (
                <button key={p.code} type="button" onClick={() => applyPreset(p)}
                  className="text-left rounded px-2 py-1 text-xs bg-secondary hover:bg-accent text-foreground transition-colors">
                  {p.label}
                </button>
              ))}
            </div>

            <SectionHeader>AOI</SectionHeader>
            <div className={cn(
              "rounded border p-2 text-xs",
              aoi ? "border-[#22d3ee]/40 bg-[#22d3ee]/5" : "border-border bg-secondary/30"
            )}>
              {aoi ? (
                <div className="space-y-0.5 font-mono text-[11px] text-foreground">
                  <div className="flex justify-between"><span className="text-muted-foreground">minLat</span><span>{aoi.minLat.toFixed(4)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">maxLat</span><span>{aoi.maxLat.toFixed(4)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">minLon</span><span>{aoi.minLon.toFixed(4)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">maxLon</span><span>{aoi.maxLon.toFixed(4)}</span></div>
                  <button type="button" onClick={() => { setAoi(null); aoiLayerRef.current?.clearLayers(); }}
                    className="mt-1 text-[10px] text-muted-foreground hover:text-destructive underline">
                    Clear AOI
                  </button>
                </div>
              ) : (
                <p className="text-muted-foreground italic text-center py-1">
                  {rectStep === 0 ? "Click map: first corner" : "Click map: second corner"}
                </p>
              )}
            </div>

            <SectionHeader>Resolution</SectionHeader>
            <select id="resolution" {...register("resolution")}
              className="w-full rounded border border-border bg-input px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring">
              <option value="30m">30 m – high detail</option>
              <option value="90m">90 m – recommended</option>
              <option value="1km">1 km – fast/continental</option>
            </select>
            {selectedRes === "30m" && (
              <p className="mt-1 text-[10px] text-yellow-400/80">⚠ 30 m over large AOIs = very large files</p>
            )}

            <SectionHeader>Weights</SectionHeader>
            <div className="grid grid-cols-3 gap-1.5">
              {(["wGeology","wSoil","wTca"] as const).map((k, i) => (
                <div key={k}>
                  <Label htmlFor={k}>{["Geo","Soil","TCA"][i]}</Label>
                  <Input id={k} type="number" step="0.1" min="0.01" error={errors[k]?.message} {...register(k)} />
                </div>
              ))}
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">HF = (w·G + w·S + w·TCA) / Σw</p>

            <div className="mt-auto pt-4">
              <button type="submit" disabled={running || !aoi}
                className={cn(
                  "w-full rounded py-2 text-sm font-semibold transition-colors",
                  "bg-primary text-primary-foreground hover:bg-primary/80",
                  "disabled:opacity-50 disabled:cursor-not-allowed"
                )}>
                {running ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                    </svg>
                    Running…
                  </span>
                ) : "▶ Run HF v1"}
              </button>
              {!aoi && <p className="text-center text-[10px] text-muted-foreground mt-1">Draw AOI on map first</p>}
            </div>
          </form>
        </div>

        {/* ── MAP ──────────────────────────────────────────────────────── */}
        <div className="relative flex-1 overflow-hidden">
          <div ref={mapContainerRef} style={{ width: "100%", height: "100%" }} />

          {/* Geology opacity slider – bottom-left of map, same style as GRACE app */}
          <div className="absolute bottom-4 left-3 z-[999] flex items-center gap-2 bg-black/60 backdrop-blur rounded px-3 py-1.5 text-xs text-white">
            <span className="text-[10px] uppercase tracking-wider text-white/70">Geology</span>
            <input
              type="range" min={0} max={100} step={5}
              value={geoOpacity}
              onChange={(e) => setGeoOpacity(Number(e.target.value))}
              style={{ width: 80, accentColor: "#a78bfa", cursor: "pointer" }}
              title={`Geology overlay opacity: ${geoOpacity}%`}
            />
            <span className="w-7 text-right text-[10px] text-white/70">{geoOpacity}%</span>
          </div>

          {/* Draw instruction overlay */}
          {rectStep === 1 && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[999] bg-black/70 text-amber-300 text-xs px-3 py-1.5 rounded pointer-events-none">
              Click second corner to finish AOI · Esc to cancel
            </div>
          )}
          {!aoi && rectStep === 0 && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[999] bg-black/60 text-white/80 text-xs px-3 py-1.5 rounded pointer-events-none">
              Click map to start drawing AOI rectangle
            </div>
          )}
        </div>

        {/* ── RIGHT PANEL: Run summary ──────────────────────────────── */}
        <div
          className="flex flex-col overflow-y-auto border-l border-border bg-card shrink-0 p-3"
          style={{ width: RIGHT_PANEL_W }}
        >
          <SectionHeader>Run status</SectionHeader>

          {/* Status badge */}
          <div className="flex items-center gap-2 mb-3">
            <Badge variant={
              runStatus === "success" ? "success" :
              runStatus === "error"   ? "error" :
              runStatus === "running" ? "blue" : "default"
            }>
              {{ idle: "Idle", running: "Running…", success: "Complete", error: "Error" }[runStatus]}
            </Badge>
            {result?.projectCode && <span className="font-mono text-xs text-foreground">{result.projectCode}</span>}
          </div>

          {/* UTM CRS — shown prominently once run completes */}
          {result?.utmCrs && (
            <div className="rounded border border-[#22d3ee]/30 bg-[#22d3ee]/5 px-3 py-2 mb-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">UTM CRS</p>
              <p className="font-mono text-sm font-semibold text-[#22d3ee]">{result.utmCrs}</p>
            </div>
          )}

          {/* Metrics */}
          {result?.status === "ok" && (
            <div className="space-y-2 mb-3">
              {[
                { label: "Resolution",   value: result.resolution },
                { label: "Est. pixels",  value: result.estimatedPixels !== undefined ? formatNumber(result.estimatedPixels) : "—" },
                { label: "Est. output",  value: result.estimatedOutputSizeMB !== undefined ? `${result.estimatedOutputSizeMB} MB` : "—" },
              ].map(({ label, value }) => (
                <div key={label} className="flex justify-between items-center text-xs border-b border-border/40 pb-1">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="font-mono text-foreground">{value}</span>
                </div>
              ))}
            </div>
          )}

          {/* Error message */}
          {result?.status === "error" && (
            <div className="rounded border border-destructive/40 bg-destructive/10 px-2 py-2 mb-3">
              <p className="text-xs text-destructive">{result.error}</p>
            </div>
          )}

          {/* Download button */}
          {result?.status === "ok" && (
            <button onClick={handleDownload} disabled={downloading}
              className={cn(
                "w-full rounded py-2 text-sm font-semibold transition-colors mb-3",
                "bg-primary text-primary-foreground hover:bg-primary/80",
                "disabled:opacity-50 disabled:cursor-not-allowed"
              )}>
              {downloading ? "Downloading…" : "⬇ Download ZIP"}
            </button>
          )}

          {/* Output files list */}
          {result?.status === "ok" && result.outputs && (
            <>
              <SectionHeader>Output files</SectionHeader>
              <div className="space-y-0.5">
                {Object.entries(result.outputs)
                  .filter(([k]) => !["zipPath"].includes(k))
                  .map(([key, value]) => (
                    <div key={key} className="flex flex-col py-0.5 border-b border-border/30">
                      <span className="text-[9px] uppercase text-muted-foreground">{key}</span>
                      <span className="font-mono text-[10px] text-foreground truncate">{value as string}</span>
                    </div>
                  ))}
              </div>
            </>
          )}

          {/* Idle hint */}
          {runStatus === "idle" && (
            <div className="text-[11px] text-muted-foreground space-y-2 mt-2">
              <p>1. Draw a rectangle on the map to define your AOI.</p>
              <p>2. Set project name, code, and resolution.</p>
              <p>3. Click <strong className="text-foreground">Run HF v1</strong>.</p>
              <p>4. Download the ZIP with all GeoTIFFs and metadata.</p>
              <p className="mt-3 pt-2 border-t border-border/40">
                Geology overlay (Macrostrat) is for visual context only.<br/>
                HF geology permeability comes from the Python pipeline.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

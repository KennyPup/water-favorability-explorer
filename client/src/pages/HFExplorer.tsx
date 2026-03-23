/**
 * HFExplorer.tsx – Water Favorability Explorer · Phase 1 (HF v1)
 *
 * Map patterns mirror GRACE–TC–Geology Explorer:
 *   - Basemap:  Esri World Topo
 *   - Geology:  Macrostrat tile overlay + opacity slider
 *   - AOI:      Two-click amber rectangle (same UX as GRACE)
 *   - HF layer: L.imageOverlay PNG from /api/hf/preview + opacity slider
 */

import React, { useEffect, useRef, useState, useCallback } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { cn, formatNumber } from "@/lib/utils";
import { toast } from "@/components/ui/toaster";
import type { HfRunResponse, HfLayerUrls } from "@shared/types";

// Fix Leaflet default marker icons
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon   from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({ iconRetinaUrl: markerIcon2x, iconUrl: markerIcon, shadowUrl: markerShadow });

// ─── Layout ──────────────────────────────────────────────────────────────────
const LEFT_W  = 268;
const RIGHT_W = 272;
const HDR_H   = 46;

// ─── Layer labels for the downloads panel ────────────────────────────────────
const LAYER_LABELS: Array<{ key: keyof HfLayerUrls; label: string; ext: string }> = [
  { key: "hf",       label: "HF raster (hydroFavor)",     ext: ".tif" },
  { key: "geology",  label: "Geology permeability",        ext: ".tif" },
  { key: "soil",     label: "Soil permeability",           ext: ".tif" },
  { key: "tca_raw",  label: "TCA – raw flow accum.",       ext: ".tif" },
  { key: "tca_norm", label: "TCA – log-normalised",        ext: ".tif" },
  { key: "rrz",      label: "RRZ (TCA ≥ P80)",            ext: ".tif" },
  { key: "nrz",      label: "NRZ (P60 ≤ TCA < P80)",     ext: ".tif" },
  { key: "dem",      label: "DEM (Copernicus stub)",       ext: ".tif" },
  { key: "weights",  label: "Weights matrix",              ext: ".csv" },
  { key: "metadata", label: "Run metadata",                ext: ".json" },
];

// ─── Form schema ──────────────────────────────────────────────────────────────
const formSchema = z.object({
  projectName: z.string().min(1, "Required"),
  projectCode: z.string().min(2).max(4).regex(/^[A-Za-z]+$/, "Letters only"),
  resolution:  z.enum(["30m", "90m", "1km"]),
  wGeology:    z.coerce.number().positive(),
  wSoil:       z.coerce.number().positive(),
  wTca:        z.coerce.number().positive(),
});
type FormValues = z.infer<typeof formSchema>;

// ─── Small UI helpers ─────────────────────────────────────────────────────────
function Label({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return <label htmlFor={htmlFor} className="block text-[11px] font-medium text-muted-foreground mb-0.5">{children}</label>;
}
function FInput({ id, error, className, ...p }: React.InputHTMLAttributes<HTMLInputElement> & { id: string; error?: string }) {
  return (
    <div>
      <input id={id} className={cn("w-full rounded border bg-input px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring", error ? "border-destructive" : "border-border", className)} {...p} />
      {error && <p className="mt-0.5 text-[10px] text-destructive">{error}</p>}
    </div>
  );
}
function SecHead({ children }: { children: React.ReactNode }) {
  return <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 mt-3.5 first:mt-0 border-b border-border pb-0.5">{children}</h3>;
}
function Pill({ children, v = "default" }: { children: React.ReactNode; v?: "default"|"ok"|"err"|"run"|"blue" }) {
  const c = { default: "bg-secondary text-secondary-foreground", ok: "bg-green-900/60 text-green-300 border border-green-700", err: "bg-red-900/60 text-red-300 border border-red-700", run: "bg-blue-900/50 text-blue-300 border border-blue-700", blue: "bg-blue-900/40 text-blue-200 border border-blue-700" }[v];
  return <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium", c)}>{children}</span>;
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function HFExplorer() {
  // Map refs
  const mapRef           = useRef<HTMLDivElement>(null);
  const leafletMap       = useRef<L.Map | null>(null);
  const aoiLayerRef      = useRef<L.FeatureGroup | null>(null);
  const rectPreviewRef   = useRef<L.Rectangle | null>(null);
  const corner1Ref       = useRef<L.LatLng | null>(null);
  const corner1MarkerRef = useRef<L.CircleMarker | null>(null);
  const macroLayerRef    = useRef<L.TileLayer | null>(null);
  const hfOverlayRef     = useRef<L.ImageOverlay | null>(null);
  const rectStepRef      = useRef<0|1>(0);

  // UI state
  const [rectStep,    setRectStep]    = useState<0|1>(0);
  const [geoOpacity,  setGeoOpacity]  = useState(40);
  const [hfOpacity,   setHfOpacity]   = useState(70);
  const [aoi, setAoi]   = useState<{ minLat:number; maxLat:number; minLon:number; maxLon:number }|null>(null);
  const [running,     setRunning]     = useState(false);
  const [runStatus,   setRunStatus]   = useState<"idle"|"running"|"ok"|"err">("idle");
  const [result,      setResult]      = useState<HfRunResponse|null>(null);
  const [downloading, setDownloading] = useState(false);
  const [hfLoading,   setHfLoading]   = useState(false);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });

  const { register, handleSubmit, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { projectName: "HF Run", projectCode: "HF1", resolution: "90m", wGeology: 1, wSoil: 1, wTca: 1 },
  });

  useEffect(() => {
    const u = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", u);
    return () => window.removeEventListener("resize", u);
  }, []);

  const mapH = size.h - HDR_H;

  // ── Cancel rect ───────────────────────────────────────────────────────────
  const cancelRect = useCallback(() => {
    corner1Ref.current  = null;
    rectStepRef.current = 0;
    setRectStep(0);
    if (leafletMap.current) {
      if (rectPreviewRef.current)   { leafletMap.current.removeLayer(rectPreviewRef.current);   rectPreviewRef.current   = null; }
      if (corner1MarkerRef.current) { leafletMap.current.removeLayer(corner1MarkerRef.current); corner1MarkerRef.current = null; }
    }
  }, []);

  // ── Leaflet init ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || leafletMap.current) return;

    const map = L.map(mapRef.current, { center: [5, 25], zoom: 4, zoomControl: true });

    // Esri World Topo basemap – same as GRACE app
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
      { attribution: 'Tiles &copy; <a href="https://www.esri.com">Esri</a>', maxZoom: 19 }
    ).addTo(map);

    aoiLayerRef.current = L.featureGroup().addTo(map);

    // Mouse-move: live rect preview
    map.on("mousemove", (e: L.LeafletMouseEvent) => {
      if (rectStepRef.current !== 1 || !corner1Ref.current) return;
      const c1 = corner1Ref.current, c2 = e.latlng;
      const bounds: L.LatLngBoundsExpression = [
        [Math.min(c1.lat, c2.lat), Math.min(c1.lng, c2.lng)],
        [Math.max(c1.lat, c2.lat), Math.max(c1.lng, c2.lng)],
      ];
      if (rectPreviewRef.current) {
        rectPreviewRef.current.setBounds(bounds);
      } else {
        rectPreviewRef.current = L.rectangle(bounds, {
          color: "#f59e0b", weight: 2, dashArray: "6 3",
          fill: true, fillColor: "#f59e0b", fillOpacity: 0.08, interactive: false,
        }).addTo(map);
      }
    });

    // Click: first/second corner
    map.on("click", (e: L.LeafletMouseEvent) => {
      const { lat, lng } = e.latlng;
      if (rectStepRef.current === 0) {
        corner1Ref.current  = e.latlng;
        rectStepRef.current = 1;
        setRectStep(1);
        if (corner1MarkerRef.current) map.removeLayer(corner1MarkerRef.current);
        corner1MarkerRef.current = L.circleMarker([lat, lng], {
          radius: 5, color: "#f59e0b", fillColor: "#f59e0b", fillOpacity: 1, weight: 2, interactive: false,
        }).addTo(map);
      } else {
        const c1 = corner1Ref.current!;
        const minLat = Math.min(c1.lat, lat), maxLat = Math.max(c1.lat, lat);
        const minLon = Math.min(c1.lng, lng), maxLon = Math.max(c1.lng, lng);

        if (rectPreviewRef.current)   { map.removeLayer(rectPreviewRef.current);   rectPreviewRef.current   = null; }
        if (corner1MarkerRef.current) { map.removeLayer(corner1MarkerRef.current); corner1MarkerRef.current = null; }
        corner1Ref.current  = null;
        rectStepRef.current = 0;
        setRectStep(0);

        // Persistent cyan AOI outline
        if (aoiLayerRef.current) {
          aoiLayerRef.current.clearLayers();
          L.rectangle([[minLat, minLon], [maxLat, maxLon]], {
            color: "#22d3ee", weight: 2, fill: true, fillColor: "#22d3ee", fillOpacity: 0.05, interactive: false,
          }).addTo(aoiLayerRef.current);
        }
        setAoi({ minLat, maxLat, minLon, maxLon });
      }
    });

    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") cancelRect(); };
    window.addEventListener("keydown", onKey);
    leafletMap.current = map;

    return () => {
      window.removeEventListener("keydown", onKey);
      map.remove();
      leafletMap.current = null;
    };
  }, [cancelRect]);

  // ── Macrostrat geology overlay ────────────────────────────────────────────
  useEffect(() => {
    if (!leafletMap.current) return;
    if (geoOpacity === 0) {
      if (macroLayerRef.current) { leafletMap.current.removeLayer(macroLayerRef.current); macroLayerRef.current = null; }
    } else {
      if (!macroLayerRef.current) {
        macroLayerRef.current = L.tileLayer("https://tiles.macrostrat.org/cartodb/{z}/{x}/{y}.png", {
          opacity: geoOpacity / 100, maxZoom: 19,
          attribution: 'Geology © <a href="https://macrostrat.org">Macrostrat</a>',
        }).addTo(leafletMap.current);
        macroLayerRef.current.setZIndex(200);
        aoiLayerRef.current?.bringToFront();
        if (hfOverlayRef.current) hfOverlayRef.current.bringToFront();
      } else {
        macroLayerRef.current.setOpacity(geoOpacity / 100);
      }
    }
  }, [geoOpacity]);

  // ── HF overlay opacity ────────────────────────────────────────────────────
  useEffect(() => {
    if (hfOverlayRef.current) hfOverlayRef.current.setOpacity(hfOpacity / 100);
  }, [hfOpacity]);

  // ── Load HF preview overlay onto map ─────────────────────────────────────
  const loadHfOverlay = useCallback(async (projectCode: string, resolution: string) => {
    if (!leafletMap.current) return;
    setHfLoading(true);
    try {
      const res = await fetch(`/api/hf/preview?projectCode=${projectCode}&resolution=${resolution}`);
      if (!res.ok) { toast({ title: "Preview unavailable", variant: "destructive" }); return; }
      const data = await res.json();
      const { pngUrl, bounds } = data;
      if (!pngUrl || !bounds) return;

      // Remove old overlay
      if (hfOverlayRef.current) { leafletMap.current.removeLayer(hfOverlayRef.current); hfOverlayRef.current = null; }

      const leafletBounds: L.LatLngBoundsExpression = [
        [bounds.minLat, bounds.minLon],
        [bounds.maxLat, bounds.maxLon],
      ];
      hfOverlayRef.current = L.imageOverlay(pngUrl, leafletBounds, {
        opacity: hfOpacity / 100,
        interactive: false,
        zIndex: 400,
      }).addTo(leafletMap.current);
      hfOverlayRef.current.bringToFront();
      aoiLayerRef.current?.bringToFront();

      toast({ title: "HF overlay loaded on map" });
    } catch (e: unknown) {
      toast({ title: "HF overlay error", description: String(e), variant: "destructive" });
    } finally {
      setHfLoading(false);
    }
  }, [hfOpacity]);

  // ── Run HF pipeline ───────────────────────────────────────────────────────
  async function onSubmit(values: FormValues) {
    if (!aoi) { toast({ title: "No AOI", description: "Draw a rectangle on the map first.", variant: "destructive" }); return; }
    setRunning(true);
    setRunStatus("running");
    setResult(null);

    // Remove previous HF overlay
    if (hfOverlayRef.current && leafletMap.current) {
      leafletMap.current.removeLayer(hfOverlayRef.current);
      hfOverlayRef.current = null;
    }

    try {
      const res = await fetch("/api/hf/run", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectName: values.projectName,
          projectCode: values.projectCode.toUpperCase(),
          aoi: { type: "bbox", ...aoi },
          resolution: values.resolution,
          weights: { geology: values.wGeology, soil: values.wSoil, tca: values.wTca },
        }),
      });
      const data: HfRunResponse = await res.json();

      if (!res.ok || data.status === "error") {
        setRunStatus("err");
        toast({ title: "Pipeline failed", description: data.error, variant: "destructive" });
      } else {
        setRunStatus("ok");
        toast({ title: "HF v1 complete", description: data.outputs?.zipName });
        // Auto-load HF preview onto map
        await loadHfOverlay(data.projectCode!, data.resolution!);
      }
      setResult(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setRunStatus("err");
      setResult({ status: "error", error: msg });
      toast({ title: "Request failed", description: msg, variant: "destructive" });
    } finally {
      setRunning(false);
    }
  }

  // ── Download ZIP ──────────────────────────────────────────────────────────
  async function handleDownloadZip() {
    if (!result || result.status !== "ok") return;
    setDownloading(true);
    try {
      const params = new URLSearchParams({ projectCode: result.projectCode!, resolution: result.resolution! });
      const res = await fetch(`/api/hf/download?${params}`);
      if (!res.ok) { toast({ title: "Download failed", variant: "destructive" }); return; }
      const blob = await res.blob();
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: result.outputs!.zipName });
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e: unknown) { toast({ title: "Download error", description: String(e), variant: "destructive" }); }
    finally { setDownloading(false); }
  }

  // ── Download individual layer ─────────────────────────────────────────────
  function downloadLayer(url: string, label: string) {
    const a = document.createElement("a");
    a.href = url;
    a.click();
  }

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col bg-background text-foreground" style={{ height: "100dvh", overflow: "hidden" }}>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between px-4 border-b border-border bg-card/70 backdrop-blur shrink-0" style={{ height: HDR_H }}>
        <div className="flex items-center gap-2.5">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <circle cx="9" cy="9" r="8" stroke="#1a7a4a" strokeWidth="1.4"/>
            <path d="M3 12 Q9 4 15 12" stroke="#1a7a4a" strokeWidth="1.4" fill="none"/>
          </svg>
          <span className="font-semibold text-sm">Water Favorability Explorer</span>
          <Pill v="blue">HF v1</Pill>
        </div>
        <div className="text-[11px] text-muted-foreground">
          {rectStep === 1
            ? <span className="text-amber-400">Click second corner · Esc to cancel</span>
            : aoi
              ? <span className="text-[#22d3ee]/80 font-mono">{aoi.minLat.toFixed(2)}° – {aoi.maxLat.toFixed(2)}° N · {aoi.minLon.toFixed(2)}° – {aoi.maxLon.toFixed(2)}° E</span>
              : <span className="italic opacity-60">Click map to draw AOI rectangle</span>
          }
        </div>
      </header>

      {/* ── Body ───────────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden" style={{ height: mapH }}>

        {/* ── LEFT: Project form ──────────────────────────────────────── */}
        <div className="flex flex-col overflow-y-auto border-r border-border bg-card shrink-0 p-3" style={{ width: LEFT_W }}>
          <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col flex-1">

            <SecHead>Project</SecHead>
            <div className="space-y-2">
              <div>
                <Label htmlFor="projectName">Name</Label>
                <FInput id="projectName" placeholder="e.g. Shabelle HF" error={errors.projectName?.message} {...register("projectName")} />
              </div>
              <div>
                <Label htmlFor="projectCode">Code (2–4 letters)</Label>
                <FInput id="projectCode" placeholder="SHB" maxLength={4} className="uppercase" error={errors.projectCode?.message}
                  {...register("projectCode", { setValueAs: (v: string) => v.toUpperCase() })} />
              </div>
            </div>

            <SecHead>AOI</SecHead>
            <div className={cn("rounded border px-2 py-1.5 text-[11px]", aoi ? "border-[#22d3ee]/40 bg-[#22d3ee]/5 text-[#22d3ee]/80" : "border-border text-muted-foreground italic")}>
              {aoi
                ? <div className="flex items-center justify-between">
                    <span>Rectangle drawn ✓</span>
                    <button type="button" onClick={() => { setAoi(null); aoiLayerRef.current?.clearLayers(); if (hfOverlayRef.current && leafletMap.current) { leafletMap.current.removeLayer(hfOverlayRef.current); hfOverlayRef.current = null; } }}
                      className="text-[10px] underline text-muted-foreground hover:text-destructive ml-2">clear</button>
                  </div>
                : <span>{rectStep === 0 ? "Click map: first corner" : "Click map: second corner"}</span>
              }
            </div>

            <SecHead>Resolution</SecHead>
            <select {...register("resolution")}
              className="w-full rounded border border-border bg-input px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring">
              <option value="30m">30 m – high detail</option>
              <option value="90m">90 m – recommended</option>
              <option value="1km">1 km – fast/continental</option>
            </select>

            <SecHead>Layer weights</SecHead>
            <div className="grid grid-cols-3 gap-1.5">
              {(["wGeology","wSoil","wTca"] as const).map((k, i) => (
                <div key={k}>
                  <Label htmlFor={k}>{["Geo","Soil","TCA"][i]}</Label>
                  <FInput id={k} type="number" step="0.1" min="0.01" error={errors[k]?.message} {...register(k)} />
                </div>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">HF = (w·G + w·S + w·TCA) / Σw</p>

            <div className="mt-auto pt-3">
              <button type="submit" disabled={running || !aoi}
                className={cn("w-full rounded py-2 text-sm font-semibold transition-colors bg-primary text-primary-foreground hover:bg-primary/80 disabled:opacity-50 disabled:cursor-not-allowed")}>
                {running
                  ? <span className="flex items-center justify-center gap-2"><svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>Running…</span>
                  : "▶ Run HF v1"}
              </button>
              {!aoi && <p className="text-center text-[10px] text-muted-foreground mt-1">Draw AOI on map first</p>}
            </div>
          </form>
        </div>

        {/* ── MAP ────────────────────────────────────────────────────── */}
        <div className="relative flex-1 overflow-hidden">
          <div ref={mapRef} style={{ width: "100%", height: "100%" }} />

          {/* Overlay sliders – bottom-left, same style as GRACE app */}
          <div className="absolute bottom-4 left-3 z-[999] flex flex-col gap-1.5">
            {/* Geology slider */}
            <div className="flex items-center gap-2 bg-black/65 backdrop-blur rounded px-2.5 py-1.5 text-xs text-white">
              <span className="text-[10px] uppercase tracking-wider text-white/60 w-14">Geology</span>
              <input type="range" min={0} max={100} step={5} value={geoOpacity}
                onChange={(e) => setGeoOpacity(Number(e.target.value))}
                style={{ width: 70, accentColor: "#a78bfa", cursor: "pointer" }}
                title={`Geology opacity: ${geoOpacity}%`}
              />
              <span className="text-[10px] text-white/60 w-7 text-right">{geoOpacity}%</span>
            </div>

            {/* HF raster slider – only show after a successful run */}
            {result?.status === "ok" && (
              <div className="flex items-center gap-2 bg-black/65 backdrop-blur rounded px-2.5 py-1.5 text-xs text-white">
                <span className="text-[10px] uppercase tracking-wider text-[#22d3ee]/80 w-14">HF layer</span>
                <input type="range" min={0} max={100} step={5} value={hfOpacity}
                  onChange={(e) => setHfOpacity(Number(e.target.value))}
                  style={{ width: 70, accentColor: "#22d3ee", cursor: "pointer" }}
                  title={`HF overlay opacity: ${hfOpacity}%`}
                />
                <span className="text-[10px] text-white/60 w-7 text-right">{hfOpacity}%</span>
              </div>
            )}
          </div>

          {/* HF colour ramp legend */}
          {result?.status === "ok" && (
            <div className="absolute bottom-4 right-3 z-[999] bg-black/65 backdrop-blur rounded px-2.5 py-2 text-[10px] text-white">
              <p className="uppercase tracking-wider text-white/60 mb-1">HF score</p>
              <div className="flex items-center gap-1.5">
                <div style={{ width: 80, height: 10, background: "linear-gradient(to right, #0000c8, #00b450, #ffdc00, #dc1e1e)", borderRadius: 3 }} />
              </div>
              <div className="flex justify-between mt-0.5" style={{ width: 80 }}>
                <span>0</span><span>0.5</span><span>1</span>
              </div>
            </div>
          )}

          {/* Draw instruction overlay */}
          {rectStep === 1 && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[999] bg-black/70 text-amber-300 text-xs px-3 py-1.5 rounded pointer-events-none select-none">
              Click second corner to finish AOI · Esc to cancel
            </div>
          )}
          {!aoi && rectStep === 0 && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[999] bg-black/55 text-white/75 text-xs px-3 py-1.5 rounded pointer-events-none select-none">
              Click map to start drawing AOI rectangle
            </div>
          )}

          {hfLoading && (
            <div className="absolute inset-0 flex items-center justify-center z-[1000] bg-black/20">
              <div className="bg-black/70 text-white text-sm px-4 py-2 rounded flex items-center gap-2">
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                Rendering HF overlay…
              </div>
            </div>
          )}
        </div>

        {/* ── RIGHT: Run summary + downloads ─────────────────────────── */}
        <div className="flex flex-col overflow-y-auto border-l border-border bg-card shrink-0 p-3" style={{ width: RIGHT_W }}>

          <SecHead>Run status</SecHead>
          <div className="flex items-center gap-2 mb-2">
            <Pill v={runStatus === "ok" ? "ok" : runStatus === "err" ? "err" : runStatus === "running" ? "run" : "default"}>
              {{ idle: "Idle", running: "Running…", ok: "Complete", err: "Error" }[runStatus]}
            </Pill>
            {result?.projectCode && <span className="font-mono text-xs">{result.projectCode}</span>}
          </div>

          {/* UTM CRS – prominent */}
          {result?.utmCrs && (
            <div className="rounded border border-[#22d3ee]/30 bg-[#22d3ee]/5 px-2.5 py-1.5 mb-2">
              <p className="text-[9px] uppercase tracking-wider text-muted-foreground">UTM CRS</p>
              <p className="font-mono text-sm font-semibold text-[#22d3ee]">{result.utmCrs}</p>
            </div>
          )}

          {/* Metrics */}
          {result?.status === "ok" && (
            <div className="space-y-1 mb-2">
              {[
                ["Resolution",  result.resolution ?? "—"],
                ["Est. pixels", result.estimatedPixels !== undefined ? formatNumber(result.estimatedPixels) : "—"],
                ["Est. size",   result.estimatedOutputSizeMB !== undefined ? `${result.estimatedOutputSizeMB} MB` : "—"],
              ].map(([l, v]) => (
                <div key={l} className="flex justify-between text-xs border-b border-border/30 pb-0.5">
                  <span className="text-muted-foreground">{l}</span>
                  <span className="font-mono">{v}</span>
                </div>
              ))}
            </div>
          )}

          {/* Error */}
          {result?.status === "error" && (
            <div className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 mb-2">
              <p className="text-xs text-destructive break-all">{result.error}</p>
            </div>
          )}

          {/* Download ZIP */}
          {result?.status === "ok" && (
            <button onClick={handleDownloadZip} disabled={downloading}
              className="w-full rounded py-1.5 text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/80 disabled:opacity-50 disabled:cursor-not-allowed mb-3 transition-colors">
              {downloading ? "Downloading…" : "⬇ Download all (ZIP)"}
            </button>
          )}

          {/* Per-layer downloads */}
          {result?.status === "ok" && result.layerUrls && (
            <>
              <SecHead>Individual layers</SecHead>
              <div className="space-y-0.5">
                {LAYER_LABELS.map(({ key, label, ext }) => {
                  const url = result.layerUrls?.[key];
                  if (!url) return null;
                  return (
                    <div key={key} className="flex items-center justify-between py-0.5 border-b border-border/20">
                      <div className="flex-1 min-w-0 pr-2">
                        <p className="text-[10px] text-foreground truncate">{label}</p>
                        <p className="text-[9px] text-muted-foreground font-mono">{ext}</p>
                      </div>
                      <button
                        onClick={() => downloadLayer(url, label)}
                        className="shrink-0 text-[10px] bg-secondary hover:bg-accent text-foreground px-1.5 py-0.5 rounded transition-colors"
                      >
                        ↓
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* Idle guide */}
          {runStatus === "idle" && (
            <div className="text-[11px] text-muted-foreground space-y-1.5 mt-2 leading-relaxed">
              <p>1. Draw a rectangle on the map.</p>
              <p>2. Enter project name and code.</p>
              <p>3. Choose resolution and weights.</p>
              <p>4. Click <strong className="text-foreground">Run HF v1</strong>.</p>
              <p>5. The HF raster will appear on the map automatically.</p>
              <p>6. Download the ZIP or individual layers.</p>
              <div className="mt-3 pt-2 border-t border-border/30 text-[10px]">
                <p className="text-muted-foreground/70">Geology overlay = Macrostrat (visual context only). HF geology permeability is computed by the Python pipeline.</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

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
import type { HfRunResponse, HfLayerUrls, HfJobStatusResponse } from "@shared/types";

// Fix Leaflet default marker icons
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon   from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({ iconRetinaUrl: markerIcon2x, iconUrl: markerIcon, shadowUrl: markerShadow });

// ─── Geocode (Nominatim) ─────────────────────────────────────────────────────
async function geocode(query: string): Promise<{ lat: number; lon: number } | null> {
  // No custom User-Agent – browsers block CORS preflights on Nominatim with custom headers
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&accept-language=en`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data?.length) return null;
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
}

// ─── UTM zone helper ──────────────────────────────────────────────────────────
// Mirrors utm_epsg() in run_hf.py exactly so the frontend preview matches Python.
function utmEpsg(centreLat: number, centreLon: number): string {
  const zone = Math.floor((centreLon + 180) / 6) + 1;
  const base  = centreLat >= 0 ? 32600 : 32700;
  return `EPSG:${base + zone}`;
}
function utmLabel(centreLat: number, centreLon: number): string {
  const zone    = Math.floor((centreLon + 180) / 6) + 1;
  const hemi    = centreLat >= 0 ? "N" : "S";
  const epsg    = utmEpsg(centreLat, centreLon);
  return `UTM ${zone}${hemi}  ·  ${epsg}`;
}

// ─── Layout ───────────────────────────────────────────────────────────────────
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
  { key: "dem",      label: "DEM (Copernicus GLO-30/90)",   ext: ".tif" },
  { key: "weights",  label: "Weights matrix",              ext: ".csv" },
  { key: "metadata", label: "Run metadata",                ext: ".json" },
];

// ─── Form schema ──────────────────────────────────────────────────────────────
//
// z.coerce.number() handles ALL input sources cleanly:
//  - Typed strings ("1.5", ".5") → coerced to number
//  - JS numbers from defaultValues (1.0) → pass through unchanged
// The z.union+transform+pipe chain proved unreliable with zodResolver because
// zodResolver calls parse() against the raw field value which may be a JS
// number from defaultValues – z.string() would immediately reject it.
//
const formSchema = z.object({
  projectName: z.string().min(1, "Required"),
  projectCode: z.string().trim().min(2, "Min 2 letters").max(3, "Max 3 letters").regex(/^[A-Za-z]+$/, "Letters only (2–3)"),
  resolution:  z.enum(["30m", "90m", "1km"]),
  wGeology:    z.coerce.number().positive("Must be > 0"),
  wSoil:       z.coerce.number().positive("Must be > 0"),
  wTca:        z.coerce.number().positive("Must be > 0"),
});
type FormValues = z.infer<typeof formSchema>;

// ─── Small UI helpers ─────────────────────────────────────────────────────────
function Label({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return <label htmlFor={htmlFor} className="block text-[11px] font-medium text-muted-foreground mb-0.5">{children}</label>;
}
// FInput must forward the ref so React Hook Form can attach its ref to the
// actual <input> element. Without forwardRef the RHF ref lands on the <div>
// wrapper and the field value is never read, causing permanent "Required".
const FInput = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & { id: string; error?: string }
>(({ id, error, className, ...p }, ref) => (
  <div>
    <input
      ref={ref}
      id={id}
      className={cn(
        "w-full rounded border bg-input px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring",
        error ? "border-destructive" : "border-border",
        className,
      )}
      {...p}
    />
    {error && <p className="mt-0.5 text-[10px] text-destructive">{error}</p>}
  </div>
));
FInput.displayName = "FInput";
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
  const tcaOverlayRef    = useRef<L.ImageOverlay | null>(null);
  const rectStepRef      = useRef<0|1>(0);
  const geoOpacityRef    = useRef(0);
  const geoPopupRef      = useRef<L.Popup | null>(null);

  // UI state
  const [rectStep,    setRectStep]    = useState<0|1>(0);
  const [geoOpacity,  setGeoOpacity]  = useState(0);
  const [hfOpacity,   setHfOpacity]   = useState(70);
  const [tcaOpacity,  setTcaOpacity]  = useState(0);
  const [aoi, setAoi]   = useState<{ minLat:number; maxLat:number; minLon:number; maxLon:number }|null>(null);
  const [searchText,   setSearchText]   = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError,   setSearchError]   = useState<string|null>(null);
  const [running,     setRunning]     = useState(false);
  const [runStatus,   setRunStatus]   = useState<"idle"|"running"|"ok"|"err">("idle");
  const [result,      setResult]      = useState<HfRunResponse|null>(null);
  const [jobId,       setJobId]       = useState<string|null>(null);
  const [jobLogs,     setJobLogs]     = useState<string[]>([]);
  const [downloading, setDownloading] = useState(false);
  const [hfLoading,   setHfLoading]   = useState(false);
  const [tcaLoading,  setTcaLoading]  = useState(false);
  const pollRef   = useRef<ReturnType<typeof setInterval>|null>(null);
  const logBoxRef  = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });

  const { register, handleSubmit, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    mode: "onChange",
    defaultValues: { projectName: "HF Run", projectCode: "HF", resolution: "90m", wGeology: 1, wSoil: 1, wTca: 1 },
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

    // Scale bar (metric + imperial)
    L.control.scale({ position: "bottomright", imperial: true, metric: true }).addTo(map);

    // North arrow – custom Leaflet control, top-right
    const NorthArrow = L.Control.extend({
      onAdd() {
        const div = L.DomUtil.create("div", "");
        div.style.cssText = "pointer-events:none;user-select:none;";
        div.innerHTML = `
          <svg width="32" height="44" viewBox="0 0 32 44" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 1px 3px rgba(0,0,0,0.55))">
            <polygon points="16,2 23,22 16,18 9,22" fill="#e6edf3" stroke="#161b22" stroke-width="1"/>
            <polygon points="16,34 23,22 16,18 9,22" fill="#484f58" stroke="#161b22" stroke-width="1"/>
            <text x="16" y="43" text-anchor="middle" font-size="10" font-weight="700" font-family="sans-serif" fill="#e6edf3" stroke="#161b22" stroke-width="2.5" paint-order="stroke">N</text>
          </svg>`;
        return div;
      },
    });
    new NorthArrow({ position: "topright" }).addTo(map);

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

    // Click: geology popup when overlay active, otherwise draw AOI
    map.on("click", (e: L.LeafletMouseEvent) => {
      const { lat, lng } = e.latlng;

      // ── Geology lookup ──────────────────────────────────────────────────
      if (geoOpacityRef.current > 0 && rectStepRef.current === 0) {
        if (geoPopupRef.current) { geoPopupRef.current.remove(); geoPopupRef.current = null; }
        const loadingPopup = L.popup({ className: "geo-id-popup", offset: [0, -8], closeButton: true, autoClose: false, closeOnClick: false })
          .setLatLng([lat, lng])
          .setContent(`<div class="geo-popup-loading"><span class="geo-spinner"></span>Looking up geology…</div>`)
          .addTo(map);
        geoPopupRef.current = loadingPopup;
        fetch(`https://macrostrat.org/api/v2/geologic_units/map?lat=${lat}&lng=${lng}`)
          .then(r => r.json())
          .then(data => {
            if (!geoPopupRef.current || geoPopupRef.current !== loadingPopup) return;
            const unit = data?.success?.data?.[0];
            if (!unit) {
              loadingPopup.setContent(`<div class="geo-popup-body"><span style="color:#8b949e;font-size:11px">No geology data at this location</span></div>`);
              return;
            }
            const ageName = unit.best_int_name || "";
            const ageRange = (unit.t_age != null && unit.b_age != null)
              ? `${Number(unit.t_age).toFixed(1)}–${Number(unit.b_age).toFixed(1)} Ma`
              : "";
            const age  = ageRange ? `${ageName ? ageName + ", " : ""}${ageRange}` : ageName;
            const lith = unit.lith || "";
            // Map Macrostrat lith keywords → our GEOLOGY_PERM_LUT keys
            const PERM_MAP: Record<string, number> = {
              "unconsolidated": 0.95, "alluvium": 0.95, "sand": 0.95, "gravel": 0.95,
              "siliciclastic": 0.85, "sandstone": 0.85, "conglomerate": 0.85,
              "pyroclastic": 0.75, "tuff": 0.75,
              "carbonate": 0.80, "limestone": 0.80, "dolomite": 0.80,
              "evaporite": 0.45, "gypsum": 0.45, "salt": 0.45,
              "metamorphic": 0.20, "schist": 0.20, "gneiss": 0.20,
              "granite": 0.15, "plutonic": 0.15, "acid plutonic": 0.15,
              "basalt": 0.20, "gabbro": 0.20, "basic plutonic": 0.20,
              "rhyolite": 0.35, "acid volcanic": 0.35,
              "andesite": 0.30, "basic volcanic": 0.30,
            };
            const lithLow = (lith || "").toLowerCase();
            let perm = 0.40;
            for (const [k, v] of Object.entries(PERM_MAP)) {
              if (lithLow.includes(k)) { perm = v; break; }
            }
            const permColor = perm >= 0.70 ? "#4ade80" : perm >= 0.45 ? "#facc15" : "#f87171";
            loadingPopup.setContent(`
              <div class="geo-popup-body">
                ${age  ? `<div class="geo-popup-row"><span class="geo-popup-label">Age</span>${age}</div>` : ""}
                ${lith ? `<div class="geo-popup-row"><span class="geo-popup-label">Lithology</span>${lith}</div>` : ""}
                <div class="geo-popup-row"><span class="geo-popup-label">Perm.</span><span style="color:${permColor};font-weight:700;font-family:monospace">${perm.toFixed(2)}</span></div>
              </div>`);
          })
          .catch(() => {
            if (geoPopupRef.current === loadingPopup)
              loadingPopup.setContent(`<div class="geo-popup-body"><span style="color:#f87171;font-size:11px">Geology lookup failed</span></div>`);
          });
        return; // don't start AOI draw while geology mode is active
      }

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

  // Keep ref in sync so map click handler can read it without stale closure
  useEffect(() => { geoOpacityRef.current = geoOpacity; }, [geoOpacity]);

  // Crosshair cursor when geology overlay is visible
  useEffect(() => {
    if (!leafletMap.current) return;
    leafletMap.current.getContainer().style.cursor = geoOpacity > 0 ? "crosshair" : "";
  }, [geoOpacity]);

  // ── Macrostrat geology overlay ────────────────────────────────────────────
  useEffect(() => {
    if (!leafletMap.current) return;
    if (geoOpacity === 0) {
      if (macroLayerRef.current) { leafletMap.current.removeLayer(macroLayerRef.current); macroLayerRef.current = null; }
      if (geoPopupRef.current)   { geoPopupRef.current.remove(); geoPopupRef.current = null; }
    } else {
      if (!macroLayerRef.current) {
        macroLayerRef.current = L.tileLayer("https://tiles.macrostrat.org/carto/{z}/{x}/{y}.png", {
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


  // ── TCA overlay opacity/load ────────────────────────────────────────────────
  useEffect(() => {
    if (!leafletMap.current) return;
    if (tcaOpacity === 0) {
      if (tcaOverlayRef.current) {
        leafletMap.current.removeLayer(tcaOverlayRef.current);
        tcaOverlayRef.current = null;
      }
    } else if (tcaOverlayRef.current) {
      tcaOverlayRef.current.setOpacity(tcaOpacity / 100);
    }
  }, [tcaOpacity]);

  // ── Load TCA overlay onto map ─────────────────────────────────────────────
  const loadTcaOverlay = useCallback(async (projectCode: string, resolution: string) => {
    if (!leafletMap.current) return;
    setTcaLoading(true);
    try {
      const r = await fetch(`/api/hf/preview?projectCode=${projectCode}&resolution=${resolution}&layer=tca`);
      if (!r.ok) { toast({ title: 'TCA preview unavailable', variant: 'destructive' }); return; }
      const data = await r.json();
      const { pngUrl, bounds } = data;
      if (!pngUrl || !bounds) return;
      if (tcaOverlayRef.current) { leafletMap.current.removeLayer(tcaOverlayRef.current); tcaOverlayRef.current = null; }
      const lb: L.LatLngBoundsExpression = [[bounds.minLat, bounds.minLon], [bounds.maxLat, bounds.maxLon]];
      tcaOverlayRef.current = L.imageOverlay(pngUrl, lb, { opacity: tcaOpacity / 100, interactive: false, zIndex: 350 }).addTo(leafletMap.current);
      aoiLayerRef.current?.bringToFront();
      if (hfOverlayRef.current) hfOverlayRef.current.bringToFront();
    } catch (e: unknown) {
      toast({ title: 'TCA overlay error', description: String(e), variant: 'destructive' });
    } finally {
      setTcaLoading(false);
    }
  }, [tcaOpacity]);

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

  // ── Geocode search ──────────────────────────────────────────────────────────
  const handleSearch = useCallback(async () => {
    const q = searchText.trim();
    if (!q) return;
    setSearchLoading(true);
    setSearchError(null);
    try {
      const result = await geocode(q);
      if (!result) { setSearchError("Location not found"); return; }
      const { lat, lon } = result;
      if (leafletMap.current) {
        leafletMap.current.setView([lat, lon], 6, { animate: true });
      }
    } catch {
      setSearchError("Search failed — check your connection");
    } finally {
      setSearchLoading(false);
    }
  }, [searchText]);

  // ── Job polling ───────────────────────────────────────────────────────────
  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const startPolling = useCallback((id: string) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const res  = await fetch(`/api/hf/job/${id}`);
        if (!res.ok) return;
        const data: HfJobStatusResponse = await res.json();
        setJobLogs(data.logs ?? []);

        if (data.status === "ok" && data.result) {
          stopPolling();
          setRunning(false);
          setRunStatus("ok");
          const r: HfRunResponse = { status: "ok", ...data.result };
          setResult(r);
          toast({ title: "HF v1 complete", description: data.result.outputs?.zipName });
          if (r.projectCode && r.resolution) {
            await loadHfOverlay(r.projectCode, r.resolution);
            if (r.tcaPreviewUrl) await loadTcaOverlay(r.projectCode, r.resolution);
          }
        } else if (data.status === "error") {
          stopPolling();
          setRunning(false);
          setRunStatus("err");
          setResult({ status: "error", error: data.error });
          toast({ title: "Pipeline failed", description: data.error, variant: "destructive" });
        }
      } catch { /* network glitch – keep polling */ }
    }, 3000);
  }, [stopPolling, loadHfOverlay, loadTcaOverlay]);

  // Clean up poll on unmount
  useEffect(() => () => stopPolling(), [stopPolling]);

  // Auto-scroll log box to bottom whenever new lines arrive
  useEffect(() => {
    const el = logBoxRef.current;
    if (!el) return;
    // Only auto-scroll if the user is already near the bottom (within 60px),
    // so manual scrolling upward to read history is never interrupted.
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (nearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [jobLogs]);

  // ── Run HF pipeline (async) ───────────────────────────────────────────────
  async function onSubmit(values: FormValues) {
    console.log("[HF] Form submitted – values:", values);
    if (!aoi) { toast({ title: "No AOI", description: "Draw a rectangle on the map first.", variant: "destructive" }); return; }

    setRunning(true);
    setRunStatus("running");
    setResult(null);
    setJobId(null);
    setJobLogs([]);
    stopPolling();

    // Remove previous overlays
    if (hfOverlayRef.current && leafletMap.current) {
      leafletMap.current.removeLayer(hfOverlayRef.current);
      hfOverlayRef.current = null;
    }
    if (tcaOverlayRef.current && leafletMap.current) {
      leafletMap.current.removeLayer(tcaOverlayRef.current);
      tcaOverlayRef.current = null;
    }
    setTcaOpacity(0);

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

      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        const text = await res.text();
        console.error("[HF] Non-JSON response", res.status, res.statusText, text.slice(0, 300));
        throw new Error(`Server returned HTTP ${res.status} ${res.statusText} (not JSON). Check server logs.`);
      }

      const data = await res.json() as { status: string; jobId?: string; error?: string };

      if (!res.ok || data.status === "error") {
        setRunning(false);
        setRunStatus("err");
        setResult({ status: "error", error: data.error ?? "Unknown error" });
        toast({ title: "Failed to start pipeline", description: data.error, variant: "destructive" });
        return;
      }

      // Job queued – start polling
      setJobId(data.jobId!);
      startPolling(data.jobId!);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setRunning(false);
      setRunStatus("err");
      setResult({ status: "error", error: msg });
      toast({ title: "Request failed", description: msg, variant: "destructive" });
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
    <>
    <style>{`
      @keyframes spin { to { transform: rotate(360deg); } }
      .search-input::placeholder { color: #8b949e; }
      .search-input:focus { outline: none; border-color: #22d3ee !important; }
      .geo-id-popup .leaflet-popup-content-wrapper {
        background: #161b22; border: 1px solid #a78bfa60;
        border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.6);
        padding: 0; min-width: 220px; max-width: 300px;
      }
      .geo-id-popup .leaflet-popup-content { margin: 0; }
      .geo-id-popup .leaflet-popup-tip-container .leaflet-popup-tip { background: #161b22; }
      .geo-id-popup .leaflet-popup-close-button { color: #6e7681 !important; font-size: 16px !important; top: 6px !important; right: 8px !important; }
      .geo-id-popup .leaflet-popup-close-button:hover { color: #e6edf3 !important; }
      .geo-popup-loading { display: flex; align-items: center; gap: 8px; padding: 12px 14px; font-size: 11px; color: #8b949e; }
      .geo-spinner { display: inline-block; width: 12px; height: 12px; border-radius: 50%; border: 2px solid #30363d; border-top-color: #a78bfa; animation: spin 0.8s linear infinite; flex-shrink: 0; }
      .geo-popup-body { padding: 12px 14px 10px; }
      .geo-popup-row { display: flex; align-items: baseline; gap: 6px; font-size: 11px; color: #c9d1d9; margin-bottom: 3px; line-height: 1.4; }
      .geo-popup-label { font-size: 10px; font-weight: 700; color: #8b949e; text-transform: uppercase; letter-spacing: 0.07em; flex-shrink: 0; min-width: 54px; }
    `}</style>
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
        {/* Search box – identical pattern to GRACE app */}
        <div className="flex items-center gap-1.5">
          <div className="relative flex items-center">
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" className="absolute left-2 pointer-events-none">
              <circle cx="6.5" cy="6.5" r="4.5" stroke="#8b949e" strokeWidth="1.4"/>
              <path d="M10 10l3 3" stroke="#8b949e" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
            <input
              type="text"
              placeholder="Search city or country…"
              value={searchText}
              onChange={(e) => { setSearchText(e.target.value); setSearchError(null); }}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              className="search-input"
              style={{ paddingLeft: 26, paddingRight: 8, height: 28, width: 190,
                background: "#0d1117", border: "1px solid #30363d",
                borderRadius: 6, fontSize: 12, color: "#e6edf3" }}
            />
          </div>
          <button
            onClick={handleSearch}
            disabled={searchLoading || !searchText.trim()}
            style={{ height: 28, padding: "0 10px", fontSize: 12, fontWeight: 600,
              background: "#0e4c5a", border: "1px solid #22d3ee", borderRadius: 6,
              color: "#22d3ee", cursor: searchLoading || !searchText.trim() ? "not-allowed" : "pointer",
              opacity: searchLoading || !searchText.trim() ? 0.5 : 1 }}
          >
            {searchLoading ? "…" : "Go"}
          </button>
          {searchError && <span className="text-[11px] text-red-400">{searchError}</span>}
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
                <Label htmlFor="projectCode">Code (2–3 letters)</Label>
                <FInput id="projectCode" placeholder="SHB" maxLength={3} className="uppercase" error={errors.projectCode?.message}
                  {...register("projectCode")} />
              </div>
            </div>

            <SecHead>AOI</SecHead>
            <div className={cn("rounded border px-2 py-1.5 text-[11px]", aoi ? "border-[#22d3ee]/40 bg-[#22d3ee]/5 text-[#22d3ee]/80" : "border-border text-muted-foreground italic")}>
              {aoi
                ? <>
                    <div className="flex items-center justify-between">
                      <span>Rectangle drawn ✓</span>
                      <button type="button" onClick={() => { setAoi(null); aoiLayerRef.current?.clearLayers(); if (hfOverlayRef.current && leafletMap.current) { leafletMap.current.removeLayer(hfOverlayRef.current); hfOverlayRef.current = null; } if (tcaOverlayRef.current && leafletMap.current) { leafletMap.current.removeLayer(tcaOverlayRef.current); tcaOverlayRef.current = null; } setTcaOpacity(0); }}
                        className="text-[10px] underline text-muted-foreground hover:text-destructive ml-2">clear</button>
                    </div>
                    <div className="mt-1 font-mono text-[10px] text-[#22d3ee]/70">
                      {utmLabel((aoi.minLat + aoi.maxLat) / 2, (aoi.minLon + aoi.maxLon) / 2)}
                    </div>
                  </>
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
                  <FInput id={k} type="text" inputMode="decimal" error={errors[k]?.message}
                    {...register(k, { valueAsNumber: true })} />
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
              <span className="text-[10px] w-7 text-right" style={{ color: geoOpacity > 0 ? "#a78bfa" : "rgba(255,255,255,0.4)" }}>{geoOpacity > 0 ? `${geoOpacity}%` : "off"}</span>
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

            {/* TCA slider – only show after a successful run */}
            {result?.status === "ok" && (
              <div className="flex items-center gap-2 bg-black/65 backdrop-blur rounded px-2.5 py-1.5 text-xs text-white">
                <span className="text-[10px] uppercase tracking-wider w-14" style={{ color: tcaOpacity > 0 ? "#93c5fd" : "rgba(255,255,255,0.4)" }}>TCA</span>
                <input type="range" min={0} max={100} step={5} value={tcaOpacity}
                  onChange={(e) => setTcaOpacity(Number(e.target.value))}
                  style={{ width: 70, accentColor: "#3b82f6", cursor: "pointer" }}
                  title={`TCA overlay opacity: ${tcaOpacity}%`}
                />
                <span className="text-[10px] w-7 text-right" style={{ color: tcaOpacity > 0 ? "#93c5fd" : "rgba(255,255,255,0.4)" }}>{tcaOpacity > 0 ? `${tcaOpacity}%` : "off"}</span>
              </div>
            )}
          </div>

          {/* Legends – bottom-right */}
          {result?.status === "ok" && (
            <div className="absolute bottom-4 right-3 z-[999] flex flex-col gap-1.5">
              {/* HF score legend */}
              <div className="bg-black/65 backdrop-blur rounded px-2.5 py-2 text-[10px] text-white">
                <p className="uppercase tracking-wider text-white/60 mb-1">HF score</p>
                <div className="flex items-center gap-1.5">
                  <div style={{ width: 80, height: 10, background: "linear-gradient(to right, #0000c8, #00b450, #ffdc00, #dc1e1e)", borderRadius: 3 }} />
                </div>
                <div className="flex justify-between mt-0.5" style={{ width: 80 }}>
                  <span>0</span><span>0.5</span><span>1</span>
                </div>
              </div>
              {/* TCA legend – shown when TCA slider is active */}
              {tcaOpacity > 0 && (
                <div className="bg-black/65 backdrop-blur rounded px-2.5 py-2 text-[10px] text-white">
                  <p className="uppercase tracking-wider text-white/60 mb-1">TCA (flow accum.)</p>
                  <div className="flex items-center gap-1.5">
                    <div style={{ width: 80, height: 10, background: "linear-gradient(to right, #c8e6ff, #64b4ff, #1e64dc, #00148c)", borderRadius: 3 }} />
                  </div>
                  <div className="flex justify-between mt-0.5" style={{ width: 80 }}>
                    <span>low</span><span>high</span>
                  </div>
                </div>
              )}
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
            {(result?.projectCode) && <span className="font-mono text-xs">{result.projectCode}</span>}
            {jobId && runStatus === "running" && (
              <span className="text-[9px] text-muted-foreground font-mono truncate" title={jobId}>job {jobId.slice(0,8)}…</span>
            )}
          </div>

          {/* Live progress log */}
          {(runStatus === "running" || (runStatus !== "idle" && jobLogs.length > 0)) && (
            <div ref={logBoxRef} className="mb-2 rounded border border-border/50 bg-black/30 px-2 py-1.5 max-h-44 overflow-y-auto">
              <p className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1">Progress log</p>
              {jobLogs.length === 0
                ? <p className="text-[10px] text-muted-foreground/60 italic">Waiting for pipeline…</p>
                : jobLogs.map((line, i) => (
                    <p key={i} className="text-[10px] font-mono text-green-300/80 leading-relaxed break-all">
                      {line}
                    </p>
                  ))
              }
              {runStatus === "running" && (
                <p className="text-[10px] text-blue-300/60 italic mt-0.5 flex items-center gap-1">
                  <svg className="animate-spin h-2.5 w-2.5 shrink-0" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                  </svg>
                  Processing…
                </p>
              )}
            </div>
          )}

          {/* UTM CRS */}
          {result?.utmCrs && (
            <div className="rounded border border-[#22d3ee]/30 bg-[#22d3ee]/5 px-2.5 py-1.5 mb-2">
              <p className="text-[9px] uppercase tracking-wider text-muted-foreground mb-0.5">Target UTM CRS</p>
              <p className="font-mono text-sm font-semibold text-[#22d3ee]">{result.utmCrs}</p>
              {result.aoi && (
                <p className="font-mono text-[10px] text-[#22d3ee]/60 mt-0.5">
                  {utmLabel((result.aoi.minLat + result.aoi.maxLat) / 2, (result.aoi.minLon + result.aoi.maxLon) / 2)}
                </p>
              )}
              <p className="text-[9px] text-muted-foreground/60 mt-1">All rasters reproject to this zone</p>
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

          {/* Download actions – shown on success */}
          {result?.status === "ok" && (
            <div className="space-y-1.5 mb-3">
              <button onClick={handleDownloadZip} disabled={downloading}
                className="w-full rounded py-1.5 text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                {downloading ? "Downloading…" : "⬇ Download All Layers (.zip)"}
              </button>
              <button
                onClick={() => {
                  const url = result.layerUrls?.metadata;
                  if (url) { const a = document.createElement("a"); a.href = url; a.click(); }
                }}
                className="w-full rounded py-1.5 text-sm font-semibold bg-secondary text-secondary-foreground hover:bg-accent transition-colors">
                ↥ Export Metadata (.json)
              </button>
            </div>
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
              <p>5. The HF raster appears on the map automatically.</p>
              <p>6. Download the ZIP or individual layers.</p>
              <div className="mt-3 pt-2 border-t border-border/30 text-[10px]">
                <p className="text-muted-foreground/70">Geology overlay = Macrostrat (visual context only). HF geology permeability is computed by the Python pipeline.</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
    </>
  );
}

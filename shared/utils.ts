/**
 * shared/utils.ts – Water Favorability Explorer · shared utilities
 *
 * UTM zone logic is duplicated here (shared between server and client) so both
 * sides always compute the same EPSG code from the same AOI bbox.
 *
 * Server (routes.ts) uses centreUtmEpsg() to compute utmCrs before spawning
 * the Python process and includes it in the JSON payload so run_hf.py does not
 * have to recompute it independently.
 *
 * Client (HFExplorer.tsx) uses utmEpsg() / utmLabel() to display the zone
 * in the AOI box and run-summary panel without waiting for the API response.
 */

// ─── UTM zone utilities ───────────────────────────────────────────────────────

/**
 * Return the EPSG code string (e.g. "EPSG:32637") for the UTM zone that
 * covers the given centre latitude and longitude.
 *
 * Mirrors utm_epsg() in python/run_hf.py exactly.
 */
export function utmEpsg(centreLat: number, centreLon: number): string {
  const zone = Math.floor((centreLon + 180) / 6) + 1;
  const base = centreLat >= 0 ? 32600 : 32700;
  return `EPSG:${base + zone}`;
}

/**
 * Return a human-readable UTM zone label, e.g. "UTM 37N  ·  EPSG:32637".
 */
export function utmLabel(centreLat: number, centreLon: number): string {
  const zone = Math.floor((centreLon + 180) / 6) + 1;
  const hemi = centreLat >= 0 ? "N" : "S";
  const epsg = utmEpsg(centreLat, centreLon);
  return `UTM ${zone}${hemi}  ·  ${epsg}`;
}

/**
 * Convenience wrapper: compute EPSG from an AOI bbox (uses centre point).
 * Signature matches the centreUtmEpsg() helper in server/routes.ts.
 */
export function centreUtmEpsg(
  minLat: number,
  maxLat: number,
  minLon: number,
  maxLon: number,
): string {
  return utmEpsg((minLat + maxLat) / 2, (minLon + maxLon) / 2);
}

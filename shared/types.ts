/**
 * Shared TypeScript types between server and client.
 */

export interface HfAoi {
  type: "bbox" | "country";
  minLat?: number;
  maxLat?: number;
  minLon?: number;
  maxLon?: number;
  name?: string;
}

export interface HfWeights {
  geology?: number;
  soil?: number;
  tca?: number;
}

export interface HfRunRequest {
  projectName: string;
  projectCode: string;
  aoi: HfAoi;
  resolution: "30m" | "90m" | "1km";
  weights?: HfWeights;
}

export interface HfOutputFiles {
  hfRaster:      string;
  geologyNorm:   string;
  soilNorm:      string;
  tcaRaw:        string;
  tcaNorm:       string;
  tcaRRZ:        string;
  tcaNRZ:        string;
  dem:           string;
  weightsMatrix: string;
  metadata:      string;
  zipName:       string;
  zipPath:       string;
}

/** Per-layer download URL map returned by /api/hf/run */
export interface HfLayerUrls {
  hf:       string;
  geology:  string;
  soil:     string;
  tca_raw:  string;
  tca_norm: string;
  rrz:      string;
  nrz:      string;
  dem:      string;
  weights:  string;
  metadata: string;
}

export interface HfRunResponse {
  status: "ok" | "error";
  error?: string;
  projectCode?:           string;
  resolution?:            string;
  utmCrs?:                string;
  estimatedPixels?:       number;
  estimatedOutputSizeMB?: number;
  /** AOI echoed back from server for map overlay positioning */
  aoi?: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  outputs?:   HfOutputFiles;
  layerUrls?: HfLayerUrls;
  previewUrl?: string;
  /** PNG URL for the TCA (log-normalised flow accumulation) map overlay */
  tcaPreviewUrl?: string;
}

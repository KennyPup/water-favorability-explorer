/**
 * Shared TypeScript types between server and client.
 * Mirror the JSON shapes emitted by routes.ts.
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

export interface HfRunResponse {
  status: "ok" | "error";
  error?: string;
  projectCode?:           string;
  resolution?:            string;
  utmCrs?:                string;
  estimatedPixels?:       number;
  estimatedOutputSizeMB?: number;
  outputs?: HfOutputFiles;
}

export interface HfStatusResponse {
  status: "ready";
  outputsDir: string;
  zips:     string[];
  projects: string[];
}

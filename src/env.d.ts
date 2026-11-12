/// <reference types="vite/client" />

declare module "voz-stream" {
  interface Source {
    seconds: number;
    totalSamples: number;
    pull(count: number): Promise<Float32Array>;
  }
  export function wavSource(blob: Blob): Promise<Source | null>;
  export function mediaSource(blob: Blob): Promise<Source | null>;
}

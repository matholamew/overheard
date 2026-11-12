// One place that decides where the big wasm files live in R2, so the build and
// the upload script can never disagree. Keys include package versions, so
// upgrading a package means re-running `npm run upload-wasm`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkgDir = (name) => join(root, "node_modules", ...name.split("/"));
const versionOf = (name) => JSON.parse(readFileSync(join(pkgDir(name), "package.json"), "utf8")).version;

export const ORT_WASM_FILE = "ort-wasm-simd-threaded.asyncify.wasm";

export function vendorKeys() {
  const voz = versionOf("@desert-ant-labs/voz");
  const ort = versionOf("onnxruntime-web");
  return {
    voz: `voz-${voz}/VozWeb.wasm`,
    ortDir: `ort-${ort}`,
    ort: `ort-${ort}/${ORT_WASM_FILE}`,
  };
}

/** R2 object names are flat (no folders) so they can be uploaded through the
 *  dashboard with the file's own name. Must match worker/index.ts. */
export const r2Key = (urlKey) => urlKey.replaceAll("/", "-");

/** `key` is the URL path under /vendor/; `r2Key` is the object name in R2. */
export function vendorFiles() {
  const keys = vendorKeys();
  return [
    { key: keys.voz, file: join(pkgDir("@desert-ant-labs/voz"), "dist", "VozWeb.wasm") },
    { key: keys.ort, file: join(pkgDir("onnxruntime-web"), "dist", ORT_WASM_FILE) },
  ].map((f) => ({ ...f, r2Key: r2Key(f.key) }));
}

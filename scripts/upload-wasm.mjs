// Uploads the two oversized wasm files to the R2 bucket the Worker serves
// /vendor/* from. Run once, and again after upgrading @desert-ant-labs/voz or
// onnxruntime-web:   npm run upload-wasm
// (Or upload the two files through the R2 dashboard: see SETUP in the README.)
// Add --local to seed the local bucket used by `npm run preview`.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { vendorFiles } from "./vendor.mjs";

const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const bucket = config.match(/"bucket_name"\s*:\s*"([^"]+)"/)?.[1];
if (!bucket) throw new Error("No bucket_name found in wrangler.jsonc");

const local = process.argv.includes("--local");
for (const { r2Key: key, file } of vendorFiles()) {
  if (!existsSync(file)) throw new Error(`Missing ${file}. Run npm install first.`);
  console.log(`Uploading ${key} ...`);
  execFileSync(
    "npx",
    [
      "wrangler", "r2", "object", "put", `${bucket}/${key}`,
      "--file", file,
      "--content-type", "application/wasm",
      local ? "--local" : "--remote",
    ],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
}
console.log("Done. The Worker will serve these under /vendor/.");

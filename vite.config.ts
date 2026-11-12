import { defineConfig, type Plugin } from "vite";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { litertFiles, vendorFiles, vendorKeys } from "./scripts/vendor.mjs";

const keys = vendorKeys();

/**
 * Voz loads its 46 MB core with `new URL("VozWeb.wasm", import.meta.url)`, and
 * onnxruntime-web bundles a 28 MB wasm the same way. Both are over the 25 MiB
 * per-file limit of Workers Static Assets, so:
 *  - Voz's URL is rewritten to /vendor/<versioned key>, served from R2;
 *  - ONNX Runtime is pointed at its file there (env.wasm.wasmPaths = { wasm });
 *  - the emitted copies are dropped from the build so `wrangler deploy` passes.
 */
function vendorWasm(): Plugin {
  return {
    name: "vendor-wasm",
    enforce: "pre",
    transform(code, id) {
      // Voz and Who each load a ~46 MB core with new URL("<Name>Web.wasm", import.meta.url).
      for (const [pkg, file, key] of [
        ["voz", "VozWeb.wasm", keys.voz],
        ["who", "WhoWeb.wasm", keys.who],
      ]) {
        if (!id.includes(`@desert-ant-labs/${pkg}/dist/index.js`)) continue;
        const target = `new URL("${file}", import.meta.url)`;
        if (!code.includes(target)) this.error(`vendor-wasm: ${pkg}'s wasm URL changed; update vite.config.ts`);
        return code.replace(target, `new URL(${JSON.stringify(`/vendor/${key}`)}, location.href)`);
      }
      return null;
    },
    // `npm run dev`: serve /vendor/* straight from node_modules (R2 does it in production).
    configureServer(server) {
      const files = new Map([
        ...vendorFiles().map(({ key, file }) => [`/vendor/${key}`, file] as const),
        ...litertFiles().map(({ name, file }) => [`/${keys.litertDir}/${name}`, file] as const),
      ]);
      server.middlewares.use((req, res, next) => {
        const file = req.url && files.get(req.url.split("?")[0]);
        if (!file) return next();
        res.setHeader("content-type", file.endsWith(".wasm") ? "application/wasm" : "text/javascript");
        createReadStream(file).pipe(res);
      });
    },
    generateBundle(_options, bundle) {
      for (const name of Object.keys(bundle)) {
        if (name.endsWith(".wasm")) delete bundle[name];
      }
    },
    writeBundle(options) {
      const out = join(options.dir ?? "dist", keys.litertDir);
      mkdirSync(out, { recursive: true });
      for (const { name, file } of litertFiles()) copyFileSync(file, join(out, name));
    },
  };
}

/**
 * /licenses.txt: the license and notice files of everything that ships in the
 * page, copied as delivered. Desert Ant's license (Section 9) asks that these
 * notices be kept; minifying the code would otherwise drop them.
 */
const LICENSED: { name: string; files: string[]; fallback?: string }[] = [
  { name: "@desert-ant-labs/voz", files: ["LICENSE.md"] },
  { name: "@desert-ant-labs/who", files: ["LICENSE.md"] },
  { name: "@desert-ant-labs/core", files: ["LICENSE.md", "THIRD_PARTY_NOTICES.md"] },
  {
    name: "onnxruntime-web",
    files: [],
    fallback:
      "MIT License. Copyright (c) Microsoft Corporation.\nFull text: https://github.com/microsoft/onnxruntime/blob/main/LICENSE",
  },
  {
    name: "@litertjs/core",
    files: [],
    fallback:
      "Apache License 2.0. Copyright Google LLC.\nFull text: https://www.apache.org/licenses/LICENSE-2.0\nSource: https://github.com/google-ai-edge/LiteRT",
  },
  {
    name: "@litertjs/wasm-utils",
    files: [],
    fallback: "Apache License 2.0. Copyright Google LLC.\nFull text: https://www.apache.org/licenses/LICENSE-2.0",
  },
  { name: "mediabunny", files: ["LICENSE"] },
  { name: "@bjorn3/browser_wasi_shim", files: ["LICENSE-MIT", "LICENSE-APACHE"] },
  { name: "@fontsource-variable/fraunces", files: ["LICENSE"] },
  { name: "@fontsource-variable/newsreader", files: ["LICENSE"] },
  { name: "@fontsource/ibm-plex-mono", files: ["LICENSE"] },
];

function licensesText(): string {
  const parts = [
    "Overheard: third-party licenses and notices",
    "Everything below ships in this site, as delivered by its authors.",
    "",
  ];
  for (const { name, files, fallback } of LICENSED) {
    const dir = fileURLToPath(new URL(`./node_modules/${name}/`, import.meta.url));
    const meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    parts.push("=".repeat(78), `${name} ${meta.version}  (${meta.license ?? "see below"})`, "=".repeat(78), "");
    const found = files.filter((f) => existsSync(join(dir, f)));
    for (const f of found) parts.push(`--- ${f} ---`, readFileSync(join(dir, f), "utf8").trim(), "");
    if (found.length === 0) parts.push(fallback ?? "License file not included in the package.", "");
  }
  return parts.join("\n") + "\n";
}

function licenses(): Plugin {
  return {
    name: "licenses",
    writeBundle(options) {
      writeFileSync(join(options.dir ?? "dist", "licenses.txt"), licensesText());
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== "/licenses.txt") return next();
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end(licensesText());
      });
    },
  };
}

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  plugins: [vendorWasm(), licenses()],
  define: {
    // The exact .wasm file, not a folder: given a folder, ONNX Runtime also
    // fetches its .mjs glue from there instead of using the bundled copy.
    __ORT_WASM_URL__: JSON.stringify(`/vendor/${keys.ort}`),
    __LITERT_DIR__: JSON.stringify(`/${keys.litertDir}/`),
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  optimizeDeps: {
    // Pre-bundling would copy the wasm URLs into .vite/deps and bypass the plugin.
    exclude: ["@desert-ant-labs/voz", "@desert-ant-labs/who", "onnxruntime-web", "@litertjs/core"],
  },
  resolve: {
    alias: {
      // Voz's streaming decoder (any file -> mono 16 kHz, a chunk at a time).
      // Not in its package exports, so it is reached by path; Who reuses it.
      "voz-stream": fileURLToPath(new URL("./node_modules/@desert-ant-labs/voz/stream.js", import.meta.url)),
    },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2000,
  },
  // The speaker worker loads Who, so it needs the same wasm-URL rewrite.
  // The speaker worker loads Who, so it needs the same wasm-URL rewrite.
  worker: { format: "es", plugins: () => [vendorWasm()] },
});

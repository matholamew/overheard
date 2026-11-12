import { defineConfig, type Plugin } from "vite";
import { createReadStream, readFileSync } from "node:fs";
import { vendorFiles, vendorKeys } from "./scripts/vendor.mjs";

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
      if (id.includes("@desert-ant-labs/voz/dist/index.js")) {
        const target = 'new URL("VozWeb.wasm", import.meta.url)';
        if (!code.includes(target)) {
          this.error("vendor-wasm: Voz's wasm URL changed; update vite.config.ts");
        }
        return code.replace(target, `new URL(${JSON.stringify(`/vendor/${keys.voz}`)}, location.href)`);
      }
      return null;
    },
    // `npm run dev`: serve /vendor/* straight from node_modules (R2 does it in production).
    configureServer(server) {
      const files = new Map(vendorFiles().map(({ key, file }) => [`/vendor/${key}`, file]));
      server.middlewares.use((req, res, next) => {
        const file = req.url && files.get(req.url.split("?")[0]);
        if (!file) return next();
        res.setHeader("content-type", "application/wasm");
        createReadStream(file).pipe(res);
      });
    },
    generateBundle(_options, bundle) {
      for (const name of Object.keys(bundle)) {
        if (name.endsWith(".wasm")) delete bundle[name];
      }
    },
  };
}

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  plugins: [vendorWasm()],
  define: {
    // The exact .wasm file, not a folder: given a folder, ONNX Runtime also
    // fetches its .mjs glue from there instead of using the bundled copy.
    __ORT_WASM_URL__: JSON.stringify(`/vendor/${keys.ort}`),
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  optimizeDeps: {
    // Pre-bundling would copy the wasm URLs into .vite/deps and bypass the plugin.
    exclude: ["@desert-ant-labs/voz", "onnxruntime-web"],
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2000,
  },
  worker: { format: "es" },
});

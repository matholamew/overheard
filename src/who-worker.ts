// Speaker labelling in a background thread. Who's analysis is one long burst
// of computation; on the page's main thread it froze the screen for minutes.
// Here the page stays responsive, shows a timer, and can cancel by ending the worker.
import { trackModelBytes } from "./bytes";
import { decodeMono16k, findSpeakers, loadWho } from "./who";
import type { Turn } from "./speakers";

export type FromWorker =
  | { type: "stage"; stage: "loading" | "reading" | "listening" }
  | { type: "bytes"; loaded: number; total: number }
  | { type: "progress"; fraction: number }
  | { type: "decoded"; seconds: number }
  | { type: "done"; turns: Turn[] }
  | { type: "error"; message: string };

/*
 * LiteRT.js (Who's runtime) loads its Emscripten glue with importScripts(),
 * which exists only in classic workers. Who itself needs a module worker
 * (top-level await), so give this one a synchronous importScripts: fetch each
 * script with a blocking request (allowed in workers) and run it in global scope.
 */
const scope = self as unknown as { importScripts?: (...urls: string[]) => void };
try {
  // Module workers define importScripts but throw when it is called.
  scope.importScripts = (...urls: string[]) => {
    for (const url of urls) {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", new URL(url, location.href).href, false);
      xhr.send();
      if (xhr.status < 200 || xhr.status >= 300) throw new Error(`importScripts: ${url} -> HTTP ${xhr.status}`);
      (0, eval)(`${xhr.responseText}\n//# sourceURL=${url}`);
    }
  };
} catch {
  /* left as is */
}

/*
 * In a worker, LiteRT's runtime looks for its .wasm next to the worker script
 * (/assets/) instead of in the folder Who was given. Emscripten reads a global
 * `Module.locateFile` hook, which LiteRT passes through, so point it there.
 */
declare const __LITERT_DIR__: string;
(self as unknown as { Module?: { locateFile(path: string): string } }).Module = {
  locateFile: (path: string) => new URL(`${__LITERT_DIR__}${path}`, location.href).href,
};

const send = (msg: FromWorker) => (self as unknown as Worker).postMessage(msg);

self.addEventListener("message", async (event: MessageEvent<{ file: File }>) => {
  try {
    // Read the audio first: it needs no download, and a file the browser can't
    // decode fails here quickly, before 90 MB of model is fetched.
    send({ type: "stage", stage: "reading" });
    let last = 0;
    const samples = await decodeMono16k(event.data.file, (fraction) => {
      if (fraction - last >= 0.01 || fraction >= 1) {
        last = fraction;
        send({ type: "progress", fraction });
      }
    });
    send({ type: "decoded", seconds: samples.length / 16000 });

    send({ type: "stage", stage: "loading" });
    const stop = trackModelBytes((loaded, total) => send({ type: "bytes", loaded, total }));
    let who;
    try {
      who = await loadWho();
    } finally {
      stop();
    }

    send({ type: "stage", stage: "listening" });
    const { turns } = await findSpeakers(who, samples);
    send({ type: "done", turns });
  } catch (err) {
    send({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
});

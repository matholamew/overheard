// Every request passes the shared-password gate first (see auth.ts). After
// that, the Worker serves the built app from Workers Static Assets, plus the
// two WebAssembly files that are too large for Static Assets (25 MiB per-file
// limit) from an R2 bucket under /vendor/.

import { clearCookie, loginPage, makeSessionCookie, passwordMatches, readCookie, sessionValid } from "./auth";

interface Env {
  ASSETS: Fetcher;
  VENDOR: R2Bucket;
  /** Set in the dashboard: Worker > Settings > Variables and Secrets (type: Secret). */
  SITE_PASSWORD?: string;
}

const html = (body: string, status = 200, extra: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
      ...extra,
    },
  });

const redirect = (location: string, extra: Record<string, string> = {}) =>
  new Response(null, { status: 303, headers: { location, "cache-control": "no-store", ...extra } });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const password = env.SITE_PASSWORD;

    // Icons and the share image are public so the login page and link previews work.
    if (["/favicon.svg", "/apple-touch-icon.png", "/og-image.jpg"].includes(url.pathname)) {
      return env.ASSETS.fetch(request);
    }

    // Fail closed: no password configured means nobody gets in.
    if (!password) return html(loginPage({ notConfigured: true }), 503);

    if (url.pathname === "/__login" && request.method === "POST") {
      const form = await request.formData().catch(() => null);
      const submitted = String(form?.get("password") ?? "");
      if (submitted && (await passwordMatches(submitted, password))) {
        return redirect("/", { "set-cookie": await makeSessionCookie(password) });
      }
      // Slow down guessing a little.
      await new Promise((r) => setTimeout(r, 750));
      return html(loginPage({ error: true, origin: url.origin }), 401);
    }

    if (url.pathname === "/__logout") {
      return redirect("/", { "set-cookie": clearCookie });
    }

    if (!(await sessionValid(readCookie(request.headers.get("cookie")), password))) {
      // Pages get the password page with status 200, not 401: link-preview bots
      // (iMessage, Slack, WhatsApp) skip pages that return an error, and this one
      // only holds a password box and the share tags. App files stay locked.
      const isFile = url.pathname.startsWith("/vendor/") || url.pathname.startsWith("/assets/");
      return request.method === "GET" && !isFile
        ? html(loginPage({ origin: url.origin }), 200)
        : new Response("Sign in required", { status: 401 });
    }

    if (url.pathname.startsWith("/vendor/")) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405 });
      }
      // URL /vendor/voz-4.3.0/VozWeb.wasm -> R2 object "voz-4.3.0-VozWeb.wasm".
      // Flat names so the files can be uploaded through the R2 dashboard as-is.
      // Must match r2Key() in scripts/vendor.mjs.
      const key = decodeURIComponent(url.pathname.slice("/vendor/".length)).replaceAll("/", "-");

      // Keep these big immutable files in Cloudflare's edge cache, so repeat
      // downloads come from the nearest data centre instead of R2. The cache
      // key is internal; the password check above has already run.
      const cache = caches.default;
      const cacheKey = new Request(`${url.origin}/__vendor-cache/${encodeURIComponent(key)}`);
      const fromR2 = async (): Promise<Response | null> => {
        const object = await env.VENDOR.get(key);
        if (!object) return null;
        const stored = new Headers();
        object.writeHttpMetadata(stored);
        stored.set("etag", object.httpEtag);
        stored.set("content-length", String(object.size));
        stored.set("cache-control", "public, max-age=31536000, immutable");
        if (key.endsWith(".wasm")) stored.set("content-type", "application/wasm");
        return new Response(object.body, { headers: stored });
      };
      let upstream: Response | null | undefined = await cache.match(cacheKey);
      if (!upstream) {
        upstream = await fromR2();
        if (!upstream) return new Response(`Not found: ${key}`, { status: 404 });
        // Fill the edge cache from a second, separate read. Splitting one 46 MB
        // stream between the browser and the cache could buffer it in memory.
        ctx.waitUntil(
          fromR2().then((copy) => (copy ? cache.put(cacheKey, copy) : undefined)).catch(() => undefined),
        );
      }

      // To the browser: cacheable by this browser only, never by a shared cache.
      const headers = new Headers(upstream.headers);
      headers.set("cache-control", "private, max-age=31536000, immutable");
      return new Response(request.method === "HEAD" ? null : upstream.body, { status: 200, headers });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

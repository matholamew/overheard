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
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const password = env.SITE_PASSWORD;

    // The icons are harmless and make the login page look right.
    if (url.pathname === "/favicon.svg" || url.pathname === "/apple-touch-icon.png") {
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
      return html(loginPage({ error: true }), 401);
    }

    if (url.pathname === "/__logout") {
      return redirect("/", { "set-cookie": clearCookie });
    }

    if (!(await sessionValid(readCookie(request.headers.get("cookie")), password))) {
      const wantsPage = request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/html");
      return wantsPage ? html(loginPage(), 401) : new Response("Sign in required", { status: 401 });
    }

    if (url.pathname.startsWith("/vendor/")) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405 });
      }
      // URL /vendor/voz-4.3.0/VozWeb.wasm -> R2 object "voz-4.3.0-VozWeb.wasm".
      // Flat names so the files can be uploaded through the R2 dashboard as-is.
      // Must match r2Key() in scripts/vendor.mjs.
      const key = decodeURIComponent(url.pathname.slice("/vendor/".length)).replaceAll("/", "-");
      const object = await env.VENDOR.get(key);
      if (!object) return new Response(`Not found: ${key}`, { status: 404 });

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      // Names are versioned (e.g. voz-4.3.0-VozWeb.wasm), so they never change.
      // "private": only the signed-in browser caches them, never a shared cache.
      headers.set("cache-control", "private, max-age=31536000, immutable");
      if (key.endsWith(".wasm")) headers.set("content-type", "application/wasm");
      return new Response(request.method === "HEAD" ? null : object.body, { headers });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

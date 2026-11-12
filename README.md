# Overheard

Private video/audio transcription for a small group. You drop a file in and it's
transcribed **in your browser** by [Voz from Desert Ant Labs](https://desertant.com/models/voz/).
Nothing is uploaded, and there's no API key or per-use cost.

v1 = file upload only. Video links (YouTube/social) come in v2 via a yt-dlp helper
on the home Ubuntu box.

## How it fits together

```
Browser ──► Cloudflare Worker (free plan)
              ├─ /            static app (Workers Static Assets)
              └─ /vendor/*    two big .wasm files from R2 (too big for Static Assets)
Browser ──► huggingface.co   Voz model weights (~400 MB, first visit only, then cached)
```

- **Why R2:** Static Assets caps files at 25 MiB. `VozWeb.wasm` is 46 MB and ONNX
  Runtime's WebGPU wasm is 29 MB. R2's free tier (10 GB storage, free egress) covers
  this. Keys are versioned, so they're cached forever.
- **Why the Vite plugin:** Voz hardcodes its wasm URL. `vite.config.ts` rewrites it to
  `/vendor/…` and drops the oversized files from `dist/` so `wrangler deploy` passes.

Live at **overheard.manderson.me**, behind one shared group password.

## Deploy

Dashboard-only path: see the **Overheard — Setup Guide** doc (GitHub repo → Workers
Builds, R2 upload in the dashboard, `SITE_PASSWORD` secret on the Worker).

CLI path, if you ever want it:

```bash
npm install
npx wrangler login
npx wrangler r2 bucket create overheard-vendor
npm run upload-wasm                              # uploads the 2 wasm files to R2
npm run deploy                                   # builds + deploys the Worker
```

R2 object names are flat (`voz-4.3.0-VozWeb.wasm`) so they can be uploaded through the
dashboard as-is; the Worker maps `/vendor/voz-4.3.0/VozWeb.wasm` to that name.

Dependency versions are pinned exactly in `package.json`, because the R2 file names
include the Voz and ONNX Runtime versions. Re-run `npm run upload-wasm` (or upload
new files in the dashboard) whenever you upgrade `@desert-ant-labs/voz` or
`onnxruntime-web`. The build fails loudly if Voz changes how it loads its wasm.

### The group password

`worker/auth.ts` gates every request (`run_worker_first: true`). Set the password as a
**Secret** named `SITE_PASSWORD` on the Worker (Settings → Variables and Secrets).

- A correct entry sets a signed, HttpOnly cookie for 90 days. The signature uses the
  password itself, so **changing the password signs everyone out**.
- No secret set → the site shows "not set up yet" and lets nobody in (fails closed).
- Wrong guesses are slowed by 0.75 s each; use a long passphrase (4+ random words).
- Local dev: put `SITE_PASSWORD=...` in `.dev.vars` (git-ignored).

## Develop

```bash
npm run dev      # Vite dev server; /vendor/* served from node_modules
npm test         # caption/SRT/VTT + password/session tests
npm run preview  # build + run the real Worker locally (needs local R2: see below)
```

For `npm run preview`, seed local R2 once: `node scripts/upload-wasm.mjs --local`.

## What to check on first real use

The results header shows **"N× real time on WebGPU/CPU"**. That number answers the
open question: is in-browser Voz fast enough on your group's laptops? Try a
20–30 minute file on the slowest machine anyone will use.

## Known limits

- **Languages:** 25 European languages. Anything else gives confident nonsense,
  not an error.
- **Devices:** needs WebGPU for good speed (recent Chrome/Edge/Safari). Without
  it, it falls back to CPU, which is correct but slow. It uses about 2.5 GB of
  memory, so phones are hit or miss.
- **Formats:** anything the browser's WebCodecs can decode (MP4/MOV/WebM/MP3/M4A/WAV…).
  Some MKV/AVI codecs won't decode, so convert those first.

## Files

| Path | What |
| --- | --- |
| `src/main.ts` | UI: drop zone, progress, results, media sync, exports |
| `src/captions.ts` | Pure functions: words → cues/paragraphs, SRT/VTT |
| `worker/index.ts` | Password gate, then static assets + `/vendor/*` from R2 |
| `worker/auth.ts` | Password check, signed session cookie, login page |
| `vite.config.ts` | Rewrites Voz's wasm URL; strips oversized wasm from the build |
| `scripts/vendor.mjs` | Single source of the versioned R2 keys |
| `scripts/upload-wasm.mjs` | Uploads the wasm files to R2 |

## License note

Voz is under the Desert Ant Labs Source-Available License: free under 100k
monthly active devices per model. The license requires crediting Desert Ant Labs,
which the footer does. Keep it.

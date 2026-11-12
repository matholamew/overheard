// Shared-password gate. One password (the SITE_PASSWORD secret) for the whole
// group; a correct entry sets a signed cookie that lasts SESSION_DAYS.
//
// The cookie is `<expiry>.<hmac>`, signed with the password itself, so
// changing the password in the dashboard logs everyone out at once. Nothing is
// stored server-side.

export const COOKIE = "__Host-overheard";
export const SESSION_DAYS = 90;
const enc = new TextEncoder();

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/** Constant-time comparison of two equal-length byte arrays. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex: string) =>
  /^[0-9a-f]+$/.test(hex) && hex.length % 2 === 0
    ? new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)))
    : new Uint8Array();

/** Compares a submitted password to the real one without leaking timing. */
export async function passwordMatches(submitted: string, actual: string): Promise<boolean> {
  // HMAC both under a fixed key so the compared values are equal length.
  const [a, b] = await Promise.all([hmac("overheard-compare", submitted), hmac("overheard-compare", actual)]);
  return sameBytes(a, b);
}

export async function makeSessionCookie(password: string, now = Date.now()): Promise<string> {
  const expires = now + SESSION_DAYS * 86_400_000;
  const sig = toHex(await hmac(password, `session:${expires}`));
  return (
    `${COOKIE}=${expires}.${sig}; Path=/; Secure; HttpOnly; SameSite=Lax; ` +
    `Max-Age=${SESSION_DAYS * 86_400}`
  );
}

export const clearCookie = `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;

export function readCookie(header: string | null, name = COOKIE): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export async function sessionValid(cookieValue: string | null, password: string, now = Date.now()): Promise<boolean> {
  if (!cookieValue) return false;
  const [expStr, sig] = cookieValue.split(".");
  const expires = Number(expStr);
  if (!Number.isFinite(expires) || expires < now || !sig) return false;
  const expected = await hmac(password, `session:${expires}`);
  return sameBytes(fromHex(sig), expected);
}

export function loginPage(opts: { error?: boolean; notConfigured?: boolean } = {}): string {
  const message = opts.notConfigured
    ? `<p class="err">This site isn't set up yet: the <code>SITE_PASSWORD</code> secret is missing.</p>`
    : opts.error
      ? `<p class="err">That password isn't right.</p>`
      : "";
  const form = opts.notConfigured
    ? ""
    : `<form method="post" action="/__login">
        <label for="pw">Group password</label>
        <input id="pw" name="password" type="password" autocomplete="current-password" required autofocus />
        <button type="submit">Enter</button>
      </form>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex"/>
<title>Overheard</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"/>
<style>
:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#12100e;color:#ece6dd}
.card{width:min(360px,calc(100vw - 40px));background:#1b1815;border:1px solid #322c26;border-radius:12px;padding:28px}
h1{margin:0 0 4px;font-size:24px}h1 span{color:#e8a34a}p{color:#9b9186;margin:0 0 18px;font-size:14px}
label{display:block;font-size:13px;color:#9b9186;margin-bottom:6px}
input{width:100%;box-sizing:border-box;font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #322c26;background:#24201c;color:#ece6dd}
input:focus{outline:2px solid #e8a34a;outline-offset:1px}
button{margin-top:14px;width:100%;font:inherit;font-weight:600;padding:10px;border-radius:8px;border:0;background:#e8a34a;color:#1a1207;cursor:pointer}
.err{color:#e2675a;margin:0 0 14px}code{font-size:13px}
</style></head><body><main class="card">
<h1><span>◆</span> Overheard</h1><p>Private transcription for our group.</p>
${message}${form}
</main></body></html>`;
}

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
<meta name="theme-color" content="#f2ece1"/>
<title>Overheard</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"/>
<style>
:root{color-scheme:light;--paper:#f2ece1;--ink:#1b1813;--soft:#4a4339;--muted:#7d7365;--red:#b8321c}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--paper);color:var(--ink);
font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif}
.card{width:min(420px,100%);text-align:center}
.date{font:11px/1 ui-monospace,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--soft);padding-bottom:10px;border-bottom:1px solid var(--ink)}
h1{margin:12px 0 6px;font-size:64px;line-height:.9;font-weight:900;letter-spacing:-.035em}
.rules{border-top:3px solid var(--ink);padding-top:3px}.rules div{border-top:1px solid var(--ink)}
p{margin:26px 0 22px;font-size:18px;font-style:italic;color:var(--soft)}
form{text-align:left}
label{display:block;font:11px/1 ui-monospace,Menlo,monospace;letter-spacing:.16em;text-transform:uppercase;color:var(--red);margin-bottom:8px}
input{width:100%;font:inherit;font-size:20px;padding:10px 2px;border:0;border-bottom:1px solid var(--ink);background:transparent;color:var(--ink);border-radius:0}
input:focus{outline:none;border-bottom:2px solid var(--red)}
button{margin-top:22px;width:100%;font:500 12px/1 ui-monospace,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;padding:14px;border:1px solid var(--ink);border-radius:0;background:var(--ink);color:var(--paper);cursor:pointer}
button:hover{background:var(--red);border-color:var(--red)}
.err{margin:0 0 18px;font-style:normal;font-size:16px;color:var(--red)}code{font-size:14px}
</style></head><body><main class="card">
<div class="date">Private edition</div>
<h1>Overheard</h1><div class="rules"><div></div></div>
<p>For members of the group. Enter the password to continue.</p>
${message}${form}
</main></body></html>`;
}

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COOKIE,
  makeSessionCookie,
  passwordMatches,
  readCookie,
  sessionValid,
  SESSION_DAYS,
} from "../worker/auth.ts";

const PW = "correct horse battery staple";
const valueOf = (setCookie: string) => setCookie.split(";")[0].slice(COOKIE.length + 1);

test("passwordMatches accepts only the exact password", async () => {
  assert.equal(await passwordMatches(PW, PW), true);
  assert.equal(await passwordMatches("correct horse battery stapl", PW), false);
  assert.equal(await passwordMatches("", PW), false);
  assert.equal(await passwordMatches(PW + " ", PW), false);
});

test("a fresh session cookie is valid and has secure attributes", async () => {
  const header = await makeSessionCookie(PW);
  assert.match(header, /^__Host-overheard=\d+\.[0-9a-f]{64}; /);
  for (const attr of ["Path=/", "Secure", "HttpOnly", "SameSite=Lax"]) assert.ok(header.includes(attr), attr);
  assert.equal(await sessionValid(valueOf(header), PW), true);
});

test("changing the password invalidates existing sessions", async () => {
  const header = await makeSessionCookie(PW);
  assert.equal(await sessionValid(valueOf(header), "a new password"), false);
});

test("expired, tampered, or junk cookies are rejected", async () => {
  const now = Date.now();
  const old = await makeSessionCookie(PW, now - (SESSION_DAYS + 1) * 86_400_000);
  assert.equal(await sessionValid(valueOf(old), PW, now), false);

  const good = valueOf(await makeSessionCookie(PW, now));
  const [exp, sig] = good.split(".");
  // Extending the expiry without re-signing must fail.
  assert.equal(await sessionValid(`${Number(exp) + 1}.${sig}`, PW, now), false);
  // Flipping one hex digit of the signature must fail.
  const flipped = sig.slice(0, -1) + (sig.at(-1) === "0" ? "1" : "0");
  assert.equal(await sessionValid(`${exp}.${flipped}`, PW, now), false);

  for (const junk of [null, "", "abc", "123", "123.", ".deadbeef", "NaN.00", `${exp}.zz`]) {
    assert.equal(await sessionValid(junk, PW, now), false, String(junk));
  }
});

test("readCookie finds the cookie among others", () => {
  assert.equal(readCookie(`a=1; ${COOKIE}=123.abc; b=2`), "123.abc");
  assert.equal(readCookie("a=1; b=2"), null);
  assert.equal(readCookie(null), null);
});

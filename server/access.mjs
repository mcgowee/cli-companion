// Access key check: every request from this computer to the companion's data (/api, /events,
// /bridge, /ingest, /app-files) must carry this computer's access key, either as the
// x-companion-key header (the Pi extension, the cli-companion command) or as a cookie the
// window got when it was opened with ?key=… (the server swaps the address for the cookie and
// redirects, so the key isn't left in the address bar). The page itself (/, scripts, styles,
// icons) and /healthz stay open. Phone requests over Tailscale are checked by your Tailscale
// identity instead (server/remote.mjs).
//
// Why: the server listens on 127.0.0.1, which every account on a shared computer can reach.

import { timingSafeEqual } from "node:crypto";

export const ACCESS_HEADER = "x-companion-key";

/** Paths that need the key. */
export function needsKey(pathname) {
  return (
    pathname.startsWith("/api/") ||
    pathname === "/events" ||
    pathname.startsWith("/bridge/") ||
    pathname === "/ingest" ||
    pathname.startsWith("/app-files/")
  );
}

/** The cookie's name, per port: cookies are shared across ports on one host. */
export const cookieName = (port) => `cli_companion_key_${port}`;

/** The Set-Cookie value for the key (HttpOnly, same-site only, ~10 years). */
export function keyCookie(port, key) {
  return `${cookieName(port)}=${key}; Path=/; HttpOnly; SameSite=Strict; Max-Age=315360000`;
}

function readCookie(header, name) {
  for (const part of String(header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return "";
}

/** Same key? (constant time) */
export function sameKey(given, key) {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(String(key ?? ""));
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

/** Does the request carry the key, as a header or the cookie? */
export function hasKey(headers, { port, key }) {
  return sameKey(headers?.[ACCESS_HEADER], key) || sameKey(readCookie(headers?.cookie, cookieName(port)), key);
}

/** The page shown at / when the window wasn't opened with the key. */
export function lockedPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>CLI Companion</title>
<style>
  :root { color-scheme: light dark; --bg: #f7f7f5; --ink: #1d1d1b; --muted: #5d5d58; --code: #ebebe6; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1b1b1a; --ink: #ececea; --muted: #a5a5a0; --code: #2a2a28; } }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 system-ui, sans-serif; }
  main { max-width: 34rem; margin: 12vh auto; padding: 0 16px; }
  h1 { font-size: 1.3rem; margin: 0 0 .5rem; }
  p { color: var(--muted); }
  code { background: var(--code); padding: .1rem .35rem; border-radius: 4px; font-size: .92em; }
</style></head>
<body><main>
  <h1>Open CLI Companion from its shortcut</h1>
  <p>This window doesn't have your access key, so the companion won't show your sessions here.</p>
  <p>Open it with the CLI Companion shortcut, or run <code>cli-companion</code> in a terminal
  (or <code>/companion</code> in Pi). To open it in another browser, run
  <code>cli-companion --print-url</code> and open the address it prints.</p>
</main></body></html>`;
}

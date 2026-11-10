// Phone access over Tailscale. Off unless you switch it on in Settings (on this computer).
//
// How: `tailscale serve` (Tailscale's own HTTPS proxy, reachable only inside your tailnet) forwards
// https://<this machine>.<tailnet>.ts.net to this server on 127.0.0.1. The server itself still
// listens on 127.0.0.1 only. Serve sets Tailscale-User-Login to the tailnet account that sent the
// request (and replaces any such header a client sends), so a request is accepted only when:
//   - phone access is on,
//   - it is addressed to this machine's tailnet name, and
//   - it comes from the account that owns this machine's Tailscale (your own devices).
// From the phone: read everything (GET), and, only if "Allow replies" is on, send to a running Pi
// session (/api/send). Never: terminals, handoff to a CLI, settings, shortcuts, restart, dashboards.
//
// State is in ~/.cli-companion/remote.json: { enabled, reply, host, login }. Turning it off
// removes the serve entry, and only if it is the one pointing at this server.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const REMOTE_DEFAULTS = { enabled: false, reply: false, host: "", login: "" };
const LOOPBACK = ["127.0.0.1", "localhost"];

/** Paths a phone may use with a method other than GET/HEAD. */
const REMOTE_WRITES = { "/api/send": "reply" };

/**
 * Who sent this request?
 * @returns {{ ok: true, remote: false } | { ok: true, remote: true, login } | { ok: false, status, reason }}
 */
export function classifyRequest({ host, headers }, { port, remote = REMOTE_DEFAULTS }) {
  const h = String(host ?? "").toLowerCase();
  const login = String(headers?.["tailscale-user-login"] ?? "").toLowerCase();
  const forwarded = Boolean(headers?.["x-forwarded-for"] || login);
  if (!forwarded && LOOPBACK.some((name) => h === `${name}:${port}`)) return { ok: true, remote: false };
  if (!remote.enabled || !remote.host || !remote.login) return { ok: false, status: 421, reason: "wrong host" };
  const name = h.replace(/:443$/, "");
  if (name !== remote.host.toLowerCase()) return { ok: false, status: 421, reason: "wrong host" };
  if (!login || login !== remote.login.toLowerCase()) return { ok: false, status: 403, reason: "not your Tailscale account" };
  return { ok: true, remote: true, login };
}

/** May a phone (remote request) do this? */
export function remoteAllowed(method, pathname, remote = REMOTE_DEFAULTS) {
  if (pathname.startsWith("/bridge/") || pathname === "/ingest") return false;
  // The Terminal tab (running commands, reading their output) is for the computer only.
  if (pathname === "/api/run" || pathname.startsWith("/api/run/") || pathname === "/api/runs") return false;
  // The folder list can run ssh, and Choose… opens a window on the computer: computer only too.
  if (pathname === "/api/envs/folders" || pathname === "/api/envs/choose-folder") return false;
  if (method === "GET" || method === "HEAD") return true;
  const needs = REMOTE_WRITES[pathname];
  return Boolean(needs && remote[needs]);
}

export async function loadRemote(file) {
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    return {
      enabled: data.enabled === true,
      reply: data.reply === true,
      host: typeof data.host === "string" ? data.host : "",
      login: typeof data.login === "string" ? data.login : "",
    };
  } catch {
    return { ...REMOTE_DEFAULTS };
  }
}

export async function saveRemote(file, remote) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ ...REMOTE_DEFAULTS, ...remote }, null, 2)}\n`);
}

/* ── Tailscale CLI ── */

export function tailscaleBinary(platform = process.platform, env = process.env) {
  const candidates =
    platform === "win32"
      ? [join(env.ProgramFiles || "C:\\Program Files", "Tailscale", "tailscale.exe")]
      : platform === "darwin"
        ? ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"]
        : ["/usr/bin/tailscale", "/usr/local/bin/tailscale"];
  return candidates.find((c) => existsSync(c)) ?? "tailscale";
}

function tailscale(args, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    execFile(tailscaleBinary(), args, { windowsHide: true, timeout }, (error, stdout, stderr) => {
      if (error) {
        const text = String(stderr || stdout || error.message).trim();
        reject(new Error(error.code === "ENOENT" ? "Tailscale isn't installed on this computer." : text.split("\n").slice(0, 6).join("\n")));
      } else resolve(String(stdout));
    });
  });
}

/** From `tailscale status --json`: this machine's tailnet name and the account that owns it. */
export function selfFromStatus(status) {
  const self = status?.Self;
  if (!self) return null;
  const host = String(self.DNSName ?? "").replace(/\.$/, "");
  const login = status.User?.[String(self.UserID)]?.LoginName ?? "";
  return { host, login, online: self.Online !== false, running: status.BackendState === "Running" };
}

export async function tailscaleSelf() {
  return selfFromStatus(JSON.parse(await tailscale(["status", "--json"])));
}

/** The proxy target serve uses for https://host:443/, or "" if none. */
export function serveTarget(serveStatus, host) {
  const web = serveStatus?.Web ?? {};
  const handlers = web[`${host}:443`]?.Handlers ?? {};
  return handlers["/"]?.Proxy ?? "";
}

async function serveStatus() {
  const text = await tailscale(["serve", "status", "--json"]).catch(() => "{}");
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}

const ours = (target, port) => /^https?:\/\/(127\.0\.0\.1|localhost):(\d+)\/?$/.test(target) && target.match(/:(\d+)\/?$/)[1] === String(port);

/** Turn serve on for this server. Refuses to replace a serve entry that points somewhere else. */
export async function serveOn(port) {
  const me = await tailscaleSelf();
  if (!me?.running) throw new Error("Tailscale isn't connected. Open Tailscale and sign in, then try again.");
  if (!me.host || !me.login) throw new Error("Couldn't read this computer's Tailscale name or account.");
  const target = serveTarget(await serveStatus(), me.host);
  if (target && !ours(target, port)) {
    throw new Error(`Tailscale already serves ${target} at https://${me.host}/. Turn that off first (tailscale serve --https=443 off).`);
  }
  if (!target) await tailscale(["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`], 60_000);
  return me;
}

/** Turn serve off, but only the entry pointing at this server. */
export async function serveOff(port) {
  const me = await tailscaleSelf().catch(() => null);
  if (!me?.host) return;
  const target = serveTarget(await serveStatus(), me.host);
  if (target && ours(target, port)) await tailscale(["serve", "--https=443", "off"]);
}

/** Is serve currently pointing at this server? */
export async function serving(port, host) {
  if (!host) return false;
  return ours(serveTarget(await serveStatus(), host), port);
}

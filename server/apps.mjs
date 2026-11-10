// Apps a session made, for the right panel's Apps tab: links found in the last exchange only (your
// last message and the CLI's reply to it), not the whole session, to keep noise down. The reply's
// come first; a path you typed yourself ("look at videos/x/preview.html") shows up too.
// Found by pattern (no model):
//   - web addresses on this computer (localhost, 127.0.0.1, [::1]), e.g. a dev server, or on your
//     tailnet (Tailscale's 100.64.0.0/10, *.ts.net) and the SSH computers you added (names and
//     addresses). Public and other LAN links are left out (docs links are noise). For a
//     session running on an SSH computer, its localhost links point at that computer;
//   - files inside the session's own folder that the panel can show: .html pages, images, video,
//     audio, PDFs and plain text (.txt .md .csv .log). Code files are left out (too noisy).

import { isAbsolute, relative, resolve } from "node:path";
import { resolveInside } from "./workbench.mjs";

const MAX_APPS = 20;

/** File types the panel can show, by extension. */
const KINDS = {
  html: ["html", "htm"],
  image: ["png", "jpg", "jpeg", "gif", "webp", "svg"],
  video: ["mp4", "webm", "mov", "m4v"],
  audio: ["mp3", "wav", "ogg", "m4a"],
  pdf: ["pdf"],
  text: ["txt", "md", "csv", "log"],
};
const EXT_KIND = new Map(Object.entries(KINDS).flatMap(([kind, exts]) => exts.map((ext) => [ext, kind])));
// Longest first, so "jpeg" wins over "jpe…" and "html" over "htm".
const EXT = `(?:${[...EXT_KIND.keys()].sort((a, b) => b.length - a.length).join("|")})`;

/** "html" | "image" | "video" | "audio" | "pdf" | "text", or undefined for anything else. */
export function fileKind(path) {
  const m = String(path ?? "").match(/\.([a-z0-9]+)$/i);
  return m ? EXT_KIND.get(m[1].toLowerCase()) : undefined;
}

// Characters that end a link or path in prose and markdown.
const TRAILING = /[.,;:!?'"`)\]}>*_]+$/;
const ANY_URL = /\bhttps?:\/\/[^\s<>"'`|)\]]+/gi;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** True for an address on your tailnet: Tailscale's 100.64.0.0/10 or a *.ts.net name. */
export function isOwnNetwork(hostname) {
  const h = String(hostname ?? "").toLowerCase();
  if (h.endsWith(".ts.net")) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some((x) => Number(x) > 255)) return false;
  return a === 100 && b >= 64 && b <= 127;
}
const FILE_URL = new RegExp(String.raw`\bfile:\/\/\/?[^\s<>"'` + "`" + String.raw`|)\]]+?\.${EXT}\b`, "gi");
// In backticks or quotes a path may hold spaces; elsewhere it ends at whitespace.
const QUOTED_FILE = new RegExp("[`\"']([^`\"'\\n<>|]+?\\." + EXT + ")[`\"']", "gi");
const BARE_FILE = new RegExp(String.raw`(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?(?:[\w.@~+-]+[\\/])*[\w.@~+-]+\.${EXT}\b`, "gi");

/**
 * Links and .html paths in a reply, in the order they appear, without repeats.
 * `exclude` holds origins never to list (the companion itself).
 */
/** The text the Apps tab scans for an exchange from lastExchange(): the reply, then your message. */
export function exchangeText(exchange) {
  return [exchange?.reply, exchange?.ask].filter(Boolean).join("\n\n");
}

/**
 * `hosts`: extra host names to accept (the SSH computers you added and their addresses).
 * `remoteHost`: the address of the SSH computer the session runs on; its localhost links go there.
 */
export function findApps(text, { exclude = [], hosts = [], remoteHost } = {}) {
  const source = String(text ?? "");
  const known = new Set(hosts.map((h) => String(h).toLowerCase()));
  const urls = [];
  const seenUrls = new Set();
  for (const match of source.matchAll(ANY_URL)) {
    let href = match[0].replace(TRAILING, "");
    try {
      const url = new URL(href);
      const host = url.hostname.toLowerCase();
      if (LOOPBACK.has(host)) {
        if (remoteHost) url.hostname = remoteHost;
        else if (exclude.includes(url.origin)) continue;
      } else if (!isOwnNetwork(host) && !known.has(host)) continue;
      href = url.href;
    } catch {
      continue;
    }
    if (seenUrls.has(href)) continue;
    seenUrls.add(href);
    urls.push(href);
  }

  // Paths: everything that is not part of a web address.
  const rest = source.replace(ANY_URL, " ").replace(/\bhttps?:\/\/\S+/gi, " ");
  const files = [];
  const seenFiles = new Set();
  const addFile = (raw) => {
    let path = raw.trim().replace(TRAILING, "");
    if (/^file:/i.test(path)) {
      try {
        path = decodeURIComponent(new URL(path).pathname).replace(/^\/([A-Za-z]:)/, "$1");
      } catch {
        return;
      }
    }
    if (!fileKind(path)) return;
    const key = path.replace(/\\/g, "/").toLowerCase();
    if (seenFiles.has(key)) return;
    seenFiles.add(key);
    files.push(path);
  };
  for (const match of rest.matchAll(FILE_URL)) addFile(match[0]);
  const withoutFileUrls = rest.replace(FILE_URL, " ");
  for (const match of withoutFileUrls.matchAll(QUOTED_FILE)) addFile(match[1]);
  for (const match of withoutFileUrls.replace(QUOTED_FILE, " ").matchAll(BARE_FILE)) addFile(match[0]);
  return { urls: urls.slice(0, MAX_APPS), files: files.slice(0, MAX_APPS) };
}

/**
 * Where a mentioned .html file is inside the workspace: its path relative to `root` with forward
 * slashes, or null when it is missing or outside the folder (those are never served).
 */
export async function resolveAppFile(root, path) {
  const raw = String(path ?? "");
  let rel = raw;
  if (isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    rel = relative(resolve(root), resolve(raw));
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  }
  try {
    const real = await resolveInside(root, rel);
    const realRoot = await resolveInside(root, "");
    return relative(realRoot, real).split(/[\\/]/).join("/");
  } catch {
    return null;
  }
}

/** Display name for a web address: host:port and the path when there is one. */
export function urlName(href) {
  try {
    const url = new URL(href);
    const path = url.pathname === "/" ? "" : url.pathname;
    return `${url.host}${path}${url.search}`;
  } catch {
    return href;
  }
}

/** Content types for files served from a workspace (anything else is a download). */
export const APP_MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".pdf": "application/pdf",
  ".csv": "text/csv; charset=utf-8",
  ".wasm": "application/wasm",
};

/**
 * Headers for a served workspace file. The sandbox gives the page its own opaque origin, so its
 * scripts can't use the companion's API even when it's opened on its own.
 */
export const APP_FILE_HEADERS = {
  "content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads",
  "x-content-type-options": "nosniff",
  "cache-control": "no-cache",
};

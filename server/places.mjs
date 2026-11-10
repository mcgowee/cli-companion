// The Workspaces menu: folders you added by hand, and computers you reach over SSH.
// Kept in ~/.cli-companion/places.json:
//   { "folders": [{ "id", "path" }], "hosts": [{ "id", "host" }] }
// A folder is an absolute local path that shows in the sidebar even before it has a session; its
// terminal menu is the usual one (server/launch.mjs). A host is a name `ssh` understands (an
// ~/.ssh/config alias or user@name); the server lists the folders under ~/projects there and opens
// a terminal in a tmux session in one (attach or create, so it survives a dropped connection).
//
// Hard rules: the page names a host id, a folder name and an action, never a command. Host names
// and folder names are checked against tight patterns (no spaces, quotes, or a leading "-"), so
// every piece of the ssh command line is a plain word; the remote side runs only the fixed tmux
// line built here.

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse } from "node:path";
import { tmuxName } from "./launch.mjs";

export class PlaceError extends Error {}

const MAX = 100;
const HOST = /^[A-Za-z0-9_][\w.@-]{0,99}$/;
/** A folder under REMOTE_ROOT: plain names joined by "/" (no "..", no leading "-" or "."). */
const REL = /^[\w][\w.-]{0,99}(\/[\w][\w.-]{0,99}){0,5}$/;
/** What the search box may send: a plain word. */
const QUERY = /^[\w.-]{1,60}$/;
/** Folders the search never goes into (big, generated, or hidden). */
const SKIP = new Set(["node_modules", "__pycache__", "venv", ".venv", "site-packages", "python_embeded", "$recycle.bin", "appdata", "windows", "program files", "program files (x86)", "programdata"]);
/** Where the remote folders are. Fixed for now; one setting later if needed. */
export const REMOTE_ROOT = "~/projects";
/** What a remote folder can be opened with. Pi only for now (Claude Code later). */
export const REMOTE_ACTIONS = [
  { action: "shell", label: "Terminal" },
  { action: "pi", label: "Pi" },
];

export function checkHost(host) {
  const h = String(host ?? "").trim();
  if (!HOST.test(h)) throw new PlaceError("An SSH name is letters, digits and . _ - @ (as you'd type after ssh), with no spaces.");
  return h;
}

/** A folder under REMOTE_ROOT, like "charloop" or "pi/charloop". */
export function checkFolderName(name) {
  const n = String(name ?? "");
  if (!REL.test(n) || n.split("/").some((part) => part === "." || part === "..")) throw new PlaceError("That isn't a folder name.");
  return n;
}

export function checkQuery(q) {
  const s = String(q ?? "").trim();
  if (!QUERY.test(s)) throw new PlaceError("Search for part of a folder name: letters, digits, . _ -");
  return s;
}

/**
 * Where to search on this computer: your home folder, plus the top folder of each workspace the
 * companion knows (C:\AI for C:\AI\pi\companion), except ones that hold your home folder.
 */
export function localRoots(home, workspaceDirs, platform = process.platform) {
  const roots = new Map([[home.toLowerCase(), home]]);
  const homeLow = home.toLowerCase();
  for (const dir of workspaceDirs) {
    if (!dir || !isAbsolute(dir)) continue;
    const { root } = parse(dir);
    // On Windows only drive paths (a Linux path from another computer's index has no drive).
    if (platform === "win32" && !/^[A-Za-z]:[\\/]$/.test(root)) continue;
    const first = dir.slice(root.length).split(/[\\/]/).filter(Boolean)[0];
    // Never the system's own folders (Windows, Program Files, …): slow, and not projects.
    if (!first || SKIP.has(first.toLowerCase()) || /^(usr|etc|var|opt|proc|sys|bin|lib|tmp|private|system)$/i.test(first)) continue;
    const top = join(root, first);
    const low = top.toLowerCase();
    if (homeLow.startsWith(low) || low.startsWith(homeLow)) continue;
    roots.set(low, top);
  }
  return [...roots.values()];
}

/**
 * Folders whose name contains `q` (any case) under `roots`, breadth first, at most `maxDepth`
 * levels down. Hidden and generated folders are skipped; stops at `limit` results, `maxDirs`
 * folders looked at, or `maxMs`. Returns [{ path, name }] and whether it stopped early.
 */
export async function searchLocal(roots, q, { maxDepth = 4, limit = 40, maxDirs = 40000, maxMs = 2500 } = {}) {
  const needle = checkQuery(q).toLowerCase();
  const started = Date.now();
  const found = [];
  const seen = new Set();
  let queue = roots.map((dir) => ({ dir, depth: 0 }));
  let looked = 0;
  let partial = false;
  while (queue.length) {
    const next = [];
    for (const { dir, depth } of queue) {
      if (found.length >= limit || looked >= maxDirs || Date.now() - started > maxMs) {
        partial = true;
        return { folders: found, partial };
      }
      looked++;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".") || SKIP.has(e.name.toLowerCase())) continue;
        const path = join(dir, e.name);
        const key = path.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (e.name.toLowerCase().includes(needle)) found.push({ path, name: e.name });
        if (depth + 1 < maxDepth) next.push({ dir: path, depth: depth + 1 });
      }
    }
    queue = next;
  }
  return { folders: found.slice(0, limit), partial };
}

/** The fixed remote script that searches REMOTE_ROOT (3 levels down) for folder names containing `q`. */
export function remoteSearchScript(q) {
  const s = checkQuery(q);
  return `cd ${REMOTE_ROOT} 2>/dev/null && find . -mindepth 1 -maxdepth 3 \\( -name node_modules -o -name '.*' -o -name venv -o -name __pycache__ \\) -prune -o -type d -iname '*${s}*' -printf 'F%P\\n' 2>/dev/null | head -60; tmux ls -F 'S#{session_name}' 2>/dev/null; true`;
}

export async function loadPlaces(file) {
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    const folders = (Array.isArray(data?.folders) ? data.folders : [])
      .filter((f) => typeof f?.id === "string" && typeof f?.path === "string" && isAbsolute(f.path))
      .map(({ id, path }) => ({ id, path }));
    const hosts = (Array.isArray(data?.hosts) ? data.hosts : [])
      .filter((h) => typeof h?.id === "string" && typeof h?.host === "string" && HOST.test(h.host))
      .map(({ id, host }) => ({ id, host }));
    return { folders: folders.slice(0, MAX), hosts: hosts.slice(0, MAX) };
  } catch {
    return { folders: [], hosts: [] };
  }
}

async function save(file, places) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(places, null, 2)}\n`);
  await rename(tmp, file);
}

const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Add a local folder (must exist). Returns the new places; adding one twice is a no-op. */
export async function addFolder(file, path) {
  const p = String(path ?? "").trim().replace(/^["']|["']$/g, "").replace(/[\\/]+$/, "") || "";
  if (!p || !isAbsolute(p)) throw new PlaceError("Give the folder's full path.");
  const info = await stat(p).catch(() => null);
  if (!info?.isDirectory()) throw new PlaceError(`There's no folder at ${p}.`);
  const places = await loadPlaces(file);
  if (places.folders.some((f) => samePath(f.path, p))) return places;
  if (places.folders.length >= MAX) throw new PlaceError(`At most ${MAX} folders.`);
  places.folders.push({ id: randomUUID(), path: p });
  await save(file, places);
  return places;
}

export async function addHost(file, host) {
  const h = checkHost(host);
  const places = await loadPlaces(file);
  if (places.hosts.some((x) => x.host === h)) return places;
  if (places.hosts.length >= MAX) throw new PlaceError(`At most ${MAX} computers.`);
  places.hosts.push({ id: randomUUID(), host: h });
  await save(file, places);
  return places;
}

/** Remove a folder or host by id (kind "folder" | "host"). Returns the new places. */
export async function removePlace(file, kind, id) {
  const places = await loadPlaces(file);
  const key = kind === "host" ? "hosts" : kind === "folder" ? "folders" : null;
  if (!key) throw new PlaceError("Unknown kind.");
  const kept = places[key].filter((x) => x.id !== id);
  if (kept.length !== places[key].length) {
    places[key] = kept;
    await save(file, places);
  }
  return places;
}

/** The fixed remote script that lists the folders under REMOTE_ROOT and the running tmux sessions. */
export function remoteListScript() {
  return `cd ${REMOTE_ROOT} 2>/dev/null && for d in */; do printf 'F%s\\n' "\${d%/}"; done; tmux ls -F 'S#{session_name}' 2>/dev/null; true`;
}

/**
 * The list or search output → [{ name, tmux, running }]: `name` is the folder under REMOTE_ROOT
 * ("charloop" or "pi/charloop"); ones that aren't plain names are left out.
 */
export function parseRemoteList(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const sessions = new Set(lines.filter((l) => l.startsWith("S")).map((l) => l.slice(1)));
  return lines
    .filter((l) => l.startsWith("F"))
    .map((l) => l.slice(1))
    .filter((name) => REL.test(name) && !name.split("/").some((p) => p === "." || p === ".."))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map((name) => ({ name, tmux: tmuxName(basename(name)), running: sessions.has(tmuxName(basename(name))) }));
}

/**
 * The words after `ssh` to open folder `name` on `host` in its tmux session: attach if it's
 * running, else create it in that folder (running Pi, for action "pi", through a login shell so
 * ~/.local/bin is on PATH). Every word is plain: ssh joins them with spaces for the remote shell,
 * which expands the ~.
 */
export function sshArgs(host, name, action) {
  checkHost(host);
  checkFolderName(name);
  if (!REMOTE_ACTIONS.some((a) => a.action === action)) throw new PlaceError("That isn't available here.");
  return ["-t", host, "tmux", "new-session", "-A", "-s", tmuxName(basename(name)), "-c", `${REMOTE_ROOT}/${name}`, ...(action === "pi" ? ["bash", "-lc", "pi"] : [])];
}

/** The same as one line to paste (PowerShell or a POSIX shell): the ~ path quoted so it reaches the remote side as is. */
export function sshCopyLine(host, name, action) {
  return ["ssh", ...sshArgs(host, name, action)].map((w) => (w.startsWith("~") ? `'${w}'` : w)).join(" ");
}

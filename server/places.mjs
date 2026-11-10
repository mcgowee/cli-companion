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
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { tmuxName } from "./launch.mjs";

export class PlaceError extends Error {}

const MAX = 100;
const HOST = /^[A-Za-z0-9_][\w.@-]{0,99}$/;
const FOLDER = /^[\w][\w.-]{0,199}$/;
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

export function checkFolderName(name) {
  const n = String(name ?? "");
  if (!FOLDER.test(n)) throw new PlaceError("That isn't a folder name.");
  return n;
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

/** Its output → [{ name, tmux, running }], names that aren't plain folder names left out. */
export function parseRemoteList(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const sessions = new Set(lines.filter((l) => l.startsWith("S")).map((l) => l.slice(1)));
  return lines
    .filter((l) => l.startsWith("F"))
    .map((l) => l.slice(1))
    .filter((name) => FOLDER.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map((name) => ({ name, tmux: tmuxName(name), running: sessions.has(tmuxName(name)) }));
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
  return ["-t", host, "tmux", "new-session", "-A", "-s", tmuxName(name), "-c", `${REMOTE_ROOT}/${name}`, ...(action === "pi" ? ["bash", "-lc", "pi"] : [])];
}

/** The same as one line to paste (PowerShell or a POSIX shell): the ~ path quoted so it reaches the remote side as is. */
export function sshCopyLine(host, name, action) {
  return ["ssh", ...sshArgs(host, name, action)].map((w) => (w.startsWith("~") ? `'${w}'` : w)).join(" ");
}

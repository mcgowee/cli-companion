// Environments: where "New session" starts Pi, picked at the bottom of the sidebar (like the
// environment picker in the Claude Code desktop app). Kept in ~/.cli-companion/environments.json:
//   { "current": "<id>", "envs": [{ "id", "name", "kind": "local", "path" }
//                                 | { "id", "name", "kind": "ssh", "host", "path" }] }
// "This computer" (your home folder, id "local") is always there and isn't stored.
//
// Local: a terminal in the folder running `pi`. SSH: a terminal running `ssh -t <host>` into a tmux
// session named after the folder: a new Pi window in it if the session is already there, else
// the session is created running Pi; either way you're attached, and it survives a dropped
// connection.
//
// Hard rules: the page names an environment id, never a command. Host names and remote paths are
// checked against tight patterns (plain words: no spaces, quotes or a leading "-"), so the remote
// line is built from fixed text and those words only.

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse } from "node:path";
import { tmuxName } from "./launch.mjs";

export class EnvError extends Error {}

export const LOCAL_ID = "local";
const MAX = 100;
const HOST = /^[A-Za-z0-9_][\w.@-]{0,99}$/;
/** A remote folder: ~, ~/a/b, or /a/b, each part a plain name. */
const REMOTE_PATH = /^(~|~(\/[\w][\w.-]{0,99}){1,8}|(\/[\w][\w.-]{0,99}){1,8})$/;

export function checkHost(host) {
  const h = String(host ?? "").trim();
  if (!HOST.test(h)) throw new EnvError("The SSH computer is what you type after ssh (like aegis or me@192.168.1.5): letters, digits and . _ - @, no spaces.");
  return h;
}

export function checkRemotePath(path) {
  const p = String(path ?? "").trim().replace(/\/+$/, "") || "~";
  if (!REMOTE_PATH.test(p) || p.split("/").some((part) => part === "." || part === "..")) {
    throw new EnvError("The folder there is ~, ~/folder/sub or /full/path, with plain folder names (letters, digits, . _ -).");
  }
  return p;
}

function checkName(name) {
  const n = String(name ?? "").replace(/\s+/g, " ").trim();
  if (!n || n.length > 60 || /[\u0000-\u001f]/.test(n)) throw new EnvError("Give it a name (up to 60 characters).");
  return n;
}

function clean(e) {
  if (typeof e?.id !== "string" || e.id === LOCAL_ID || typeof e?.name !== "string") return null;
  if (e.kind === "local" && typeof e.path === "string" && isAbsolute(e.path)) return { id: e.id, name: e.name, kind: "local", path: e.path };
  if (e.kind === "ssh" && typeof e.host === "string" && HOST.test(e.host) && typeof e.path === "string" && REMOTE_PATH.test(e.path)) {
    return { id: e.id, name: e.name, kind: "ssh", host: e.host, path: e.path };
  }
  return null;
}

/** The built-in "This computer" plus the saved ones, and which is picked. */
export async function loadEnvs(file, home) {
  let data = {};
  try {
    data = JSON.parse(await readFile(file, "utf8"));
  } catch {
    // none yet
  }
  const envs = [{ id: LOCAL_ID, name: "This computer", kind: "local", path: home }, ...(Array.isArray(data.envs) ? data.envs.map(clean).filter(Boolean).slice(0, MAX) : [])];
  const current = envs.some((e) => e.id === data.current) ? data.current : LOCAL_ID;
  return { envs, current };
}

async function save(file, { envs, current }) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ current, envs: envs.filter((e) => e.id !== LOCAL_ID) }, null, 2)}\n`);
  await rename(tmp, file);
}

/** Add one ({ name, kind, path, host }); it becomes the picked one. Returns the new state. */
export async function addEnv(file, home, input) {
  const name = checkName(input?.name);
  let env;
  if (input?.kind === "ssh") {
    env = { id: randomUUID(), name, kind: "ssh", host: checkHost(input.host), path: checkRemotePath(input.path) };
  } else if (input?.kind === "local") {
    // The folder is optional: none means your home folder.
    const raw = String(input.path ?? "").trim().replace(/^["']|["']$/g, "");
    // Trailing slashes off, but a drive or filesystem root (C:\, /) stays as it is.
    const path = (/^([A-Za-z]:)?[\\/]$/.test(raw) ? raw : raw.replace(/[\\/]+$/, "")) || home;
    if (!path || !isAbsolute(path)) throw new EnvError("Give the folder's full path.");
    if (!(await stat(path).catch(() => null))?.isDirectory()) throw new EnvError(`There's no folder at ${path}.`);
    env = { id: randomUUID(), name, kind: "local", path };
  } else {
    throw new EnvError("Pick Local or SSH.");
  }
  const state = await loadEnvs(file, home);
  if (state.envs.length > MAX) throw new EnvError(`At most ${MAX} environments.`);
  state.envs.push(env);
  state.current = env.id;
  await save(file, state);
  return state;
}

export async function removeEnv(file, home, id) {
  if (id === LOCAL_ID) throw new EnvError("This computer can't be removed.");
  const state = await loadEnvs(file, home);
  state.envs = state.envs.filter((e) => e.id !== id);
  if (state.current === id) state.current = LOCAL_ID;
  await save(file, state);
  return state;
}

export async function pickEnv(file, home, id) {
  const state = await loadEnvs(file, home);
  if (!state.envs.some((e) => e.id === id)) throw new EnvError("That environment is gone.");
  state.current = id;
  await save(file, state);
  return state;
}

/** The tmux session for a remote folder: its last part, or the host's name for ~. */
export function remoteSessionName(host, path) {
  return path === "~" ? tmuxName(host.split("@").pop()) : tmuxName(basename(path));
}

/**
 * What runs on the SSH computer for New session: a new Pi window in the folder's tmux session if
 * it's there, else the session created running Pi; then attached. Pi goes through a login shell
 * so ~/.local/bin is on PATH. Plain words only (see the checks above); the ~ is left for the
 * remote shell to expand.
 */
export function remotePiLine(host, path, { tunnel = 0 } = {}) {
  const h = checkHost(host);
  const p = checkRemotePath(path);
  const s = remoteSessionName(h, p);
  // With a tunnel: Pi's companion extension there reports to the tunnel's port, with this
  // computer's key (kept apart from that computer's own companion, in TUNNEL_HOME).
  const e = tunnel ? ` -e CLI_COMPANION_PORT=${Number(tunnel)} -e CLI_COMPANION_HOME=${TUNNEL_HOME}` : "";
  return `tmux has-session -t =${s} 2>/dev/null && tmux new-window${e} -t =${s}: -c ${p} bash -lc pi; tmux new-session${e} -A -s ${s} -c ${p} bash -lc pi`;
}

/* ── Live SSH sessions in this companion: a reverse tunnel ── */
//
// New session (and Copy) add `-R <tunnel port>:127.0.0.1:<this server's port>` to the ssh line, and
// start Pi there with CLI_COMPANION_PORT=<tunnel port>. Pi's companion extension on that computer
// then posts to this server through the tunnel, with Host 127.0.0.1:<tunnel port>, which is how the
// server knows the session runs on that computer. Its history is read over ssh.

/** Where, on the SSH computer, this computer's access key is kept for the tunnel ($HOME expanded there). */
export const TUNNEL_HOME = "$HOME/.cli-companion-tunnel";

/** The port the tunnel listens on, on that computer: fixed per computer name, 31000–31899. */
export function tunnelPort(host) {
  let h = 2166136261;
  for (const ch of checkHost(host).toLowerCase()) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return 31000 + (h % 900);
}

/** The fixed remote script that stores this computer's key (sent on stdin, never on the command line). */
export function keyPushScript() {
  return `umask 077; mkdir -p "${TUNNEL_HOME}" && cat > "${TUNNEL_HOME}/access-key.tmp" && mv -f "${TUNNEL_HOME}/access-key.tmp" "${TUNNEL_HOME}/access-key"`;
}

/** A Pi session file there, as the extension reports it: an absolute .jsonl path of plain names under a sessions folder. */
const REMOTE_SESSION_FILE = /^(\/[\w.-]{1,200}){2,20}\.jsonl$/;
export function checkRemoteSessionFile(file) {
  const f = String(file ?? "");
  if (!REMOTE_SESSION_FILE.test(f) || !f.includes("/sessions/") || f.split("/").some((p) => p === "." || p === "..")) return undefined;
  return f;
}

/**
 * The fixed remote script that prints a session file's size, a newline, then its bytes from
 * `offset` on (at most `max`), so a growing file is read in pieces.
 */
export function remoteReadScript(file, offset = 0, max = 64 * 1024 * 1024) {
  const f = checkRemoteSessionFile(file);
  if (!f) throw new EnvError("Not a Pi session file.");
  const off = Math.max(0, Math.floor(Number(offset) || 0));
  return `s=$(stat -c %s ${f}) || exit 3; echo "$s"; tail -c +${off + 1} ${f} | head -c ${Math.floor(max)}`;
}

/* ── folder search for + New environment ── */

/** What the Folder box may search for: a plain word. */
const QUERY = /^[\w.-]{2,60}$/;
/** Folders the search never goes into (big, generated, hidden, or the system's own). */
const SKIP = new Set(["node_modules", "__pycache__", "venv", ".venv", "site-packages", "python_embeded", "$recycle.bin", "appdata", "windows", "program files", "program files (x86)", "programdata"]);

export function checkQuery(q) {
  const s = String(q ?? "").trim();
  if (!QUERY.test(s)) throw new EnvError("Type part of a folder name (letters, digits, . _ -), or a full path.");
  return s;
}

/**
 * Where to search on this computer: your home folder, plus the top folder of each workspace the
 * companion knows (C:\AI for C:\AI\pi\companion), except system folders and ones holding home.
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
    if (!first || SKIP.has(first.toLowerCase()) || /^(usr|etc|var|opt|proc|sys|bin|lib|tmp|private|system)$/i.test(first)) continue;
    const top = join(root, first);
    const low = top.toLowerCase();
    if (homeLow.startsWith(low) || low.startsWith(homeLow)) continue;
    roots.set(low, top);
  }
  return [...roots.values()];
}

/**
 * Folders whose name contains `q` (any case) under `roots`, breadth first (shallow ones first),
 * at most `maxDepth` levels down; hidden and SKIP folders left out. Stops at `limit` results,
 * `maxDirs` folders looked at, or `maxMs`. Returns [{ path, name }].
 */
export async function searchLocal(roots, q, { maxDepth = 4, limit = 30, maxDirs = 40000, maxMs = 2500 } = {}) {
  const needle = checkQuery(q).toLowerCase();
  const started = Date.now();
  const found = [];
  const seen = new Set();
  let queue = roots.map((dir) => ({ dir, depth: 0 }));
  let looked = 0;
  while (queue.length) {
    const next = [];
    for (const { dir, depth } of queue) {
      if (found.length >= limit || looked >= maxDirs || Date.now() - started > maxMs) return found;
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
  return found.slice(0, limit);
}

/** The fixed remote script: folders under ~ (4 levels down) whose name contains `q`, as ~/paths. */
export function remoteSearchScript(q) {
  const s = checkQuery(q);
  return `cd ~ && find . -mindepth 1 -maxdepth 4 \\( -name node_modules -o -name '.*' -o -name venv -o -name __pycache__ -o -name snap -o -name site-packages \\) -prune -o -type d -iname '*${s}*' -printf '%d ~/%P\\n' 2>/dev/null | sort -n | head -40; true`;
}

/**
 * The fixed remote script for the Folder list before you type: the folders in ~/projects, two
 * levels down (~/projects/app, ~/projects/pi/app), most recently changed first; or in ~ if
 * there's no ~/projects. Each line is "<mtime> ~/path".
 */
export function remoteListScript() {
  const prune = `\\( -name node_modules -o -name '.*' -o -name venv -o -name __pycache__ \\) -prune -o`;
  return `cd ~ && if [ -d projects ]; then find projects -mindepth 1 -maxdepth 2 ${prune} -type d -printf '%T@ ~/%p\\n'; else find . -mindepth 1 -maxdepth 1 ${prune} -type d -printf '%T@ ~/%P\\n'; fi 2>/dev/null | sort -rn | head -40; true`;
}

/**
 * Folders your sessions ran in, newest first, that still exist (the Folder list before you type).
 * `metas` are session index rows ({ cwd, lastActivity }).
 */
export async function recentFolders(metas, { limit = 12, platform = process.platform } = {}) {
  const latest = new Map();
  for (const m of metas) {
    if (!m?.cwd || !isAbsolute(m.cwd)) continue;
    if (platform === "win32" && !/^[A-Za-z]:[\\/]/.test(m.cwd)) continue;
    const key = platform === "win32" ? m.cwd.toLowerCase() : m.cwd;
    const at = Number(m.lastActivity ?? m.mtimeMs) || 0;
    if (!latest.has(key) || latest.get(key).at < at) latest.set(key, { path: m.cwd, at });
  }
  const out = [];
  for (const { path } of [...latest.values()].sort((a, b) => b.at - a.at)) {
    if (out.length >= limit) break;
    if ((await stat(path).catch(() => null))?.isDirectory()) out.push({ path, name: basename(path) || path });
  }
  return out;
}

/**
 * The PowerShell script that shows Windows' own "Select folder" window (on top of the browser)
 * and prints the folder picked, or nothing if cancelled. Needs -STA. `start` is where it opens.
 */
export function windowsFolderDialogScript(start) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  return [
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.Opacity = 0; $owner.StartPosition = 'CenterScreen'",
    "$owner.Show(); $owner.Activate()",
    "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$d.Description = 'Choose the folder Pi works in'; $d.UseDescriptionForTitle = $true; $d.ShowNewFolderButton = $true",
    `$d.InitialDirectory = ${q(start)}`,
    "$r = $d.ShowDialog($owner); $owner.Close()",
    "if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
  ].join("\n");
}

/* ── Select remote folder: browse an SSH computer one folder at a time ── */

/** A folder to browse there: ~, /, or ~/… or /… made of plain names. */
const BROWSE_PATH = /^(~|\/|~(\/[\w][\w.-]{0,99}){1,30}|(\/[\w][\w.-]{0,99}){1,30})$/;
const PLAIN_NAME = /^[\w][\w.-]{0,99}$/;

export function checkBrowsePath(path) {
  const p = String(path ?? "").trim().replace(/(.)\/+$/, "$1") || "~";
  if (!BROWSE_PATH.test(p) || p.split("/").some((part) => part === "." || part === "..")) {
    throw new EnvError("Folder names here are letters, digits and . _ - (a path like ~/projects or /srv/app).");
  }
  return p;
}

/**
 * The fixed remote script that lists one folder's subfolders: prints "H<home>", "P<the folder,
 * resolved>", then "D<name>" per subfolder (hidden ones left out), or "E" if it can't go there.
 */
export function remoteDirScript(path) {
  const p = checkBrowsePath(path);
  return `printf 'H%s\\n' "$HOME"; cd ${p} 2>/dev/null || { echo E; exit 0; }; printf 'P%s\\n' "$PWD"; find . -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf 'D%f\\n' 2>/dev/null | sort -f | head -500`;
}

/** Its output → { home, path, folders, error? }; names that aren't plain are left out. */
export function parseRemoteDir(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const home = lines.find((l) => l.startsWith("H"))?.slice(1) ?? "";
  if (lines.includes("E")) return { home, path: "", folders: [], error: "That folder isn't there (or can't be opened)." };
  const path = lines.find((l) => l.startsWith("P"))?.slice(1) ?? "";
  const folders = lines.filter((l) => l.startsWith("D")).map((l) => l.slice(1)).filter((n) => PLAIN_NAME.test(n));
  return { home, path, folders };
}

/** An absolute path there, written with ~ when it's under the home folder (how environments keep it). */
export function tildePath(path, home) {
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

/** Its output → [{ path, name }], shallow first; anything that isn't a plain ~/path left out. */
export function parseRemoteSearch(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\d.]+ /, "").trim())
    .filter((path) => path.startsWith("~/") && REMOTE_PATH.test(path))
    .map((path) => ({ path, name: basename(path) }));
}

/** The line to paste (PowerShell or a POSIX shell) for an SSH environment's New session. */
export function sshPiCommand(host, path, { port = 0 } = {}) {
  const p = Number(port);
  if (!p) return `ssh -t ${checkHost(host)} '${remotePiLine(host, path)}'`;
  const t = tunnelPort(host);
  return `ssh -t -R ${t}:127.0.0.1:${p} ${checkHost(host)} '${remotePiLine(host, path, { tunnel: t })}'`;
}

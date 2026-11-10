// Start Pi (the bar at the bottom of the sidebar): which computer, and which folder there.
//
// Computers: "This computer" (id "local", always there) plus SSH computers you added (the name
// you type after `ssh`). Folders aren't set up ahead: you pick one each time from pinned ones,
// recent ones (where Pi ran), a search, or Browse…. Kept in ~/.cli-companion/computers.json:
//   { "current": "local" | "<host>", "computers": [{ "host" }],
//     "pins": [{ "computer", "path" }], "recent": [{ "computer", "path", "at" }] }
// The first time, the old environments.json (computer + folder pairs) is read once: its SSH
// computers are added and its folders pinned; that file is then left as it was.
//
// Local: a terminal in the folder running `pi`. SSH: a terminal running `ssh -t <host>` into a tmux
// session named after the folder: a new Pi window in it if the session is already there, else
// the session is created running Pi; either way you're attached, and it survives a dropped
// connection.
//
// Hard rules: the page names a computer and a folder, never a command. Host names and remote
// paths are checked against tight patterns (plain words: no spaces, quotes or a leading "-"), so
// the remote line is built from fixed text and those words only. Local folders must exist.

import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse } from "node:path";
import { tmuxName } from "./launch.mjs";

export class EnvError extends Error {}

export const LOCAL_ID = "local";
const MAX_COMPUTERS = 20;
const MAX_PINS = 50;
const MAX_RECENT = 40;
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

/** A folder on this computer, as typed or picked: absolute, trailing slashes off (a root stays). */
export function cleanLocalPath(path) {
  const raw = String(path ?? "").trim().replace(/^["']|["']$/g, "");
  const p = /^([A-Za-z]:)?[\\/]$/.test(raw) ? raw : raw.replace(/[\\/]+$/, "");
  if (!p || !isAbsolute(p)) throw new EnvError("Give the folder's full path.");
  return p;
}

/** A folder on a computer: checked for that kind of computer (local ones must exist). */
export async function checkFolder(computer, path) {
  if (computer === LOCAL_ID) {
    const p = cleanLocalPath(path);
    if (!(await stat(p).catch(() => null))?.isDirectory()) throw new EnvError(`There's no folder at ${p}.`);
    return p;
  }
  return checkRemotePath(path);
}

const samePlace = (a, b) => a.computer === b.computer && (a.computer === LOCAL_ID && process.platform === "win32" ? a.path.toLowerCase() === b.path.toLowerCase() : a.path === b.path);

function validPlace(p, hosts) {
  if (typeof p?.computer !== "string" || typeof p?.path !== "string") return false;
  if (p.computer === LOCAL_ID) return isAbsolute(p.path);
  return hosts.has(p.computer) && REMOTE_PATH.test(p.path);
}

/** Read the old environments.json (computer + folder pairs) into computers and pins. */
async function fromEnvironments(oldFile, home) {
  let data;
  try {
    data = JSON.parse(await readFile(oldFile, "utf8"));
  } catch {
    return null;
  }
  const computers = [];
  const pins = [];
  for (const e of Array.isArray(data?.envs) ? data.envs : []) {
    if (e?.kind === "ssh" && HOST.test(e.host ?? "") && REMOTE_PATH.test(e.path ?? "")) {
      if (!computers.some((c) => c.host === e.host)) computers.push({ host: e.host });
      if (e.path !== "~") pins.push({ computer: e.host, path: e.path });
    } else if (e?.kind === "local" && typeof e.path === "string" && isAbsolute(e.path) && e.path !== home) {
      pins.push({ computer: LOCAL_ID, path: e.path });
    }
  }
  const old = Array.isArray(data?.envs) ? data.envs.find((e) => e?.id === data.current) : undefined;
  return { current: old?.kind === "ssh" ? old.host : LOCAL_ID, computers, pins, recent: [] };
}

/**
 * Computers, pinned and recent folders, and the picked computer. `oldFile` is environments.json,
 * read once when computers.json isn't there yet.
 */
export async function loadStart(file, { oldFile, home } = {}) {
  let data;
  try {
    data = JSON.parse(await readFile(file, "utf8"));
  } catch {
    data = (oldFile && (await fromEnvironments(oldFile, home))) || {};
  }
  const computers = [];
  for (const c of Array.isArray(data.computers) ? data.computers : []) {
    if (HOST.test(c?.host ?? "") && !computers.some((x) => x.host === c.host) && computers.length < MAX_COMPUTERS) computers.push({ host: c.host });
  }
  const hosts = new Set(computers.map((c) => c.host));
  const pins = [];
  for (const p of Array.isArray(data.pins) ? data.pins : []) {
    if (validPlace(p, hosts) && !pins.some((x) => samePlace(x, p)) && pins.length < MAX_PINS) pins.push({ computer: p.computer, path: p.path });
  }
  const recent = (Array.isArray(data.recent) ? data.recent : [])
    .filter((p) => validPlace(p, hosts) && Number.isFinite(p.at))
    .map((p) => ({ computer: p.computer, path: p.path, at: p.at }))
    .slice(0, MAX_RECENT);
  const current = data.current === LOCAL_ID || hosts.has(data.current) ? data.current : LOCAL_ID;
  const sessions = (Array.isArray(data.sessions) ? data.sessions : []).map(cleanRemoteSession).filter((x) => x && hosts.has(x.via)).slice(0, MAX_REMOTE_SESSIONS);
  // Every start (not one per folder, unlike recent), to find the session each one made; and the
  // ids found, so the sidebar's Recent lists only sessions started from here.
  // (Before the log existed, the recent folders are the starts we know of.)
  const starts = (Array.isArray(data.starts) ? data.starts : Array.isArray(data.recent) ? data.recent : [])
    .filter((p) => validPlace(p, hosts) && Number.isFinite(p.at))
    .map((p) => ({ computer: p.computer, path: p.path, at: p.at, copy: p.copy === true || undefined }))
    .slice(0, MAX_STARTS);
  const started = (Array.isArray(data.started) ? data.started : []).filter((id) => typeof id === "string" && /^[\w:-]{1,120}$/.test(id)).slice(0, MAX_STARTED);
  return { current, computers, pins, recent, sessions, starts, started };
}

async function saveStart(file, state) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tmp, file);
}

/** Change it: `fn(state)` edits the state in place; it's saved and returned. */
export async function updateStart(file, opts, fn) {
  const state = await loadStart(file, opts);
  await fn(state);
  await saveStart(file, state);
  return state;
}

export function pickComputer(state, computer) {
  if (computer !== LOCAL_ID && !state.computers.some((c) => c.host === computer)) throw new EnvError("That computer isn't in the list.");
  state.current = computer;
}

export function addComputer(state, host) {
  const h = checkHost(host);
  if (!state.computers.some((c) => c.host === h)) {
    if (state.computers.length >= MAX_COMPUTERS) throw new EnvError(`At most ${MAX_COMPUTERS} computers.`);
    state.computers.push({ host: h });
  }
  state.current = h;
}

export function removeComputer(state, host) {
  state.computers = state.computers.filter((c) => c.host !== host);
  state.sessions = state.sessions.filter((x) => x.via !== host);
  state.pins = state.pins.filter((p) => p.computer !== host);
  state.recent = state.recent.filter((p) => p.computer !== host);
  if (state.current === host) state.current = LOCAL_ID;
}

export function setPin(state, place, pinned) {
  state.pins = state.pins.filter((p) => !samePlace(p, place));
  if (pinned) {
    if (state.pins.length >= MAX_PINS) throw new EnvError(`At most ${MAX_PINS} pinned folders.`);
    state.pins.unshift({ computer: place.computer, path: place.path });
  }
}

/*
 * Sessions on SSH computers that reported here through the tunnel are remembered (id, computer,
 * session file and folder there, name, last activity), so they stay in the sidebar's Recent after
 * the connection closes and their history can still be read over ssh.
 */
const MAX_REMOTE_SESSIONS = 60;
export function cleanRemoteSession(x) {
  if (typeof x?.id !== "string" || !/^[\w-]{1,100}$/.test(x.id) || !HOST.test(x.via ?? "")) return null;
  const file = checkRemoteSessionFile(x.file);
  if (!file || typeof x.cwd !== "string" || !x.cwd.startsWith("/") || /[\0\n\r]/.test(x.cwd)) return null;
  return {
    id: x.id,
    via: x.via,
    file,
    cwd: x.cwd.slice(0, 1000),
    name: typeof x.name === "string" ? x.name.slice(0, 200) : undefined,
    at: Number.isFinite(x.at) ? x.at : 0,
  };
}

/** Remember (or update) one; newest first. */
export function rememberRemoteSession(state, session) {
  const clean = cleanRemoteSession(session);
  if (!clean || !state.computers.some((c) => c.host === clean.via)) return;
  const had = state.sessions.find((x) => x.id === clean.id);
  state.sessions = [{ ...had, ...clean, name: clean.name ?? had?.name }, ...state.sessions.filter((x) => x.id !== clean.id)].slice(0, MAX_REMOTE_SESSIONS);
}

/** Pi was started in a folder (or its command copied): top of that computer's recent ones, and logged. */
export function addRecent(state, place, at = Date.now(), { copy = false } = {}) {
  state.recent = [{ computer: place.computer, path: place.path, at }, ...state.recent.filter((p) => !samePlace(p, place))].slice(0, MAX_RECENT);
  state.starts = [{ computer: place.computer, path: place.path, at, copy: copy || undefined }, ...(state.starts ?? [])].slice(0, MAX_STARTS);
}

const MAX_STARTS = 100;
const MAX_STARTED = 500;
/** How long after a start its session may appear: a few minutes, longer for a copied command. */
const START_WINDOW_MS = 3 * 60 * 1000;
const COPY_WINDOW_MS = 60 * 60 * 1000;

/**
 * Was this session started from here? Pi on this computer, in a folder Start Pi started (or
 * copied the command for), beginning within a few minutes after. `session`: { source, cwd,
 * createdAt (ms) }.
 */
export function startedHere(starts, session, platform = process.platform) {
  if ((session.source ?? "pi") !== "pi" || !session.cwd || !Number.isFinite(session.createdAt)) return false;
  const same = (a, b) => (platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  return starts.some(
    (s) => s.computer === LOCAL_ID && same(s.path, session.cwd) && session.createdAt >= s.at - 10_000 && session.createdAt <= s.at + (s.copy ? COPY_WINDOW_MS : START_WINDOW_MS),
  );
}

/** Keep these session ids as started from here. */
export function markStarted(state, ids) {
  // Ids as the sidebar knows them: Pi's own, or "claude:…" / "codex:…".
  const add = ids.filter((id) => /^[\w:-]{1,120}$/.test(id) && !state.started.includes(id));
  state.started = [...add, ...state.started].slice(0, MAX_STARTED);
}

/**
 * Recent folders for a computer, newest first: ones you started Pi in here, merged with where its
 * sessions ran (`found`: [{ path, at }]), pinned ones left out (they're listed above).
 */
export function recentFor(state, computer, found = [], { limit = 12 } = {}) {
  const out = [];
  const seen = (path) => out.some((p) => samePlace({ computer, path: p.path }, { computer, path }));
  const all = [...state.recent.filter((p) => p.computer === computer), ...found.map((f) => ({ computer, path: f.path, at: f.at }))].sort((a, b) => b.at - a.at);
  for (const p of all) {
    if (state.pins.some((pin) => samePlace(pin, { computer, path: p.path })) || seen(p.path)) continue;
    out.push({ path: p.path, at: p.at });
    if (out.length >= limit) break;
  }
  return out;
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
  for (const { path, at } of [...latest.values()].sort((a, b) => b.at - a.at)) {
    if (out.length >= limit) break;
    if ((await stat(path).catch(() => null))?.isDirectory()) out.push({ path, name: basename(path) || path, at });
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

/* ── Recent folders on an SSH computer, and its connection test ── */

/**
 * The fixed remote script that lists where Pi ran there: "H<home>", then "<mtime> <cwd>" per Pi
 * session folder (from the newest session file's first line), newest first.
 */
export function remoteRecentScript(limit = 20) {
  return `printf 'H%s\n' "$HOME"; for d in "$HOME"/.pi/agent/sessions/*/; do f=$(ls -t "$d" 2>/dev/null | grep '\.jsonl$' | head -1); [ -n "$f" ] || continue; c=$(head -c 4000 "$d$f" | head -1 | grep -o '"cwd":"[^"]*"' | head -1 | cut -d'"' -f4); [ -n "$c" ] && echo "$(stat -c %Y "$d$f") $c"; done | sort -rn | head -${Math.floor(limit)}`;
}

/** Its output → [{ path, at }] with ~ for the home folder; folders that aren't plain names left out. */
export function parseRemoteRecent(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const home = lines.find((l) => l.startsWith("H"))?.slice(1) ?? "";
  const out = [];
  for (const line of lines) {
    const m = /^(\d+) (\/.*)$/.exec(line);
    if (!m) continue;
    const path = tildePath(m[2].replace(/(.)\/+$/, "$1"), home);
    if (REMOTE_PATH.test(path) && !path.split("/").includes("..") && !out.some((o) => o.path === path)) out.push({ path, at: Number(m[1]) * 1000 });
  }
  return out;
}

/**
 * The fixed remote script for "Test": prints one word per check that passes. Login is whether it
 * ran at all; then tmux, pi (in a login shell, as New session runs it), the companion as a Pi
 * package there, and whether the tunnel's port is free.
 */
export function remoteTestScript(host) {
  return `echo login; command -v tmux >/dev/null 2>&1 && echo tmux; bash -lc 'command -v pi' >/dev/null 2>&1 && echo pi; grep -q 'cli-companion' "$HOME/.pi/agent/settings.json" 2>/dev/null && echo extension; if command -v ss >/dev/null 2>&1; then ss -ltn 2>/dev/null | grep -q ':${tunnelPort(host)} ' && echo port-busy || echo port-free; fi`;
}

/** Its output (or the ssh error) → the checklist the page shows. */
export function testResults(host, out, error, { tunnelOpen = false } = {}) {
  const has = (w) => new RegExp(`^${w}$`, "m").test(out ?? "");
  const port = tunnelPort(host);
  if (error || !has("login")) {
    const e = String(error ?? "");
    const fix = /resolve hostname|not known|Name or service/i.test(e)
      ? `Couldn't find a computer called ${host}: check the name (it's what you type after ssh, or a Host in your ~/.ssh/config).`
      : /timed out|refused|unreachable|No route/i.test(e)
        ? `Couldn't reach ${host}: is it on, and on your network (or Tailscale)?`
        : `Set up an SSH key so \`ssh ${host}\` doesn't ask for a password.`;
    return [{ ok: false, label: "Logs in without a password", fix: e ? `${fix} (${e})` : fix }];
  }
  return [
    { ok: true, label: "Logs in without a password" },
    { ok: has("tmux"), label: "tmux is installed", fix: "Install tmux there (sudo apt install tmux)." },
    { ok: has("pi"), label: "Pi is installed", fix: "Install Pi there, so `pi` runs in a login shell." },
    { ok: has("extension"), label: "The companion is a Pi package there", fix: "Without it Pi still starts, but its session won't show here. In Pi there: pi install git:github.com/mcgowee/cli-companion" },
    !has("port-busy")
      ? { ok: true, label: `Port ${port} there is free (for the tunnel)` }
      : tunnelOpen
        ? { ok: true, label: `Port ${port} there is in use by a session started from here (that's fine)` }
        : { ok: false, label: `Port ${port} there is free (for the tunnel)`, fix: "Something there already uses it, so sessions started from here may not show here. If a terminal from an earlier Start Pi is still open, that's it, and that's fine." },
  ];
}

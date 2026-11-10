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
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";
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
    const path = String(input.path ?? "").trim().replace(/^["']|["']$/g, "").replace(/[\\/]+$/, "");
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
export function remotePiLine(host, path) {
  const h = checkHost(host);
  const p = checkRemotePath(path);
  const s = remoteSessionName(h, p);
  return `tmux has-session -t =${s} 2>/dev/null && tmux new-window -t =${s}: -c ${p} bash -lc pi; tmux new-session -A -s ${s} -c ${p} bash -lc pi`;
}

/** The line to paste (PowerShell or a POSIX shell) for an SSH environment's New session. */
export function sshPiCommand(host, path) {
  return `ssh -t ${checkHost(host)} '${remotePiLine(host, path)}'`;
}

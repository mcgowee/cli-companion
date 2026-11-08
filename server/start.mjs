// Starting the companion server and opening its window. Shared by the `cli-companion`
// command (bin/cli-companion.mjs) and the Pi extension's /companion command.
//
// Node built-ins only. The server runs detached so it outlives whatever started it.
//
// Access key: a random key in ~/.cli-companion/access-key (readable only by you) that every
// request from this computer must carry: the window gets it once in its address (?key=, turned
// into a cookie), the Pi extension and this command send it as a header. It keeps other accounts
// on a shared computer out of your transcripts.

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isProcessAlive } from "./fsutil.mjs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ID = "cli-companion";
export const DEFAULT_PORT = 30143;
export const SERVER_SCRIPT = fileURLToPath(new URL("./server.mjs", import.meta.url));

const validPort = (value) => Number.isInteger(value) && value > 0 && value < 65536;

/**
 * The port: CLI_COMPANION_PORT (or the older PI_COMPANION_PORT), else the port of the server
 * that is running right now (server.json, below), else the port in Settings
 * (~/.cli-companion/settings.json), else 30143. The command and the Pi extension both read it,
 * so they find a server however it was started — a Pi launched without the server's environment
 * still reports to the right port.
 */
export function companionPort(env = process.env) {
  const fromEnv = Number.parseInt(env.CLI_COMPANION_PORT ?? env.PI_COMPANION_PORT ?? "", 10);
  if (validPort(fromEnv)) return fromEnv;
  const running = runtimePort(env);
  if (running) return running;
  try {
    const saved = JSON.parse(readFileSync(join(stateDir(env), "settings.json"), "utf8"))?.port;
    if (validPort(saved)) return saved;
  } catch {
    // no settings yet
  }
  return DEFAULT_PORT;
}

/** The running server's runtime file: { port, pid, startedAt }, written once it listens. */
export function runtimeFile(env = process.env) {
  return join(stateDir(env), "server.json");
}

/**
 * The server writes this atomically once it is listening. Two servers on different ports: the
 * last one to start wins — the file simply names the most recent, and anything starting later
 * follows it. A write that fails is quietly dropped (the lookup falls back to Settings).
 */
export function writeRuntimeFile(port, { pid = process.pid, env = process.env } = {}) {
  const file = runtimeFile(env);
  const tmp = `${file}.${pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify({ port, pid, startedAt: new Date().toISOString() }, null, 2)}\n`);
    renameSync(tmp, file);
  } catch {
    // read-only state dir: companionPort still works from Settings
  }
}

/** Remove the runtime file on a clean exit — only while it is still this server's own. */
export function removeRuntimeFile({ pid = process.pid, env = process.env } = {}) {
  const file = runtimeFile(env);
  try {
    if (JSON.parse(readFileSync(file, "utf8"))?.pid === pid) unlinkSync(file);
  } catch {
    // already gone, or another server's
  }
}

/** The port in server.json, if the server that wrote it is still alive; else undefined. */
export function runtimePort(env = process.env) {
  try {
    const raw = JSON.parse(readFileSync(runtimeFile(env), "utf8"));
    // A stale file (the server died without cleaning up, or the file is damaged) is ignored.
    if (validPort(raw?.port) && Number.isInteger(raw?.pid) && raw.pid > 0 && isProcessAlive(raw.pid)) return raw.port;
  } catch {
    // no runtime file
  }
  return undefined;
}

export { ACCESS_HEADER } from "./access.mjs";
import { ACCESS_HEADER } from "./access.mjs";

/** This computer's access key (made on first use, readable only by you). */
export function accessKey(env = process.env) {
  const file = join(stateDir(env), "access-key");
  try {
    const key = readFileSync(file, "utf8").trim();
    if (/^[a-f0-9]{32,}$/.test(key)) return key;
  } catch {
    // make one below
  }
  const key = randomBytes(24).toString("hex");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows: the file is in your own profile folder, which other accounts can't read.
  }
  return key;
}

/** The address to open in a browser: carries the key once; the server swaps it for a cookie. */
export function companionOpenUrl(port = companionPort(), env = process.env) {
  return `${companionUrl(port)}/?key=${accessKey(env)}`;
}

export function companionUrl(port = companionPort()) {
  return `http://127.0.0.1:${port}`;
}

/** Where the companion keeps its own files: CLI_COMPANION_HOME, else ~/.cli-companion. */
export function stateDir(env = process.env) {
  return env.CLI_COMPANION_HOME || join(homedir(), ".cli-companion");
}

/** The folder older versions used (inside Pi's agent folder). Read once to move files over. */
export function legacyStateDir(env = process.env) {
  return join(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "companion");
}

/** Copy a file from the old state folder if the new one doesn't have it yet. */
export function migrateStateFile(name, env = process.env) {
  const target = join(stateDir(env), name);
  const source = join(legacyStateDir(env), name);
  if (existsSync(target) || !existsSync(source)) return false;
  try {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    return true;
  } catch {
    return false;
  }
}

/** TCP probe: true only if something accepts a connection. */
export function isPortUp(port = companionPort(), timeoutMs = 600) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** True if the thing on the port answers /healthz like a companion server. */
export async function isCompanion(port = companionPort()) {
  try {
    const res = await fetch(`${companionUrl(port)}/healthz`, { signal: AbortSignal.timeout(1500) });
    const body = await res.json();
    return body?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Ask the companion on the port to stop, and wait until the port is free.
 * Returns { stopped: boolean, error?: string }; stopped is false when none was running.
 */
export async function stopServer(port = companionPort()) {
  if (!(await isCompanion(port))) return { stopped: false };
  try {
    const res = await fetch(`${companionUrl(port)}/api/server`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pi-companion-page": "1", [ACCESS_HEADER]: accessKey() },
      body: JSON.stringify({ action: "stop" }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { stopped: false, error: `The server refused to stop (HTTP ${res.status}). Is it an older version?` };
  } catch (error) {
    return { stopped: false, error: `Couldn't reach the server: ${error.message}` };
  }
  for (let i = 0; i < 40; i++) {
    if (!(await isPortUp(port))) return { stopped: true };
    await new Promise((r) => setTimeout(r, 125));
  }
  return { stopped: false, error: `The server on ${companionUrl(port)} didn't stop.` };
}

/** The running Node if it is plain `node`, else `node` on PATH (Pi may be a standalone binary). */
export function nodeBinary() {
  return /^node(\.exe)?$/i.test(basename(process.execPath)) ? process.execPath : "node";
}

const LOG_LIMIT = 2 * 1024 * 1024;

/** Keep server.log from growing without end: past 2 MB it becomes server.log.1 (one old copy). */
export function rotateLog(logPath, limit = LOG_LIMIT) {
  try {
    if (statSync(logPath).size > limit) renameSync(logPath, `${logPath}.1`);
  } catch {
    // no log yet, or it's in use
  }
}

/**
 * Spawn a detached helper without letting a missing program crash the caller (inside Pi, an
 * unhandled 'error' event would take Pi down). Resolves with an error message, or "" once started.
 */
function spawnSafely(command, args, options) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, options);
    } catch (error) {
      resolve(error.message);
      return;
    }
    child.once("error", (error) => resolve(error.code === "ENOENT" ? `${command} wasn't found` : error.message));
    child.once("spawn", () => {
      child.unref();
      resolve("");
    });
  });
}

/**
 * Start the server detached if nothing is on the port yet.
 * Returns { started: boolean, error?: string, logPath }.
 */
export async function ensureServer({ port = companionPort(), env = process.env } = {}) {
  const dir = stateDir(env);
  const logPath = join(dir, "server.log");
  if (await isPortUp(port)) return { started: false, logPath };
  mkdirSync(dir, { recursive: true });
  rotateLog(logPath);
  const log = openSync(logPath, "a");
  const failed = await spawnSafely(nodeBinary(), [SERVER_SCRIPT], {
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true,
    // The server gets its port in CLI_COMPANION_PORT; CLI_COMPANION_PORT_SET says whether you set
    // one yourself (so Settings can say the environment wins over its port).
    env: { ...env, CLI_COMPANION_PORT: String(port), CLI_COMPANION_PORT_SET: env.CLI_COMPANION_PORT || env.PI_COMPANION_PORT ? "1" : "0" },
  });
  if (failed) return { started: false, logPath, error: `Couldn't start the companion server: ${failed}. Is Node.js on your PATH?` };
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await isPortUp(port)) return { started: true, logPath };
  }
  return { started: false, logPath, error: `The companion server did not start on ${companionUrl(port)}. See ${logPath}.` };
}

function which(command) {
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split(/\r?\n/).find(Boolean);
  } catch {
    return undefined;
  }
}

/** A Chromium-based browser that supports --app windows, if one is installed. */
export function findAppBrowser() {
  if (process.platform === "win32") {
    const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean);
    for (const root of roots) {
      for (const rel of ["Google\\Chrome\\Application\\chrome.exe", "Microsoft\\Edge\\Application\\msedge.exe"]) {
        const candidate = join(root, rel);
        if (existsSync(candidate)) return candidate;
      }
    }
    return undefined;
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ].find((candidate) => existsSync(candidate));
  }
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) {
    const found = which(name);
    if (found) return found;
  }
  return undefined;
}

/**
 * Open the companion as an app window (its own browser profile), or in the default browser.
 * Never throws for a missing program; resolves { url, error? } so the caller can print the
 * address instead.
 */
export async function openWindow({ port = companionPort(), env = process.env } = {}) {
  const url = companionOpenUrl(port, env);
  const browser = findAppBrowser();
  const detached = { detached: true, stdio: "ignore", windowsHide: true };
  let failed;
  if (browser) {
    failed = await spawnSafely(browser, [`--app=${url}`, `--user-data-dir=${join(stateDir(env), "browser-profile")}`, "--window-size=1100,900"], detached);
  }
  if (!browser || failed) {
    const opener = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    failed = await spawnSafely(opener, [url], detached);
  }
  return { url, error: failed || undefined };
}

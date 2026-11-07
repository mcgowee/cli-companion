// Starting the companion server and opening its window. Shared by the `cli-companion`
// command (bin/cli-companion.mjs) and the Pi extension's /companion command.
//
// Node built-ins only. The server runs detached so it outlives whatever started it.

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, openSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ID = "cli-companion";
export const DEFAULT_PORT = 30143;
export const SERVER_SCRIPT = fileURLToPath(new URL("./server.mjs", import.meta.url));

/** The port: CLI_COMPANION_PORT, else the older PI_COMPANION_PORT, else 30143. */
export function companionPort(env = process.env) {
  const value = Number.parseInt(env.CLI_COMPANION_PORT ?? env.PI_COMPANION_PORT ?? "", 10);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : DEFAULT_PORT;
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

/** The running Node if it is plain `node`, else `node` on PATH (Pi may be a standalone binary). */
export function nodeBinary() {
  return /^node(\.exe)?$/i.test(basename(process.execPath)) ? process.execPath : "node";
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
  const log = openSync(logPath, "a");
  const child = spawn(nodeBinary(), [SERVER_SCRIPT], {
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true,
    env: { ...env, CLI_COMPANION_PORT: String(port) },
  });
  child.unref();
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

/** Open the companion as an app window (its own browser profile), or in the default browser. */
export function openWindow({ port = companionPort(), env = process.env } = {}) {
  const url = companionUrl(port);
  const browser = findAppBrowser();
  const detached = { detached: true, stdio: "ignore", windowsHide: true };
  if (browser) {
    spawn(
      browser,
      [`--app=${url}`, `--user-data-dir=${join(stateDir(env), "browser-profile")}`, "--window-size=1100,900"],
      detached,
    ).unref();
  } else if (process.platform === "win32") {
    spawn("explorer.exe", [url], detached).unref();
  } else {
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], detached).unref();
  }
  return url;
}

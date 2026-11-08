// Your settings, in ~/.cli-companion/settings.json (written from the Settings page; hand edits
// to the file are picked up — the server re-reads it when its stamp changes — and a save from a
// page that loaded the file before a hand edit is refused rather than overwriting it):
//
//   { "sources": { "<id>": { "enabled": false, "folder": "D:\\claude" } }, "terminal": "auto" }
//
// - sources.<id>.enabled: false hides that CLI's sessions and its terminal-menu entries.
// - sources.<id>.folder: the CLI's own folder (~/.pi/agent, ~/.claude, ~/.codex) if it isn't
//   in the usual place.
// - terminal: what Open uses ("auto" or an id from TERMINALS for this platform).
// - suggest: { enabled, model } suggested replies in the composer from a LOCAL Ollama model
//   (off by default; cloud models are refused).
// - appearance: { theme: "system" | "light" | "dark", showCost, showGit, clock: "auto" | "12" | "24" } how the page looks.
// - sshHost: what other machines type after `ssh` to reach this computer ("aegis",
//   "me@100.64.1.2"); used by the terminal menu's lines on a headless server. Not set =
//   user@hostname.
//
// Settings become environment overrides for createSources(), so environment variables and
// settings work the same way. CLI_COMPANION_<ID>=0 in the real environment always wins.

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { terminalsFor } from "./launch.mjs";
import { isCloudModel } from "./suggest.mjs";

export class SettingsError extends Error {}

/** Each CLI's folder variable (the same one the CLI itself reads, where it has one). */
export const FOLDER_ENV = { pi: "PI_CODING_AGENT_DIR", claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };

export function defaultSettings() {
  return { sources: {}, terminal: "auto", suggest: { enabled: false, model: "" }, appearance: { theme: "system", showCost: true, showGit: true, clock: "auto" } };
}

const THEMES = ["system", "light", "dark"];
const CLOCKS = ["auto", "12", "24"];

/**
 * A stamp of the settings file as it is on disk ("" while it doesn't exist); it changes when the
 * file does. The server re-reads the file when the stamp moved, and the page sends the stamp it
 * loaded back with a save, so a save never overwrites a hand edit the page hasn't seen.
 */
export async function settingsStamp(file) {
  try {
    const s = await stat(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "";
  }
}

/**
 * Read the file as it is: a missing file is defaults (a fresh install), but JSON that doesn't
 * parse throws. For refreshes while the server runs — a hand edit with a typo, or an editor
 * caught mid-write, must never replace the settings already loaded (loadSettings' fallback
 * would make them defaults, and the next save would write defaults over the user's file).
 */
export async function readSettingsStrict(file) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return defaultSettings();
  }
  return validateSettings(JSON.parse(raw), { lenient: true });
}

/** The lenient read for startup: a file that can't be parsed loads as defaults. */
export async function loadSettings(file) {
  try {
    return await readSettingsStrict(file);
  } catch {
    return defaultSettings();
  }
}

/**
 * Check settings from the page (or the file). Unknown keys are dropped. `lenient` drops bad
 * values instead of throwing (for a hand-edited file).
 */
export function validateSettings(input, { platform = process.platform, lenient = false } = {}) {
  const fail = (message) => {
    if (!lenient) throw new SettingsError(message);
  };
  const out = defaultSettings();
  const sources = input?.sources && typeof input.sources === "object" ? input.sources : {};
  for (const [id, value] of Object.entries(sources)) {
    if (!FOLDER_ENV[id] || !value || typeof value !== "object") continue;
    const entry = {};
    if (typeof value.enabled === "boolean") entry.enabled = value.enabled;
    // Composer: also press Enter after putting text in the CLI's input (only CLIs the page can type into).
    if (value.sendEnter === true) entry.sendEnter = true;
    if (typeof value.folder === "string" && value.folder.trim()) {
      const folder = value.folder.trim();
      if (!isAbsolute(folder) || folder.length > 500) fail(`The folder for ${id} must be a full path.`);
      else entry.folder = folder;
    }
    if (Object.keys(entry).length) out.sources[id] = entry;
  }
  if (typeof input?.terminal === "string") {
    const ok = input.terminal === "auto" || terminalsFor(platform).some((t) => t.id === input.terminal);
    if (ok) out.terminal = input.terminal;
    else fail("Unknown terminal.");
  }
  const suggest = input?.suggest;
  if (suggest && typeof suggest === "object") {
    if (typeof suggest.enabled === "boolean") out.suggest.enabled = suggest.enabled;
    if (typeof suggest.model === "string") {
      const model = suggest.model.trim();
      if (model && (!/^[\w./:-]{1,200}$/.test(model) || isCloudModel(model))) fail("Pick a local Ollama model for suggested replies.");
      else out.suggest.model = model;
    }
  }
  const look = input?.appearance;
  if (look && typeof look === "object") {
    if (THEMES.includes(look.theme)) out.appearance.theme = look.theme;
    else if (look.theme !== undefined) fail("Unknown theme.");
    if (typeof look.showCost === "boolean") out.appearance.showCost = look.showCost;
    if (typeof look.showGit === "boolean") out.appearance.showGit = look.showGit;
    if (CLOCKS.includes(look.clock)) out.appearance.clock = look.clock;
    else if (look.clock !== undefined) fail("Unknown clock format.");
  }
  // SSH name for this computer: a plain host or user@host, nothing a shell could misread.
  if (typeof input?.sshHost === "string" && input.sshHost.trim()) {
    const host = input.sshHost.trim();
    if (/^[\w.@:-]{1,100}$/.test(host)) out.sshHost = host;
    else fail("The SSH name can only use letters, digits and . - _ @ : (up to 100 characters).");
  }
  // Terminal tab: may the companion run commands you send from it? Off unless you turn it on.
  if (input?.runCommands === true) out.runCommands = true;
  // The port the companion uses next time it starts (CLI_COMPANION_PORT still wins). Not set = 30143.
  if (input?.port !== undefined && input.port !== null && input.port !== "") {
    const port = Number(input.port);
    if (Number.isInteger(port) && port >= 1024 && port < 65536) out.port = port;
    else fail("The port must be a whole number from 1024 to 65535.");
  }
  if (out.suggest.enabled && !out.suggest.model) {
    fail("Pick a model for suggested replies, or switch them off.");
    out.suggest.enabled = false;
  }
  return out;
}

export async function saveSettings(file, settings) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  await rename(tmp, file);
}

/** The environment createSources() should see: the real one plus the settings. */
export function sourceEnv(settings, baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const [id, entry] of Object.entries(settings.sources ?? {})) {
    if (entry.folder && FOLDER_ENV[id]) env[FOLDER_ENV[id]] = entry.folder;
    if (entry.enabled === false) env[`CLI_COMPANION_${id.toUpperCase()}`] = "0";
  }
  return env;
}

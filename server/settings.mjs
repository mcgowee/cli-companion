// Your settings, in ~/.cli-companion/settings.json (written only from the Settings page):
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
//
// Settings become environment overrides for createSources(), so environment variables and
// settings work the same way. CLI_COMPANION_<ID>=0 in the real environment always wins.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

export async function loadSettings(file) {
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    return validateSettings(raw, { lenient: true });
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

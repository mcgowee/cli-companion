// Your settings, in ~/.cli-companion/settings.json (written only from the Settings page):
//
//   { "sources": { "<id>": { "enabled": false, "folder": "D:\\claude" } }, "terminal": "auto" }
//
// - sources.<id>.enabled: false hides that CLI's sessions and its terminal-menu entries.
// - sources.<id>.folder: the CLI's own folder (~/.pi/agent, ~/.claude, ~/.codex) if it isn't
//   in the usual place.
// - terminal: what Open uses ("auto" or an id from TERMINALS for this platform).
//
// Settings become environment overrides for createSources(), so environment variables and
// settings work the same way. CLI_COMPANION_<ID>=0 in the real environment always wins.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { terminalsFor } from "./launch.mjs";

export class SettingsError extends Error {}

/** Each CLI's folder variable (the same one the CLI itself reads, where it has one). */
export const FOLDER_ENV = { pi: "PI_CODING_AGENT_DIR", claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };

export function defaultSettings() {
  return { sources: {}, terminal: "auto" };
}

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

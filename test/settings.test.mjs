import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultSettings, loadSettings, readSettingsStrict, saveSettings, SettingsError, settingsStamp, sourceEnv, validateSettings } from "../server/settings.mjs";
import { createSources } from "../server/sources/index.mjs";

const abs = process.platform === "win32" ? "D:\\claude" : "/data/claude";

test("validateSettings keeps known CLIs and terminals, rejects bad values", () => {
  assert.deepEqual(validateSettings({ sources: { claude: { enabled: false, folder: ` ${abs} ` }, nope: { enabled: false } }, terminal: "console" }, { platform: "win32" }), {
    sources: { claude: { enabled: false, folder: abs } },
    terminal: "console",
    suggest: { enabled: false, model: "" },
    appearance: { theme: "system", showCost: true, showGit: true, clock: "auto" },
  });
  assert.throws(() => validateSettings({ sources: { codex: { folder: "relative/path" } } }), SettingsError);
  assert.throws(() => validateSettings({ terminal: "iterm" }, { platform: "win32" }), SettingsError);
  assert.deepEqual(validateSettings({ terminal: "iterm", sources: { codex: { folder: "x" } } }, { platform: "win32", lenient: true }), {
    sources: {},
    terminal: "auto",
    suggest: { enabled: false, model: "" },
    appearance: { theme: "system", showCost: true, showGit: true, clock: "auto" },
  });
  // Suggested replies: a local model only, and on needs a model.
  assert.deepEqual(validateSettings({ suggest: { enabled: true, model: "qwen3.8:27b" } }).suggest, { enabled: true, model: "qwen3.8:27b" });
  assert.throws(() => validateSettings({ suggest: { enabled: true, model: "glm-5.3:cloud" } }), SettingsError);
  assert.throws(() => validateSettings({ suggest: { enabled: true, model: "gemma4:31b-cloud" } }), SettingsError);
  assert.throws(() => validateSettings({ suggest: { enabled: true, model: "" } }), SettingsError);
  assert.throws(() => validateSettings({ suggest: { model: "x; rm -rf /" } }), SettingsError);
  assert.deepEqual(validateSettings({ suggest: { enabled: true, model: "kimi-k3:cloud" } }, { lenient: true }).suggest, { enabled: false, model: "" });
});

test("settings become the environment the sources read; a real CLI_COMPANION_X=0 still wins", () => {
  const env = sourceEnv({ sources: { claude: { folder: abs }, codex: { enabled: false } } }, { CLI_COMPANION_PI: "0" });
  assert.equal(env.CLAUDE_CONFIG_DIR, abs);
  assert.equal(env.CLI_COMPANION_CODEX, "0");
  const sources = createSources(env);
  assert.deepEqual(sources.map((s) => [s.id, s.enabled]), [["pi", false], ["claude", true], ["codex", false]]);
  assert.equal(sources[1].home.path, abs);
});

test("save and load round-trip; a broken file loads as defaults", async () => {
  const dir = mkdtempSync(join(tmpdir(), "companion-settings-"));
  const file = join(dir, "settings.json");
  await saveSettings(file, { sources: { codex: { enabled: false } }, terminal: "auto" });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).sources, { codex: { enabled: false } });
  assert.deepEqual((await loadSettings(file)).sources, { codex: { enabled: false } });
  writeFileSync(file, "{ not json");
  assert.deepEqual(await loadSettings(file), { sources: {}, terminal: "auto", suggest: { enabled: false, model: "" }, appearance: { theme: "system", showCost: true, showGit: true, clock: "auto" } });
});

test("validateSettings: appearance (theme, cost, git)", () => {
  assert.deepEqual(validateSettings({ appearance: { theme: "dark", showCost: false } }).appearance, { theme: "dark", showCost: false, showGit: true, clock: "auto" });
  assert.equal(validateSettings({ appearance: { clock: "24" } }).appearance.clock, "24");
  assert.throws(() => validateSettings({ appearance: { clock: "13" } }), SettingsError);
  assert.throws(() => validateSettings({ appearance: { theme: "neon" } }), SettingsError);
  assert.equal(validateSettings({ appearance: { theme: "neon" } }, { lenient: true }).appearance.theme, "system");
});

test("validateSettings: a CLI's composer button can also press Enter (true only)", () => {
  assert.deepEqual(validateSettings({ sources: { pi: { sendEnter: true } } }).sources, { pi: { sendEnter: true } });
  assert.deepEqual(validateSettings({ sources: { pi: { sendEnter: "yes" } } }).sources, {});
  assert.deepEqual(validateSettings({ sources: { pi: { sendEnter: false } } }).sources, {});
});

test("settingsStamp: empty while the file is missing, stable while untouched, moves on a write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "companion-settings-"));
  const file = join(dir, "settings.json");
  assert.equal(await settingsStamp(file), "");
  await saveSettings(file, defaultSettings());
  const stamp = await settingsStamp(file);
  assert.notEqual(stamp, "");
  assert.equal(await settingsStamp(file), stamp);
  writeFileSync(file, JSON.stringify({ port: 30144 }));
  assert.notEqual(await settingsStamp(file), stamp);
});

test("a hand edit on disk survives a save: the server re-reads it, and a stale page is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "companion-settings-"));
  const file = join(dir, "settings.json");
  // The server starts and a page loads the settings (what GET /api/settings hands out).
  await saveSettings(file, validateSettings({ port: 30144 }));
  let serverRev = await settingsStamp(file);
  const pageRev = serverRev;
  // A hand edit while the page is open.
  writeFileSync(file, JSON.stringify({ port: 30144, appearance: { clock: "24" } }));
  // The save path: refresh from disk first; the page's stamp no longer matches → 409, nothing written.
  const diskRev = await settingsStamp(file);
  assert.notEqual(diskRev, serverRev, "the hand edit is noticed");
  serverRev = diskRev;
  assert.notEqual(pageRev, serverRev, "the stale page's save is refused");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).appearance.clock, "24", "the hand edit is still in the file");
  // The page reloads (GET re-reads the file and hands out the new stamp); its save now goes through.
  const reloaded = await loadSettings(file);
  assert.equal(reloaded.appearance.clock, "24");
  assert.equal(reloaded.port, 30144);
  await saveSettings(file, { ...reloaded, terminal: "auto" });
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(after.port, 30144, "the hand-edited port survives the save");
  assert.equal(after.appearance.clock, "24");
});

test("a hand edit that doesn't parse never becomes the live settings: the refresh throws, startup stays lenient", async () => {
  const dir = mkdtempSync(join(tmpdir(), "companion-settings-"));
  const file = join(dir, "settings.json");
  // No file yet: both reads agree on defaults.
  assert.deepEqual(await readSettingsStrict(file), defaultSettings());
  // The server is running with a good file (what refreshSettings holds in memory).
  await saveSettings(file, validateSettings({ port: 30144 }));
  const current = await readSettingsStrict(file);
  const rev = await settingsStamp(file);
  assert.equal(current.port, 30144);
  // A typo (or an editor caught mid-write): the stamp moves, but the strict read refuses, so the
  // server keeps `current` and `rev` — saves can't match a rev the file never gets, so they're
  // refused — and the file stays exactly as typed for the user to fix.
  const broken = '{ "port": 30144, ';
  writeFileSync(file, broken);
  assert.notEqual(await settingsStamp(file), rev, "the edit is noticed");
  await assert.rejects(() => readSettingsStrict(file), SyntaxError);
  assert.equal(current.port, 30144, "the loaded settings are untouched");
  assert.equal(readFileSync(file, "utf8"), broken, "the file is untouched");
  // Only startup falls back to defaults for a broken file.
  assert.deepEqual(await loadSettings(file), defaultSettings());
  // Fixing the file: the next refresh (stamp still differs from `rev`) picks it up.
  writeFileSync(file, JSON.stringify({ port: 30145 }));
  assert.notEqual(await settingsStamp(file), rev);
  assert.equal((await readSettingsStrict(file)).port, 30145);
});

test("validateSettings: port is optional, 1024–65535", () => {
  assert.equal(validateSettings({}).port, undefined);
  assert.equal(validateSettings({ port: "" }).port, undefined);
  assert.equal(validateSettings({ port: "31000" }).port, 31000);
  assert.throws(() => validateSettings({ port: 80 }), /1024 to 65535/);
  assert.throws(() => validateSettings({ port: "abc" }), /1024 to 65535/);
  assert.equal(validateSettings({ port: "abc" }, { lenient: true }).port, undefined);
});

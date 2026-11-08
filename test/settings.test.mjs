import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadSettings, saveSettings, SettingsError, sourceEnv, validateSettings } from "../server/settings.mjs";
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

test("validateSettings: port is optional, 1024–65535", () => {
  assert.equal(validateSettings({}).port, undefined);
  assert.equal(validateSettings({ port: "" }).port, undefined);
  assert.equal(validateSettings({ port: "31000" }).port, 31000);
  assert.throws(() => validateSettings({ port: 80 }), /1024 to 65535/);
  assert.throws(() => validateSettings({ port: "abc" }), /1024 to 65535/);
  assert.equal(validateSettings({ port: "abc" }, { lenient: true }).port, undefined);
});

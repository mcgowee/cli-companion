import assert from "node:assert/strict";
import { test } from "node:test";
import { createSources, describeSources, nativeId, sourceForId } from "../server/sources/index.mjs";
import { usageSummary } from "../server/usage.mjs";

const sources = createSources({ PI_CODING_AGENT_DIR: "/nowhere/pi", CLAUDE_CONFIG_DIR: "/nowhere/claude", CODEX_HOME: "/nowhere/codex" });

test("every source has the full shape", () => {
  for (const source of sources) {
    for (const key of ["id", "label", "assistant", "folders", "startActions"]) assert.ok(source[key] !== undefined, `${source.id}.${key}`);
    for (const fn of ["scan", "owns", "readEntries", "transcript", "findImage", "resumeCommand", "slashCommands"]) {
      assert.equal(typeof source[fn], "function", `${source.id}.${fn}`);
    }
    assert.equal(typeof source.live, "boolean");
    assert.equal(typeof source.canType, "boolean");
  }
  assert.deepEqual(
    describeSources(sources).map((s) => [s.id, s.installed]),
    sources.map((s) => [s.id, false]),
  );
});

test("session ids map to their source; Pi ids have no prefix", () => {
  assert.equal(sourceForId(sources, "01a1b3c9-f58b-76d1").id, "pi");
  assert.equal(sourceForId(sources, "claude:c3b8dfaf").id, "claude");
  assert.equal(sourceForId(sources, "nope:123").id, "pi");
  assert.equal(nativeId(sources[1], "claude:c3b8dfaf"), "c3b8dfaf");
  assert.equal(nativeId(sources[0], "01a1b3c9"), "01a1b3c9");
});

test("a missing folder scans as empty, not an error", async () => {
  for (const source of sources) assert.deepEqual(await source.scan(), []);
});

test("usage counts any source by id", () => {
  const now = Date.parse("2026-11-06T12:00:00Z");
  const metas = [
    { source: "pi", cwd: "/a", created: "2026-11-06T09:00:00Z", mtimeMs: now, size: 10 },
    { source: "codex", cwd: "/a", created: "2026-11-05T09:00:00Z", mtimeMs: now, size: 5 },
    { source: "other", cwd: "/b", created: "2026-11-05T09:00:00Z", mtimeMs: now, size: 5 },
  ];
  const u = usageSummary(metas, { now, days: 7, sources: ["pi", "codex"] });
  assert.deepEqual(u.sources, ["pi", "codex"]);
  assert.equal(u.totals.sessions, 2); // "other" isn't a listed source
  assert.deepEqual(u.daily.slice(-2), [
    { date: "2026-11-05", pi: 0, codex: 1 },
    { date: "2026-11-06", pi: 1, codex: 0 },
  ]);
  assert.equal(u.workspaces[0].codex, 1);
});

test("Codex: loaded sessions without a window don't count as running", async () => {
  const { pickRunning } = await import("../server/sources/codex.mjs");
  const loaded = [
    { id: "old", status: "idle", mtimeMs: 100 },
    { id: "new", status: "idle", mtimeMs: 300 },
    { id: "work", status: "busy", mtimeMs: 50 },
  ];
  const ids = (windows) => pickRunning(loaded, windows).map((s) => s.id);
  assert.deepEqual(ids(0), ["work"]); // a busy turn is running whatever the count says
  assert.deepEqual(ids(1), ["work"]);
  assert.deepEqual(ids(2), ["work", "new"]);
  assert.deepEqual(ids(null), ["old", "new", "work"]); // count unknown: every loaded session
  assert.deepEqual(pickRunning(loaded.slice(0, 2), 1).map((s) => s.id), ["new"]);
});

test("Claude: sessions resumed from a command line are found by id", async () => {
  const { resumedIds } = await import("../server/sources/claude.mjs");
  const id = "b529eedc-f0be-476d-9244-4b63721bb428";
  const ids = resumedIds([
    `"C:\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe" --resume ${id}`,
    `node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js -r ${id.toUpperCase()}`,
    `claude --resume=${id}`,
    `"C:\Program Files\WindowsApps\Claude\app\claude.exe" --type=gpu-process`,
    `codex resume ${id}`,
    `claude --resume`,
  ]);
  assert.deepEqual([...ids], [id]);
  assert.equal(resumedIds(null).size, 0);
});

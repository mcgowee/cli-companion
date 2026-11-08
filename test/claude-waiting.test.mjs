import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSources } from "../server/sources/index.mjs";

test("Claude Code: a status file saying waiting makes the session 'waiting', with why", async () => {
  const dir = mkdtempSync(join(tmpdir(), "companion-claude-"));
  mkdirSync(join(dir, "sessions"));
  mkdirSync(join(dir, "projects"));
  const sid = "c3b8dfaf-3d87-4732-8488-b5695e3b23d1";
  writeFileSync(join(dir, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: sid, status: "waiting", waitingFor: "input needed", entrypoint: "cli" }));
  const claude = createSources({ CLAUDE_CONFIG_DIR: dir, PI_CODING_AGENT_DIR: join(dir, "nopi"), CODEX_HOME: join(dir, "nocodex") }).find((s) => s.id === "claude");
  const map = await claude.running();
  const id = [...map.keys()].find((k) => k.endsWith(sid));
  assert.equal(map.get(id), "waiting");
  assert.equal(map.waitingFor.get(id), "input needed");
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { companionPort, companionUrl, migrateStateFile, stateDir } from "../server/start.mjs";

test("companionPort: new name first, old name still works, bad values fall back", () => {
  assert.equal(companionPort({}), 30143);
  assert.equal(companionPort({ PI_COMPANION_PORT: "4000" }), 4000);
  assert.equal(companionPort({ CLI_COMPANION_PORT: "5000", PI_COMPANION_PORT: "4000" }), 5000);
  assert.equal(companionPort({ CLI_COMPANION_PORT: "nope" }), 30143);
  assert.equal(companionPort({ CLI_COMPANION_PORT: "70000" }), 30143);
  assert.equal(companionUrl(5000), "http://127.0.0.1:5000");
});

test("stateDir and moving a file over from the old Pi folder", () => {
  const root = mkdtempSync(join(tmpdir(), "companion-start-"));
  const env = { CLI_COMPANION_HOME: join(root, "new"), PI_CODING_AGENT_DIR: join(root, "agent") };
  assert.equal(stateDir(env), join(root, "new"));
  assert.equal(migrateStateFile("dashboards.json", env), false); // nothing to move
  mkdirSync(join(root, "agent", "companion"), { recursive: true });
  writeFileSync(join(root, "agent", "companion", "dashboards.json"), '{"dashboards":[]}');
  assert.equal(migrateStateFile("dashboards.json", env), true);
  assert.equal(readFileSync(join(root, "new", "dashboards.json"), "utf8"), '{"dashboards":[]}');
  writeFileSync(join(root, "agent", "companion", "dashboards.json"), '{"old":true}');
  assert.equal(migrateStateFile("dashboards.json", env), false); // never overwrites
  assert.equal(readFileSync(join(root, "new", "dashboards.json"), "utf8"), '{"dashboards":[]}');
});

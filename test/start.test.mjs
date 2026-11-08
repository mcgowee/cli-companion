import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hasKey, keyCookie, needsKey, sameKey } from "../server/access.mjs";
import { accessKey, companionOpenUrl, companionPort, companionUrl, migrateStateFile, removeRuntimeFile, rotateLog, runtimeFile, runtimePort, shutdownPlan, stateDir, writeRuntimeFile } from "../server/start.mjs";

const tempHome = () => ({ CLI_COMPANION_HOME: mkdtempSync(join(tmpdir(), "companion-home-")) });

test("companionPort: new name first, old name still works, bad values fall back", () => {
  const home = tempHome();
  assert.equal(companionPort(home), 30143);
  assert.equal(companionPort({ ...home, PI_COMPANION_PORT: "4000" }), 4000);
  assert.equal(companionPort({ ...home, CLI_COMPANION_PORT: "5000", PI_COMPANION_PORT: "4000" }), 5000);
  assert.equal(companionPort({ ...home, CLI_COMPANION_PORT: "nope" }), 30143);
  assert.equal(companionPort({ ...home, CLI_COMPANION_PORT: "70000" }), 30143);
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

test("companionPort: the port saved in Settings, unless the environment sets one", () => {
  const home = tempHome();
  writeFileSync(join(home.CLI_COMPANION_HOME, "settings.json"), JSON.stringify({ port: 31000 }));
  assert.equal(companionPort(home), 31000);
  assert.equal(companionPort({ ...home, CLI_COMPANION_PORT: "5000" }), 5000);
  writeFileSync(join(home.CLI_COMPANION_HOME, "settings.json"), JSON.stringify({ port: 99999 }));
  assert.equal(companionPort(home), 30143);
});

test("companionPort: the running server's port (server.json) beats Settings; env beats both; stale files are ignored", () => {
  const home = tempHome();
  // A process that has already exited: its pid is a dead one.
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
  writeFileSync(join(home.CLI_COMPANION_HOME, "settings.json"), JSON.stringify({ port: 31000 }));
  // No runtime file: Settings as before.
  assert.equal(companionPort(home), 31000);
  // A live server wrote it: its port wins over Settings, but never over the environment.
  writeRuntimeFile(30144, { env: home }); // pid defaults to this test's own (alive)
  assert.deepEqual(JSON.parse(readFileSync(runtimeFile(home), "utf8")).port, 30144);
  assert.equal(runtimePort(home), 30144);
  assert.equal(companionPort(home), 30144);
  assert.equal(companionPort({ ...home, CLI_COMPANION_PORT: "5000" }), 5000);
  // The server died without cleaning up: the stale file is ignored.
  writeRuntimeFile(30144, { pid: deadPid, env: home });
  assert.equal(runtimePort(home), undefined);
  assert.equal(companionPort(home), 31000);
  // A damaged file is ignored too.
  writeFileSync(runtimeFile(home), "{ not json");
  assert.equal(companionPort(home), 31000);
  writeFileSync(runtimeFile(home), JSON.stringify({ port: 30144, pid: "x" }));
  assert.equal(companionPort(home), 31000);
});

test("removeRuntimeFile: a server only removes its own file", () => {
  const home = tempHome();
  writeRuntimeFile(30144, { pid: 1234, env: home });
  removeRuntimeFile({ pid: 5678, env: home }); // another server's: left alone
  assert.equal(existsSync(runtimeFile(home)), true);
  removeRuntimeFile({ pid: 1234, env: home }); // its own: removed
  assert.equal(existsSync(runtimeFile(home)), false);
  removeRuntimeFile({ pid: 1234, env: home }); // already gone: no error
});

test("shutdownPlan: under systemd a restart exits non-zero for the manager; elsewhere we spawn our own", () => {
  // Plain start (Windows, macOS, Linux without systemd): restart spawns the replacement, exit 0.
  assert.deepEqual(shutdownPlan(true, {}), { spawnReplacement: true, exitCode: 0 });
  assert.deepEqual(shutdownPlan(false, {}), { spawnReplacement: false, exitCode: 0 });
  // Started by systemd (INVOCATION_ID set): restart = exit 1 and let Restart=on-failure act;
  // stop = exit 0 so the unit stays stopped.
  assert.deepEqual(shutdownPlan(true, { INVOCATION_ID: "4ad1f4215f1340d1a2cbd0314c0b8d44" }), { spawnReplacement: false, exitCode: 1 });
  assert.deepEqual(shutdownPlan(false, { INVOCATION_ID: "4ad1f4215f1340d1a2cbd0314c0b8d44" }), { spawnReplacement: false, exitCode: 0 });
});

test("accessKey: made once, then the same key; the open address carries it", () => {
  const home = tempHome();
  const key = accessKey(home);
  assert.match(key, /^[a-f0-9]{48}$/);
  assert.equal(accessKey(home), key);
  assert.equal(companionOpenUrl(4000, home), `http://127.0.0.1:4000/?key=${key}`);
  writeFileSync(join(home.CLI_COMPANION_HOME, "access-key"), "short\n");
  assert.notEqual(accessKey(home), "short"); // a damaged key is replaced
});

test("access gate: which paths need the key, and header or cookie both count", () => {
  for (const path of ["/api/sessions", "/events", "/bridge/inbox", "/ingest", "/app-files/x/a.html"]) assert.equal(needsKey(path), true, path);
  for (const path of ["/", "/index.html", "/app.js", "/icon.png", "/healthz"]) assert.equal(needsKey(path), false, path);
  const key = "a".repeat(48);
  assert.equal(hasKey({ "x-companion-key": key }, { port: 30143, key }), true);
  assert.equal(hasKey({ cookie: `theme=x; ${keyCookie(30143, key).split(";")[0]}` }, { port: 30143, key }), true);
  assert.equal(hasKey({ cookie: keyCookie(30155, key).split(";")[0] }, { port: 30143, key }), false); // another port's cookie
  assert.equal(hasKey({ "x-companion-key": "b".repeat(48) }, { port: 30143, key }), false);
  assert.equal(hasKey({}, { port: 30143, key }), false);
  assert.equal(sameKey("", ""), false);
  assert.match(keyCookie(30143, key), /HttpOnly; SameSite=Strict/);
});

test("rotateLog: a log past the limit becomes .1; a small one is left alone", () => {
  const dir = tempHome().CLI_COMPANION_HOME;
  const log = join(dir, "server.log");
  rotateLog(log, 10); // no log yet: no error
  writeFileSync(log, "short");
  rotateLog(log, 10);
  assert.equal(existsSync(log), true);
  writeFileSync(log, "x".repeat(20));
  rotateLog(log, 10);
  assert.equal(existsSync(log), false);
  assert.equal(readFileSync(`${log}.1`, "utf8").length, 20);
});

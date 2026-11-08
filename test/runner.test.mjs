import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { remoteAllowed } from "../server/remote.mjs";
import { createRunner, encodedCommand, looksInteractive, runPlan } from "../server/runner.mjs";
import { validateSettings } from "../server/settings.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(25)) if (check()) return;
  throw new Error("timed out");
}

test("runPlan: PowerShell -Command on Windows (UTF-8 output), login shell elsewhere", () => {
  const win = runPlan("git status; npm test", { platform: "win32", shell: "pwsh" });
  assert.equal(win.file, "pwsh");
  assert.deepEqual(win.args.slice(0, 3), ["-NoLogo", "-NonInteractive", "-Command"]);
  assert.match(win.args[3], /OutputEncoding.*\ngit status; npm test$/s);
  assert.deepEqual(runPlan("ls -la", { platform: "linux", userShell: "/bin/zsh" }), { file: "/bin/zsh", args: ["-lc", "ls -la"] });
});

test("encodedCommand: UTF-16LE base64 that shows the command, then runs it", () => {
  const script = Buffer.from(encodedCommand("codex.cmd -C C:\\work\\x; echo 'hi'"), "base64").toString("utf16le");
  assert.equal(script, "Write-Host ('PS> ' + 'codex.cmd -C C:\\work\\x; echo ''hi''') -ForegroundColor DarkGray\ncodex.cmd -C C:\\work\\x; echo 'hi'");
});

test("looksInteractive: programs you type into, not one-shot commands", () => {
  for (const c of ["codex.cmd -C C:\\work\\codex --sandbox workspace-write", "codex", "pi", "claude --resume x", "ssh me@box", "python", "node"]) assert.equal(looksInteractive(c), true, c);
  for (const c of ["codex exec 'fix it'", "ollama list", "pi --version", "git status", "npm test", "python build.py", "node script.js"]) assert.equal(looksInteractive(c), false, c);
});

// A fake shell: node runs the "command" as JavaScript, so the test needs no PowerShell.
const nodeShell = (file, args, options) => spawn(process.execPath, ["-e", args.at(-1)], options);

test("runner: runs, streams output, reports the exit code, lists runs per folder", async () => {
  const runner = createRunner({ spawnFn: nodeShell });
  const cwd = tmpdir();
  const run = runner.start({ command: "console.log('one'); console.error('two'); process.exit(3)", cwd, sessionId: "s1", platform: "linux" });
  assert.equal(run.status, "running");
  await until(() => runner.read(run.runId).status !== "running");
  const done = runner.read(run.runId);
  assert.equal(done.status, "failed");
  assert.equal(done.exitCode, 3);
  assert.match(done.output, /one/);
  assert.match(done.output, /two/);
  assert.equal(runner.read(run.runId, done.next).output, ""); // nothing new after `next`
  assert.equal(runner.list(cwd)[0].runId, run.runId);
  assert.deepEqual(runner.list("/elsewhere"), []);
  assert.throws(() => runner.start({ command: "   ", cwd, platform: "linux" }), /Type a command/);
});

test("runner: Stop ends a running command", async () => {
  const runner = createRunner({ spawnFn: nodeShell });
  const run = runner.start({ command: "console.log('started'); setInterval(() => {}, 1000)", cwd: tmpdir(), platform: "linux" });
  await until(() => runner.read(run.runId).output.includes("started"));
  assert.equal(runner.stop(run.runId).status, "stopped");
  await until(() => runner.read(run.runId).exitCode !== null || runner.read(run.runId).endedAt);
  assert.equal(runner.read(run.runId).status, "stopped");
  runner.stopAll();
});

test("Terminal tab: off by default, never from the phone", () => {
  assert.equal(validateSettings({}).runCommands, undefined);
  assert.equal(validateSettings({ runCommands: true }).runCommands, true);
  assert.equal(validateSettings({ runCommands: "yes" }).runCommands, undefined);
  const on = { enabled: true, reply: true };
  for (const [method, path] of [["GET", "/api/runs"], ["GET", "/api/run"], ["POST", "/api/run"], ["POST", "/api/run/stop"], ["POST", "/api/run/open"]]) {
    assert.equal(remoteAllowed(method, path, on), false, `${method} ${path}`);
  }
});

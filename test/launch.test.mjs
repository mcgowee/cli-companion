import assert from "node:assert/strict";
import { test } from "node:test";
import { cliCommand, copyLine, LaunchError, openPlan, quotePath } from "../server/launch.mjs";

test("cliCommand: fixed commands only, session ids checked", () => {
  assert.equal(cliCommand("terminal"), "");
  assert.equal(cliCommand("pi"), "pi");
  assert.equal(cliCommand("pi-continue"), "pi -c");
  assert.equal(cliCommand("claude"), "claude");
  assert.equal(cliCommand("resume", { source: "pi", sessionId: "01a1b3c9-f58b-76d1" }), "pi --session 01a1b3c9-f58b-76d1");
  assert.equal(
    cliCommand("resume", { source: "claude", sessionId: "c3b8dfaf-3d87-4732-8488-b5695e3b23d1" }),
    "claude --resume c3b8dfaf-3d87-4732-8488-b5695e3b23d1",
  );
  assert.throws(() => cliCommand("resume", { source: "pi", sessionId: "x; rm -rf /" }), LaunchError);
  assert.throws(() => cliCommand("rm"), LaunchError);
});

test("copyLine quotes the folder for PowerShell and POSIX shells", () => {
  assert.equal(quotePath("C:\\AI\\it's", "win32"), "'C:\\AI\\it''s'");
  assert.equal(copyLine("C:\\AI\\pi", "pi -c", "win32"), "cd 'C:\\AI\\pi'; pi -c");
  assert.equal(copyLine("C:\\AI\\pi", "", "win32"), "cd 'C:\\AI\\pi'");
  assert.equal(copyLine("/home/me/it's", "claude", "linux"), "cd '/home/me/it'\\''s' && claude");
});

test("openPlan: Windows Terminal in the folder, PowerShell fallback, nothing elsewhere", () => {
  const plan = openPlan("C:\\AI\\pi", "pi", { platform: "win32", shell: "pwsh" });
  assert.deepEqual(plan.terminal, { file: "wt.exe", args: ["-w", "new", "-d", "C:\\AI\\pi", "pwsh", "-NoExit", "-Command", "pi"] });
  assert.deepEqual(plan.fallback, { file: "pwsh", args: ["-NoExit", "-Command", "pi"], cwd: "C:\\AI\\pi" });
  assert.deepEqual(openPlan("C:\\AI\\pi", "", { platform: "win32", shell: "pwsh" }).terminal.args.slice(-2), ["pwsh", "-NoLogo"]);
  assert.equal(openPlan("/home/me", "pi", { platform: "linux" }), undefined);
  assert.throws(() => openPlan("C:\\a;b", "pi", { platform: "win32" }), LaunchError);
});

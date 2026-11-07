import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSessionId, copyLine, LaunchError, openPlan, quotePath, resumeCommand, workspaceActions } from "../server/launch.mjs";
import { createSources } from "../server/sources/index.mjs";

test("commands come from the sources' fixed lists; session ids are checked", () => {
  const sources = createSources({ CLAUDE_CONFIG_DIR: "/nowhere/claude", PI_CODING_AGENT_DIR: "/nowhere/pi", CODEX_HOME: "/nowhere/codex" });
  const [pi, claude] = sources;
  // Pi is always offered (it can be live before its folder exists); others only when installed.
  assert.deepEqual(
    workspaceActions(sources).map((o) => [o.action, o.command]),
    [["terminal", ""], ["pi", "pi"], ["pi-continue", "pi -c"]],
  );
  const installed = sources.map((s) => Object.defineProperty({ ...s }, "installed", { value: true }));
  assert.deepEqual(
    workspaceActions(installed).map((o) => o.command),
    ["", "pi", "pi -c", "claude", "codex", "codex resume --last"],
  );
  assert.equal(resumeCommand(pi, "01a1b3c9-f58b-76d1"), "pi --session 01a1b3c9-f58b-76d1");
  assert.equal(
    resumeCommand(claude, "c3b8dfaf-3d87-4732-8488-b5695e3b23d1"),
    "claude --resume c3b8dfaf-3d87-4732-8488-b5695e3b23d1",
  );
  assert.throws(() => resumeCommand(pi, "x; rm -rf /"), LaunchError);
  assert.throws(() => checkSessionId(""), LaunchError);
  // A switched-off source drops out of the workspace menu.
  const noClaude = createSources({ CLI_COMPANION_CLAUDE: "0", CODEX_HOME: "/nowhere/codex" }).map((s) => Object.defineProperty({ ...s }, "installed", { value: true }));
  assert.deepEqual(workspaceActions(noClaude).map((o) => o.action), ["terminal", "pi", "pi-continue", "codex", "codex-last"]);
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

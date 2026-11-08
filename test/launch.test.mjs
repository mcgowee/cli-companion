import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSessionId, copyLine, defaultSshHost, headlessNote, isHeadless, LaunchError, openPlan, pidAncestry, quotePath, resumeCommand, sshAttachOption, tmuxSessionFromPanes, workspaceActions } from "../server/launch.mjs";
import { createSources } from "../server/sources/index.mjs";

test("commands come from the sources' fixed lists; session ids are checked", () => {
  const sources = createSources({ CLAUDE_CONFIG_DIR: "/nowhere/claude", PI_CODING_AGENT_DIR: "/nowhere/pi", CODEX_HOME: "/nowhere/codex" });
  const [pi, claude] = sources;
  // Only CLIs that are installed (their folder exists) are offered, Pi included.
  assert.deepEqual(
    workspaceActions(sources).map((o) => [o.action, o.command]),
    [["terminal", ""]],
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
  assert.equal(quotePath("C:\\work\\it's", "win32"), "'C:\\work\\it''s'");
  assert.equal(copyLine("C:\\work\\pi", "pi -c", "win32"), "cd 'C:\\work\\pi'; pi -c");
  assert.equal(copyLine("C:\\work\\pi", "", "win32"), "cd 'C:\\work\\pi'");
  assert.equal(copyLine("/home/me/it's", "claude", "linux"), "cd '/home/me/it'\\''s' && claude");
});

test("openPlan: Windows Terminal, then a PowerShell window", () => {
  const [wt, console_] = openPlan("C:\\work\\pi", "pi", { platform: "win32", shell: "pwsh" });
  assert.deepEqual(wt, { file: "wt.exe", args: ["-w", "new", "-d", "C:\\work\\pi", "pwsh", "-NoExit", "-Command", "pi"] });
  assert.deepEqual(console_, { file: "pwsh", args: ["-NoExit", "-Command", "pi"], cwd: "C:\\work\\pi" });
  assert.deepEqual(openPlan("C:\\work\\pi", "", { platform: "win32", shell: "pwsh" })[0].args.slice(-2), ["pwsh", "-NoLogo"]);
  // ";" breaks Windows Terminal's arguments: only the PowerShell window is left, or an error if that was the choice.
  assert.deepEqual(openPlan("C:\\a;b", "pi", { platform: "win32", shell: "pwsh" }).map((p) => p.file), ["pwsh"]);
  assert.throws(() => openPlan("C:\\a;b", "pi", { platform: "win32", terminal: "wt" }), LaunchError);
  assert.equal(openPlan("C:\\x", "pi", { platform: "win32", terminal: "console" }).length, 1);
});

test("openPlan: macOS Terminal or iTerm via AppleScript, quotes escaped", () => {
  const [terminal, iterm] = openPlan("/Users/me/it's \"x\"", "pi -c", { platform: "darwin" });
  assert.equal(terminal.file, "osascript");
  // The shell line is  cd '/Users/me/it'\''s "x"' && pi -c ; AppleScript doubles its \ and escapes its ".
  assert.equal(terminal.args[1], `tell application "Terminal" to do script "cd '/Users/me/it'\\\\''s \\"x\\"' && pi -c"`);
  assert.match(iterm.args[1], /^tell application "iTerm"/);
});

test("isHeadless: only Linux-likes without a graphical session; Windows and macOS never", () => {
  assert.equal(isHeadless({ platform: "linux", env: {} }), true);
  assert.equal(isHeadless({ platform: "linux", env: { DISPLAY: ":0" } }), false);
  assert.equal(isHeadless({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } }), false);
  assert.equal(isHeadless({ platform: "win32", env: {} }), false);
  assert.equal(isHeadless({ platform: "darwin", env: {} }), false);
  assert.equal(isHeadless({ platform: "freebsd", env: {} }), true);
});

test("pidAncestry walks /proc parents, survives odd comm names, stops at init or a vanished process", () => {
  // 400 (pi) ← 300 (the pane's shell, comm with spaces and ")") ← 200 (tmux server, parent 1).
  const stats = {
    400: "400 (pi) S 300 400 300 0 -1",
    300: "300 (my (weird) sh) S 200 300 300 0 -1",
    200: "200 (tmux: server) S 1 200 200 0 -1",
  };
  const read = (pid) => {
    if (!stats[pid]) throw new Error("ENOENT");
    return stats[pid];
  };
  assert.deepEqual(pidAncestry(400, read), [400, 300, 200]);
  assert.deepEqual(pidAncestry(300, read), [300, 200]);
  // The process is gone (or /proc isn't there): the chain is just what was asked about.
  assert.deepEqual(pidAncestry(999, read), [999]);
  assert.deepEqual(pidAncestry(undefined, read), []);
});

test("tmuxSessionFromPanes: the pane whose shell is an ancestor names the session", () => {
  const panes = "300\tcharloop\n500\tother one\n";
  assert.equal(tmuxSessionFromPanes(panes, [400, 300, 200]), "charloop");
  assert.equal(tmuxSessionFromPanes(panes, [501, 500, 1]), "other one");
  assert.equal(tmuxSessionFromPanes(panes, [700, 600]), "");
  assert.equal(tmuxSessionFromPanes("", [400, 300]), "");
  assert.equal(tmuxSessionFromPanes(undefined, [400]), "");
});

test("the headless menu: an ssh attach line for tmux, and a note naming the host", () => {
  const option = sshAttachOption("charloop", "aegis");
  assert.equal(option.copy, "ssh -t aegis tmux attach -t 'charloop'");
  assert.equal(option.action, "ssh-attach");
  assert.equal(option.label, "Attach over SSH (tmux: charloop)");
  assert.equal(option.command, "", "nothing for Open to run — it's a line to paste elsewhere");
  assert.match(headlessNote("aegis"), /no graphical terminal/i);
  assert.match(headlessNote("aegis"), /aegis/);
});

test("the SSH name: user@hostname unless Settings says otherwise, and only the default hints at Settings", () => {
  // Not set in Settings: user@hostname, so at least the user is right.
  const def = defaultSshHost();
  assert.match(def, /^.+@.+$/);
  assert.equal(sshAttachOption("charloop").copy, `ssh -t ${def} tmux attach -t 'charloop'`);
  assert.equal(sshAttachOption("charloop", "aegis").copy, "ssh -t aegis tmux attach -t 'charloop'");
  // The note points at Settings only while the name is the guessed default.
  assert.match(headlessNote(), /SSH name for this computer/);
  assert.match(headlessNote(def, { custom: false }), /Settings/);
  assert.doesNotMatch(headlessNote("aegis", { custom: true }), /Settings/);
  assert.match(headlessNote("aegis", { custom: true }), /aegis/);
});

test("openPlan: Linux terminals run a login shell that stays open", () => {
  const plans = openPlan("/home/me", "claude", { platform: "linux", userShell: "/bin/zsh" });
  assert.equal(plans[0].file, "x-terminal-emulator");
  const gnome = plans.find((p) => p.file === "gnome-terminal");
  assert.deepEqual(gnome.args, ["--working-directory", "/home/me", "--", "/bin/zsh", "-lc", "claude; exec /bin/zsh"]);
  assert.deepEqual(openPlan("/home/me", "", { platform: "linux", terminal: "kitty" })[0].args, ["--directory", "/home/me", "bash", "-lc", "exec bash"]);
  assert.throws(() => openPlan("/home/me", "pi", { platform: "linux", terminal: "wt" }), LaunchError);
});

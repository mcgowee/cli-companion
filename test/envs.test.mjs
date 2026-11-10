import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addComputer, addRecent, checkFolder, checkHost, checkRemotePath, EnvError, loadStart, LOCAL_ID, pickComputer, recentFor, remotePiLine, remoteSessionName, removeComputer, setPin, sshPiCommand, updateStart } from "../server/envs.mjs";

const HOME = process.platform === "win32" ? "C:\\Users\\me" : "/home/me";

test("checks: hosts and remote folders are plain words", () => {
  for (const ok of ["aegis", "me@100.72.12.1", "box_2.lan"]) assert.equal(checkHost(ok), ok);
  for (const bad of ["", "-oProxyCommand=x", "a b", "a;b", "a'b", "$(x)", "a/b"]) assert.throws(() => checkHost(bad), EnvError, bad);
  assert.equal(checkRemotePath(""), "~");
  assert.equal(checkRemotePath("~/projects/pi/charloop/"), "~/projects/pi/charloop");
  assert.equal(checkRemotePath("/srv/app"), "/srv/app");
  for (const bad of ["projects", "~/a b", "~/../etc", "~/a;rm", "~/-x", "~user/x", "/a/'b'"]) assert.throws(() => checkRemotePath(bad), EnvError, bad);
});

test("the remote line: new Pi window in the folder's tmux session, else create it; then attach", () => {
  assert.equal(remoteSessionName("aegis", "~/projects/pi/charloop"), "charloop");
  assert.equal(remoteSessionName("me@aegis", "~"), "aegis");
  assert.equal(remoteSessionName("aegis", "~/my.app"), "my-app");
  assert.equal(
    remotePiLine("aegis", "~/projects/pi/charloop"),
    "tmux has-session -t =charloop 2>/dev/null && tmux new-window -t =charloop: -c ~/projects/pi/charloop bash -lc pi; tmux new-session -A -s charloop -c ~/projects/pi/charloop bash -lc pi",
  );
  assert.ok(!remotePiLine("aegis", "~").includes("'"));
  assert.equal(sshPiCommand("aegis", "~"), `ssh -t aegis '${remotePiLine("aegis", "~")}'`);
});

test("folder search: plain words only; remote output parsed; local roots and search", async () => {
  const { checkQuery, localRoots, parseRemoteSearch, remoteSearchScript, searchLocal } = await import("../server/envs.mjs");
  const { mkdir } = await import("node:fs/promises");
  assert.equal(checkQuery(" charl "), "charl");
  for (const bad of ["", "c", "a b", "a'b", "*", "$(x)", "x".repeat(61)]) assert.throws(() => checkQuery(bad), EnvError, bad);
  assert.ok(remoteSearchScript("charl").includes("-iname '*charl*'"));
  assert.deepEqual(parseRemoteSearch("2 ~/projects/charloop\n3 ~/projects/pi/charloop\n2 ~/a b\n1 /etc\n"), [
    { path: "~/projects/charloop", name: "charloop" },
    { path: "~/projects/pi/charloop", name: "charloop" },
  ]);
  if (process.platform === "win32") {
    assert.deepEqual(
      localRoots("C:\\Users\\me", ["C:\\AI\\pi\\app", "C:\\Users\\me\\x", "D:\\work\\y", "C:\\WINDOWS\\system32", "\\home\\me\\p"]),
      ["C:\\Users\\me", "C:\\AI", "D:\\work"],
    );
  }
  const dir = await mkdtemp(join(tmpdir(), "cc-fsearch-"));
  try {
    for (const p of ["a/charloop", "b/c/CharLoop2", "node_modules/charloop-pkg", ".hidden/charloop"]) await mkdir(join(dir, p), { recursive: true });
    assert.deepEqual((await searchLocal([dir], "charl")).map((f) => f.name), ["charloop", "CharLoop2"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("folder list before typing: recent session folders; ~/projects over SSH; the Windows folder window", async () => {
  const { recentFolders, remoteListScript, windowsFolderDialogScript } = await import("../server/envs.mjs");
  const dir = await mkdtemp(join(tmpdir(), "cc-recent-"));
  try {
    const a = join(dir, "a");
    const b = join(dir, "b");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(a);
    await mkdir(b);
    const metas = [
      { cwd: a, lastActivity: 10 },
      { cwd: b, lastActivity: 30 },
      { cwd: a, lastActivity: 20 },
      { cwd: join(dir, "gone"), lastActivity: 99 },
      { cwd: "relative/x", lastActivity: 50 },
    ];
    assert.deepEqual((await recentFolders(metas)).map((f) => f.name), ["b", "a"]);
    assert.equal((await recentFolders(metas, { limit: 1 })).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.match(remoteListScript(), /find projects -mindepth 1 -maxdepth 2/);
  const ps = windowsFolderDialogScript("C:\\it's here");
  assert.ok(ps.includes("$d.InitialDirectory = 'C:\\it''s here'"), "start folder quoted for PowerShell");
  assert.ok(ps.includes("FolderBrowserDialog"));
});

test("Start Pi: computers, pinned and recent folders, survive a reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-start-"));
  try {
    const file = join(dir, "computers.json");
    const opts = { home: HOME };
    let s = await loadStart(file, opts);
    assert.deepEqual(s, { current: LOCAL_ID, computers: [], pins: [], recent: [], sessions: [] });
    s = await updateStart(file, opts, (x) => addComputer(x, " aegis "));
    assert.deepEqual(s.computers, [{ host: "aegis" }]);
    assert.equal(s.current, "aegis", "a computer you add is picked");
    await assert.rejects(updateStart(file, opts, (x) => addComputer(x, "a b")), EnvError);
    await assert.rejects(updateStart(file, opts, (x) => pickComputer(x, "nope")), EnvError);
    s = await updateStart(file, opts, (x) => {
      setPin(x, { computer: "aegis", path: "~/projects/pi/charloop" }, true);
      addRecent(x, { computer: "aegis", path: "~/projects/pi/loralab" }, 100);
      addRecent(x, { computer: "aegis", path: "~/projects/pi/charloop" }, 200);
      addRecent(x, { computer: LOCAL_ID, path: dir }, 150);
    });
    // Pinned ones aren't repeated under Recent; found folders merge in by time.
    const found = [{ path: "~/projects/cli-companion", at: 300 }, { path: "~/projects/pi/loralab", at: 50 }];
    assert.deepEqual(recentFor(s, "aegis", found).map((x) => x.path), ["~/projects/cli-companion", "~/projects/pi/loralab"]);
    assert.deepEqual(recentFor(s, LOCAL_ID).map((x) => x.path), [dir]);
    s = await updateStart(file, opts, (x) => setPin(x, { computer: "aegis", path: "~/projects/pi/charloop" }, false));
    assert.equal(s.pins.length, 0);
    s = await loadStart(file, opts);
    assert.equal(s.recent.length, 3);
    s = await updateStart(file, opts, (x) => removeComputer(x, "aegis"));
    assert.deepEqual([s.current, s.computers.length, s.recent.map((x) => x.computer)], [LOCAL_ID, 0, [LOCAL_ID]], "its folders go with it");
    await assert.rejects(checkFolder(LOCAL_ID, join(dir, "missing")), EnvError);
    assert.equal(await checkFolder(LOCAL_ID, `${dir}${process.platform === "win32" ? "\\" : "/"}`), dir);
    assert.equal(await checkFolder("aegis", "~/x/"), "~/x");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Start Pi: the old environments.json becomes computers and pinned folders, once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-start-old-"));
  try {
    const oldFile = join(dir, "environments.json");
    await writeFile(
      oldFile,
      JSON.stringify({
        current: "e2",
        envs: [
          { id: "e1", name: "Aegis SSH", kind: "ssh", host: "aegis", path: "~" },
          { id: "e2", name: "Aegis charloop", kind: "ssh", host: "aegis", path: "~/projects/pi/charloop" },
          { id: "e3", name: "Mine", kind: "local", path: dir },
          { id: "e4", name: "Bad", kind: "ssh", host: "a b", path: "~" },
        ],
      }),
    );
    const s = await loadStart(join(dir, "computers.json"), { oldFile, home: HOME });
    assert.deepEqual(s.computers, [{ host: "aegis" }]);
    assert.deepEqual(s.pins, [{ computer: "aegis", path: "~/projects/pi/charloop" }, { computer: LOCAL_ID, path: dir }]);
    assert.equal(s.current, "aegis");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Start Pi on an SSH computer: where Pi ran there, and Test's checklist", async () => {
  const { remoteRecentScript, parseRemoteRecent, remoteTestScript, testResults, tunnelPort } = await import("../server/envs.mjs");
  assert.match(remoteRecentScript(), /\.pi\/agent\/sessions/);
  const out = "H/home/me\n1700000300 /home/me/projects/pi/charloop\n1700000200 /home/me\n1700000100 /srv/a b\n1700000050 /home/me/projects/pi/charloop\n";
  assert.deepEqual(parseRemoteRecent(out), [
    { path: "~/projects/pi/charloop", at: 1700000300000 },
    { path: "~", at: 1700000200000 },
  ]);
  assert.match(remoteTestScript("aegis"), new RegExp(`:${tunnelPort("aegis")} `));
  const all = testResults("aegis", "login\ntmux\npi\nextension\nport-free\n", "");
  assert.ok(all.every((c) => c.ok));
  const some = testResults("aegis", "login\npi\nport-busy\n", "");
  assert.deepEqual(some.map((c) => c.ok), [true, false, true, false, false]);
  const none = testResults("aegis", "", "Permission denied (publickey)");
  assert.equal(none.length, 1);
  assert.equal(none[0].ok, false);
  assert.match(none[0].fix, /SSH key/);
});

test("Select remote folder: plain paths only, a fixed script, its output parsed", async () => {
  const { checkBrowsePath, remoteDirScript, parseRemoteDir, tildePath } = await import("../server/envs.mjs");
  assert.equal(checkBrowsePath(""), "~");
  assert.equal(checkBrowsePath("/"), "/");
  assert.equal(checkBrowsePath("/home/me/"), "/home/me");
  assert.equal(checkBrowsePath("~/projects"), "~/projects");
  for (const bad of ["projects", "/a/../etc", "~/./x", "/a b", "/a;b", "$(x)", "/a/'b'", "~user"]) assert.throws(() => checkBrowsePath(bad), EnvError, bad);
  const script = remoteDirScript("/home/me");
  assert.match(script, /cd \/home\/me 2>\/dev\/null/);
  assert.match(script, /-maxdepth 1 -type d ! -name '\.\*'/);
  const out = parseRemoteDir("H/home/me\nP/home/me/projects\nDpi\nDweird name\nDapp\n");
  assert.deepEqual(out, { home: "/home/me", path: "/home/me/projects", folders: ["pi", "app"] });
  assert.equal(parseRemoteDir("H/home/me\nE\n").error.length > 0, true);
  assert.equal(tildePath("/home/me/projects", "/home/me"), "~/projects");
  assert.equal(tildePath("/home/me", "/home/me"), "~");
  assert.equal(tildePath("/home/meow", "/home/me"), "/home/meow");
  assert.equal(tildePath("/srv", "/home/me"), "/srv");
});

test("the tunnel: a fixed port per computer, the ssh line, the key and session-file scripts", async () => {
  const { tunnelPort, keyPushScript, checkRemoteSessionFile, remoteReadScript } = await import("../server/envs.mjs");
  const t = tunnelPort("aegis");
  assert.equal(t, tunnelPort("AEGIS"));
  assert.ok(t >= 31000 && t < 31900);
  const line = sshPiCommand("aegis", "~/projects/pi/charloop", { port: 30143 });
  assert.ok(line.startsWith(`ssh -t -R ${t}:127.0.0.1:30143 aegis '`));
  assert.ok(line.includes(`tmux new-window -e CLI_COMPANION_PORT=${t} -e CLI_COMPANION_HOME=$HOME/.cli-companion-tunnel -t =charloop:`));
  assert.match(line, /tmux new-session -e CLI_COMPANION_PORT=\d+ -e CLI_COMPANION_HOME=\S+ -A -s charloop/);
  assert.equal(line.split("'").length, 3, "one quoted remote line");
  assert.match(keyPushScript(), /umask 077/);
  const f = "/home/me/.pi/agent/sessions/--home-me-projects--/2026-11-09T18-00-00_abc.jsonl";
  assert.equal(checkRemoteSessionFile(f), f);
  for (const bad of ["relative/sessions/x.jsonl", "/home/me/sessions/../x.jsonl", "/home/me/x.jsonl", "/home/me/sessions/a b.jsonl", "/home/me/sessions/x.jsonl;rm", "/home/me/sessions/$(x).jsonl"]) {
    assert.equal(checkRemoteSessionFile(bad), undefined, bad);
  }
  assert.match(remoteReadScript(f, 100), /tail -c \+101 /);
  assert.throws(() => remoteReadScript("/etc/passwd"), EnvError);
});

test("sessions that ran over the tunnel are remembered, checked, newest first, and go with their computer", async () => {
  const { rememberRemoteSession, cleanRemoteSession } = await import("../server/envs.mjs");
  const state = { current: LOCAL_ID, computers: [{ host: "aegis" }], pins: [], recent: [], sessions: [] };
  const file = "/home/me/.pi/agent/sessions/--home-me-x--/a.jsonl";
  rememberRemoteSession(state, { id: "s1", via: "aegis", file, cwd: "/home/me/x", name: "first", at: 1 });
  rememberRemoteSession(state, { id: "s2", via: "aegis", file, cwd: "/home/me/x", at: 2 });
  rememberRemoteSession(state, { id: "s1", via: "aegis", file, cwd: "/home/me/x", at: 3 });
  assert.deepEqual(state.sessions.map((x) => [x.id, x.name, x.at]), [["s1", "first", 3], ["s2", undefined, 2]], "updated in place, name kept");
  rememberRemoteSession(state, { id: "s3", via: "other", file, cwd: "/home/me/x", at: 4 });
  assert.equal(state.sessions.length, 2, "only computers in the list");
  for (const bad of [{ id: "a b", via: "aegis", file, cwd: "/x" }, { id: "s", via: "aegis", file: "/etc/passwd", cwd: "/x" }, { id: "s", via: "aegis", file, cwd: "relative" }]) {
    assert.equal(cleanRemoteSession(bad), null);
  }
  removeComputer(state, "aegis");
  assert.equal(state.sessions.length, 0);
});

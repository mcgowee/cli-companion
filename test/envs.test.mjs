import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addEnv, checkHost, checkRemotePath, EnvError, loadEnvs, LOCAL_ID, pickEnv, remotePiLine, remoteSessionName, removeEnv, sshPiCommand } from "../server/envs.mjs";

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

test("a Local environment's folder is optional (home)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-envopt-"));
  try {
    const s = await addEnv(join(dir, "environments.json"), dir, { name: "Home", kind: "local", path: "" });
    assert.equal(s.envs[1].path, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("environments: This computer always there, add local/ssh, pick, remove, survive a reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-envs-"));
  try {
    const file = join(dir, "environments.json");
    let s = await loadEnvs(file, HOME);
    assert.deepEqual(s, { envs: [{ id: LOCAL_ID, name: "This computer", kind: "local", path: HOME }], current: LOCAL_ID });
    s = await addEnv(file, HOME, { name: " Aegis   SSH ", kind: "ssh", host: "aegis", path: "" });
    const aegis = s.envs[1];
    assert.deepEqual({ ...aegis, id: "x" }, { id: "x", name: "Aegis SSH", kind: "ssh", host: "aegis", path: "~" });
    assert.equal(s.current, aegis.id, "a new one is picked");
    s = await addEnv(file, HOME, { name: "Scratch", kind: "local", path: dir });
    await assert.rejects(addEnv(file, HOME, { name: "Nope", kind: "local", path: join(dir, "missing") }), EnvError);
    await assert.rejects(addEnv(file, HOME, { name: "Bad", kind: "ssh", host: "a b", path: "~" }), EnvError);
    await assert.rejects(addEnv(file, HOME, { name: "", kind: "ssh", host: "aegis", path: "~" }), EnvError);
    s = await pickEnv(file, HOME, aegis.id);
    s = await loadEnvs(file, HOME);
    assert.equal(s.envs.length, 3);
    assert.equal(s.current, aegis.id);
    await assert.rejects(removeEnv(file, HOME, LOCAL_ID), EnvError);
    await assert.rejects(pickEnv(file, HOME, "gone"), EnvError);
    s = await removeEnv(file, HOME, aegis.id);
    assert.equal(s.current, LOCAL_ID, "removing the picked one falls back to This computer");
    assert.equal(s.envs.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

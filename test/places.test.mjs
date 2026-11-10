import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addFolder, addHost, checkHost, loadPlaces, parseRemoteList, PlaceError, remoteListScript, removePlace, sshArgs, sshCopyLine } from "../server/places.mjs";

test("checkHost: names ssh understands, nothing that could be an option or a second word", () => {
  for (const ok of ["aegis", "me@box.example.com", "my_host-2"]) assert.equal(checkHost(ok), ok);
  for (const bad of ["", "-oProxyCommand=x", "a b", "a;b", "a'b", "a\"b", "$(x)", "a/b"]) assert.throws(() => checkHost(bad), PlaceError, bad);
});

test("parseRemoteList: folders sorted, tmux sessions marked, odd names dropped", () => {
  const out = "Fcharloop\nFblenderlab\nFmy.app\nFbad name\nF-x\nScharloop\nSmy-app\n";
  assert.deepEqual(parseRemoteList(out), [
    { name: "blenderlab", tmux: "blenderlab", running: false },
    { name: "charloop", tmux: "charloop", running: true },
    { name: "my.app", tmux: "my-app", running: true },
  ]);
  assert.deepEqual(parseRemoteList(""), []);
  assert.match(remoteListScript(), /^cd ~\/projects /);
});

test("sshArgs / sshCopyLine: plain words only, attach-or-create in ~/projects/<name>", () => {
  assert.deepEqual(sshArgs("aegis", "charloop", "shell"), ["-t", "aegis", "tmux", "new-session", "-A", "-s", "charloop", "-c", "~/projects/charloop"]);
  assert.deepEqual(sshArgs("aegis", "my.app", "pi").slice(-5), ["-s", "my-app", "-c", "~/projects/my.app", "bash", "-lc", "pi"].slice(-5));
  assert.equal(sshCopyLine("aegis", "charloop", "pi"), "ssh -t aegis tmux new-session -A -s charloop -c '~/projects/charloop' bash -lc pi");
  assert.throws(() => sshArgs("aegis", "../x", "shell"), PlaceError);
  assert.throws(() => sshArgs("aegis", "x y", "shell"), PlaceError);
  assert.throws(() => sshArgs("aegis", "x", "rm"), PlaceError);
  assert.throws(() => sshArgs("-x", "x", "shell"), PlaceError);
});

test("places: folders must exist, no duplicates, hosts added and removed, survive a reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-places-"));
  try {
    const file = join(dir, "places.json");
    assert.deepEqual(await loadPlaces(file), { folders: [], hosts: [] });
    let p = await addFolder(file, dir);
    assert.equal(p.folders.length, 1);
    p = await addFolder(file, `${dir}${process.platform === "win32" ? "\\" : "/"}`);
    assert.equal(p.folders.length, 1, "same folder with a trailing slash");
    await assert.rejects(addFolder(file, join(dir, "nope")), PlaceError);
    await assert.rejects(addFolder(file, "relative/dir"), PlaceError);
    p = await addHost(file, "aegis");
    p = await addHost(file, "aegis");
    assert.equal(p.hosts.length, 1);
    await assert.rejects(addHost(file, "a b"), PlaceError);
    const reloaded = await loadPlaces(file);
    assert.equal(reloaded.folders[0].path, dir);
    p = await removePlace(file, "host", reloaded.hosts[0].id);
    p = await removePlace(file, "folder", reloaded.folders[0].id);
    assert.deepEqual(p, { folders: [], hosts: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

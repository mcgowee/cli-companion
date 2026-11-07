import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopEntry, setShortcut, shortcutPaths, shortcutStatus } from "../server/shortcut.mjs";

test("shortcutPaths: Start menu on Windows, applications folder on Linux, none on macOS", async () => {
  const win = await shortcutPaths({ platform: "win32", env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" } });
  assert.equal(win.start, join("C:\\Users\\u\\AppData\\Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "CLI Companion.lnk"));
  assert.ok(win.desktop.endsWith("CLI Companion.lnk"));
  const linux = await shortcutPaths({ platform: "linux", env: { XDG_DATA_HOME: "/home/u/.data" } });
  assert.equal(linux.start, join("/home/u/.data", "applications", "cli-companion.desktop"));
  assert.equal(await shortcutPaths({ platform: "darwin", env: {} }), null);
});

test("desktopEntry: quoted Exec, icon, no terminal", () => {
  const entry = desktopEntry({ node: "/usr/bin/node", bin: '/opt/my "apps"/cli-companion.mjs', icon: "/opt/icon.png" });
  assert.match(entry, /^\[Desktop Entry\]\n/);
  assert.match(entry, /\nExec="\/usr\/bin\/node" "\/opt\/my \\"apps\\"\/cli-companion\.mjs"\n/);
  assert.match(entry, /\nIcon=\/opt\/icon\.png\n/);
  assert.match(entry, /\nTerminal=false\n/);
});

test("setShortcut on Linux writes and removes the .desktop file; status follows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shortcut-"));
  const opts = { platform: "linux", env: { XDG_DATA_HOME: dir } };
  assert.equal((await shortcutStatus(opts)).places.start.exists, false);
  const file = await setShortcut("start", true, opts);
  assert.match(await readFile(file, "utf8"), /Name=CLI Companion/);
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o111, 0o111);
  assert.equal((await shortcutStatus(opts)).places.start.exists, true);
  await setShortcut("start", false, opts);
  assert.equal((await shortcutStatus(opts)).places.start.exists, false);
  await assert.rejects(setShortcut("startup", true, opts), /unknown place/);
  await assert.rejects(setShortcut("start", true, { platform: "darwin", env: {} }), /aren't supported/);
});

test("windowAppId: Chrome's id for the companion window; none for Edge or no browser", async () => {
  const { windowAppId } = await import("../server/shortcut.mjs");
  assert.equal(windowAppId("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"), "Chrome.127.0.0.1_/.browserprole.Default");
  assert.equal(windowAppId("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"), "");
  assert.equal(windowAppId(undefined), "");
});

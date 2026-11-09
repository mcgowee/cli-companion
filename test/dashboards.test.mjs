import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDashboard, DashboardError, loadDashboards, MAX_START, setDashboardStart, validateDashboard, validateStart } from "../server/dashboards.mjs";

const ABS = process.platform === "win32" ? "C:\\work\\dash" : "/work/dash";

test("validateStart: optional, one line, absolute folder, folder needs a command", () => {
  assert.deepEqual(validateStart({}), {});
  assert.deepEqual(validateStart({ start: "  ", startCwd: "" }), {});
  assert.deepEqual(validateStart({ start: " npm start " }), { start: "npm start" });
  assert.deepEqual(validateStart({ start: "npm start", startCwd: ABS }), { start: "npm start", startCwd: ABS });
  assert.throws(() => validateStart({ start: "a\nb" }), DashboardError);
  assert.throws(() => validateStart({ start: "a\r\nb" }), DashboardError);
  assert.throws(() => validateStart({ start: "x".repeat(MAX_START + 1) }), DashboardError);
  assert.throws(() => validateStart({ start: "npm start", startCwd: "relative/dir" }), DashboardError);
  assert.throws(() => validateStart({ startCwd: ABS }), DashboardError);
});

test("validateDashboard carries the start command along", () => {
  const d = validateDashboard({ name: "GPU", url: "http://127.0.0.1:30142", start: "pwsh -File launch.ps1" });
  assert.equal(d.start, "pwsh -File launch.ps1");
  assert.equal("startCwd" in d, false);
  assert.equal("start" in validateDashboard({ name: "GPU", url: "http://127.0.0.1:30142" }), false);
});

test("start commands are saved, changed, cleared, and survive a reload; other fields stay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-dash-"));
  try {
    const file = join(dir, "dashboards.json");
    const added = await addDashboard(file, { name: "GPU", url: "http://127.0.0.1:30142", description: "d" });
    assert.equal(added.start, undefined);

    const set = await setDashboardStart(file, added.id, { start: "npm start", startCwd: ABS });
    assert.deepEqual({ name: set.name, url: set.url, description: set.description, start: set.start, startCwd: set.startCwd },
      { name: "GPU", url: "http://127.0.0.1:30142/", description: "d", start: "npm start", startCwd: ABS });
    assert.equal((await loadDashboards(file))[0].start, "npm start");

    const cleared = await setDashboardStart(file, added.id, { start: "" });
    assert.equal("start" in cleared, false);
    assert.equal("startCwd" in cleared, false);

    assert.equal(await setDashboardStart(file, "no-such-id", { start: "x" }), null);
    await assert.rejects(setDashboardStart(file, added.id, { start: "a\nb" }), DashboardError);
    assert.equal((await loadDashboards(file)).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a hand-edited file: blank or non-string start fields are dropped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-dash-"));
  try {
    const file = join(dir, "dashboards.json");
    await writeFile(file, JSON.stringify({ dashboards: [
      { id: "a", name: "A", url: "http://127.0.0.1:1/", start: "  " },
      { id: "b", name: "B", url: "http://127.0.0.1:2/", start: 5, startCwd: ["x"] },
      { id: "c", name: "C", url: "http://127.0.0.1:3/", start: "go", startCwd: ABS },
    ] }));
    const [a, b, c] = await loadDashboards(file);
    assert.equal("start" in a, false);
    assert.equal("start" in b || "startCwd" in b, false);
    assert.equal(c.start, "go");
    assert.equal(c.startCwd, ABS);
    assert.ok((await readFile(file, "utf8")).includes('"go"'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

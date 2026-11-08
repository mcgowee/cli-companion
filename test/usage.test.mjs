import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addDashboard, isLoopbackUrl, loadDashboards, removeDashboard, validateDashboard } from "../server/dashboards.mjs";
import { localDay, usageSummary } from "../server/usage.mjs";

const NOW = Date.parse("2026-11-06T18:00:00Z");
const DAY = 86_400_000;

test("localDay uses the viewer's offset", () => {
  assert.equal(localDay(Date.parse("2026-11-07T02:00:00Z"), 0), "2026-11-07");
  assert.equal(localDay(Date.parse("2026-11-07T02:00:00Z"), -8 * 60), "2026-11-06");
});

test("usageSummary counts sessions per day by CLI, active days and workspaces", () => {
  const metas = [
    { source: "pi", cwd: "C:\\work\\pi\\companion", created: new Date(NOW - 1 * 3600_000).toISOString(), mtimeMs: NOW, size: 100 },
    { source: "claude", cwd: "C:\\work\\pi\\companion\\", created: new Date(NOW - 2 * 3600_000).toISOString(), mtimeMs: NOW, size: 50 },
    { source: "pi", cwd: "C:\\work\\myapp", created: new Date(NOW - 3 * DAY).toISOString(), mtimeMs: NOW - 3 * DAY, size: 10 },
    // Started last period, still active this period: counted in its workspace, not as started.
    { source: "claude", cwd: "C:\\work\\pi\\studio", created: new Date(NOW - 9 * DAY).toISOString(), mtimeMs: NOW - DAY, size: 5 },
    // Old: only in the all-time totals.
    { source: "pi", cwd: "C:\\old", created: new Date(NOW - 40 * DAY).toISOString(), mtimeMs: NOW - 40 * DAY, size: 1 },
  ];
  const u = usageSummary(metas, { now: NOW, days: 7, offsetMin: 0 });
  assert.equal(u.daily.length, 7);
  assert.equal(u.today, "2026-11-06");
  assert.deepEqual(u.daily.at(-1), { date: "2026-11-06", pi: 1, claude: 1 });
  assert.equal(u.started, 3);
  assert.equal(u.startedPrevious, 1);
  assert.equal(u.activeDays, 2);
  assert.equal(u.workspacesUsed, 3);
  assert.equal(u.workspaces[0].name, "companion"); // trailing slash folded into the same workspace
  assert.deepEqual([u.workspaces[0].pi, u.workspaces[0].claude], [1, 1]);
  assert.ok(u.workspaces.some((w) => w.name === "studio"));
  assert.ok(!u.workspaces.some((w) => w.name === "old"));
  assert.deepEqual(u.totals, { sessions: 5, pi: 3, claude: 2, bytes: 166, workspaces: 4 });
});

test("dashboards: validate, add, list, remove", async () => {
  assert.throws(() => validateDashboard({ name: "x", url: "file:///c:/x" }), /http/);
  assert.throws(() => validateDashboard({ name: "", url: "http://127.0.0.1:1" }), /name/);
  const file = join(mkdtempSync(join(tmpdir(), "dash-")), "sub", "dashboards.json");
  assert.deepEqual(await loadDashboards(file), []);
  const added = await addDashboard(file, { name: " GPU ", url: "http://127.0.0.1:30142", description: "Ollama" });
  assert.equal(added.name, "GPU");
  assert.equal(added.url, "http://127.0.0.1:30142/");
  assert.equal((await loadDashboards(file)).length, 1);
  assert.equal(await removeDashboard(file, "nope"), false);
  assert.equal(await removeDashboard(file, added.id), true);
  assert.deepEqual(await loadDashboards(file), []);
});

test("isLoopbackUrl only accepts this computer", () => {
  assert.ok(isLoopbackUrl("http://127.0.0.1:30142/"));
  assert.ok(isLoopbackUrl("http://localhost:3000"));
  assert.ok(!isLoopbackUrl("https://example.com"));
  assert.ok(!isLoopbackUrl("not a url"));
});

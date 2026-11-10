import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exchangeText, fileKind, findApps, resolveAppFile, urlName } from "../server/apps.mjs";

test("findApps: local web addresses, in order, without repeats or trailing punctuation", () => {
  const text = `Started the dev server at http://localhost:5173/. Also see **http://127.0.0.1:8080/report?x=1**,
and (http://localhost:5173/) again. Not https://example.com or http://192.168.1.4:3000.`;
  assert.deepEqual(findApps(text).urls, ["http://localhost:5173/", "http://127.0.0.1:8080/report?x=1"]);
});

test("findApps: leaves out the companion's own address", () => {
  const text = "Open http://127.0.0.1:30143/ and http://127.0.0.1:30142/";
  assert.deepEqual(findApps(text, { exclude: ["http://127.0.0.1:30143"] }).urls, ["http://127.0.0.1:30142/"]);
});

test("findApps: .html paths — bare, relative, absolute, in backticks with spaces, file:// URLs", () => {
  const text = [
    "I wrote `out/My Report.html` and viewer/index.html.",
    "Open C:\\work\\myapp\\docs\\chart.html, or file:///C:/work/myapp/a%20b.html.",
    "Same again: viewer/index.html. A stylesheet style.css is not an app.",
  ].join("\n");
  assert.deepEqual(findApps(text).files, [
    "C:/work/myapp/a b.html",
    "out/My Report.html",
    "viewer/index.html",
    "C:\\work\\myapp\\docs\\chart.html",
  ]);
});

test("findApps: images, video, audio, PDFs and text files too; code files are left out", () => {
  const text = "Rendered `C:/work/studio/renders/opening v01.mp4`, out/shot.PNG and song.mp3; notes in notes.md and a.pdf. Edited server.mjs, app.js and package.json.";
  assert.deepEqual(findApps(text).files, ["C:/work/studio/renders/opening v01.mp4", "out/shot.PNG", "song.mp3", "notes.md", "a.pdf"]);
  assert.deepEqual(["x.html", "y.JPEG", "z.webm", "w.wav", "v.pdf", "u.csv", "t.js"].map(fileKind), ["html", "image", "video", "audio", "pdf", "text", undefined]);
});

test("findApps: an .html address on a web server is a URL, not a file", () => {
  const found = findApps("See http://localhost:8000/index.html");
  assert.deepEqual(found.urls, ["http://localhost:8000/index.html"]);
  assert.deepEqual(found.files, []);
});

test("resolveAppFile: only existing files inside the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "apps-"));
  await mkdir(join(root, "viewer"));
  await writeFile(join(root, "viewer", "index.html"), "<h1>hi</h1>");
  assert.equal(await resolveAppFile(root, "viewer/index.html"), "viewer/index.html");
  assert.equal(await resolveAppFile(root, join(root, "viewer", "index.html")), "viewer/index.html");
  assert.equal(await resolveAppFile(root, "viewer/missing.html"), null);
  assert.equal(await resolveAppFile(root, "../outside.html"), null);
  assert.equal(await resolveAppFile(root, join(tmpdir(), "elsewhere.html")), null);
});

test("urlName: host and path", () => {
  assert.equal(urlName("http://localhost:5173/"), "localhost:5173");
  assert.equal(urlName("http://127.0.0.1:8080/report?x=1"), "127.0.0.1:8080/report?x=1");
});

test("exchangeText: a path in your own message is found too, after the reply's", () => {
  const exchange = { id: "m1", reply: "Built it: out/chart.png", ask: "Make it look like C:/work/site/videos/x/riff-preview.html" };
  assert.deepEqual(findApps(exchangeText(exchange)).files, ["out/chart.png", "C:/work/site/videos/x/riff-preview.html"]);
  assert.equal(exchangeText({ reply: "only a reply", ask: "" }), "only a reply");
});

test("findApps: tailnet addresses and your SSH computers count; other hosts don't", () => {
  const text = `Open http://100.72.12.1:8090/?run=fanout_kael_20261110_021759 or http://box.tail1234.ts.net:3000/.
Also http://mini:8080/ and http://192.168.50.227:9000/ and http://100.200.1.1/ and https://example.com/.`;
  assert.deepEqual(findApps(text).urls, ["http://100.72.12.1:8090/?run=fanout_kael_20261110_021759", "http://box.tail1234.ts.net:3000/"]);
  assert.deepEqual(findApps(text, { hosts: ["mini", "192.168.50.227"] }).urls, [
    "http://100.72.12.1:8090/?run=fanout_kael_20261110_021759",
    "http://box.tail1234.ts.net:3000/",
    "http://mini:8080/",
    "http://192.168.50.227:9000/",
  ]);
});

test("findApps: a session on an SSH computer: its localhost links point there", () => {
  const text = "Dashboard at http://localhost:8090/?run=x and http://127.0.0.1:5000";
  assert.deepEqual(findApps(text, { remoteHost: "100.72.12.1" }).urls, ["http://100.72.12.1:8090/?run=x", "http://100.72.12.1:5000/"]);
});

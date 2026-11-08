import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { remoteAllowed } from "../server/remote.mjs";
import { imageType, pruneUploads, saveUpload, uploadName } from "../server/uploads.mjs";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(16)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(8)]);

test("imageType: by the first bytes, not the name", () => {
  assert.equal(imageType(PNG), "png");
  assert.equal(imageType(JPG), "jpg");
  assert.equal(imageType(GIF), "gif");
  assert.equal(imageType(WEBP), "webp");
  assert.equal(imageType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>")), null);
  assert.equal(imageType(Buffer.from("MZ executable.......")), null);
});

test("uploadName: date, time and a cleaned-up hint", () => {
  const now = new Date(2026, 10, 7, 18, 32, 5);
  assert.equal(uploadName("png", { now, hint: "Screen Shot (2).PNG" }), "2026-11-07-183205-screen-shot-2.png");
  assert.equal(uploadName("jpg", { now, hint: "../../etc/passwd" }), "2026-11-07-183205-etc-passwd.jpg");
  assert.equal(uploadName("gif", { now }), "2026-11-07-183205.gif");
});

test("saveUpload: into .cli-companion/images with a .gitignore, never overwriting", async () => {
  const root = mkdtempSync(join(tmpdir(), "companion-upload-"));
  const now = new Date(2026, 10, 7, 18, 32, 5);
  const a = await saveUpload(root, PNG, { hint: "shot.png", now });
  const b = await saveUpload(root, PNG, { hint: "shot.png", now });
  assert.equal(a, ".cli-companion/images/2026-11-07-183205-shot.png");
  assert.equal(b, ".cli-companion/images/2026-11-07-183205-shot-2.png");
  assert.match(readFileSync(join(root, ".cli-companion", "images", ".gitignore"), "utf8"), /^\*$/m);
  await assert.rejects(saveUpload(root, Buffer.from("not an image at all")), /Only PNG, JPEG, GIF and WebP/);
  await assert.rejects(saveUpload(root, Buffer.alloc(0)), /empty/);
});

test("pruneUploads: removes only our own old images", async () => {
  const dir = mkdtempSync(join(tmpdir(), "companion-prune-"));
  const old = Date.now() / 1000 - 40 * 86400;
  for (const name of ["2026-01-01-120000-old.png", "keep-me.png", ".gitignore"]) {
    writeFileSync(join(dir, name), "x");
    utimesSync(join(dir, name), old, old);
  }
  writeFileSync(join(dir, "2026-11-07-120000-new.png"), "x");
  assert.equal(await pruneUploads(dir), 1);
  assert.deepEqual(readdirSync(dir).sort(), [".gitignore", "2026-11-07-120000-new.png", "keep-me.png"]);
});

test("uploads are never allowed from the phone", () => {
  assert.equal(remoteAllowed("POST", "/api/upload", { enabled: true, reply: true }), false);
});

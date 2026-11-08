// Images from the composer (paste, drag, or the image button): saved into the selected session's
// own folder, under .cli-companion/images/, so the CLI there can open them by path without
// asking for permission. The composer then puts that path into your prompt.
//
// Rules:
//   - Images only, checked by their first bytes (PNG, JPEG, GIF, WebP), not by the name or the
//     type the browser claims. At most 20 MB.
//   - The server picks the file name (date, time, and a cleaned-up hint); it never overwrites.
//   - The folder gets a .gitignore of "*", so git ignores the images without touching your
//     project's own .gitignore.
//   - Images there older than 30 days are deleted (only names this module makes).
//   - Page header and access key required; never from the phone (server/remote.mjs).

import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const UPLOAD_DIR = ".cli-companion/images";
export const MAX_UPLOAD = 20 * 1024 * 1024;
const KEEP_DAYS = 30;
const OUR_NAME = /^\d{4}-\d{2}-\d{2}-\d{6}(?:-[a-z0-9-]{1,40})?(?:-\d+)?\.(?:png|jpg|gif|webp)$/;

/** "png" | "jpg" | "gif" | "webp" from the file's first bytes, or null. */
export function imageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG") return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.toString("latin1", 0, 4) === "GIF8") return "gif";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

/** A file name like 2026-11-07-183205-screenshot.png (local time; hint from the original name). */
export function uploadName(ext, { now = new Date(), hint = "" } = {}) {
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const slug = String(hint)
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `${stamp}${slug ? `-${slug}` : ""}.${ext}`;
}

/** Delete our own images older than KEEP_DAYS in `dir`. Quiet on errors. */
export async function pruneUploads(dir, { now = Date.now(), days = KEEP_DAYS } = {}) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names.filter((n) => OUR_NAME.test(n))) {
    try {
      const info = await stat(join(dir, name));
      if (info.isFile() && now - info.mtimeMs > days * 86_400_000) {
        await rm(join(dir, name));
        removed++;
      }
    } catch {
      // gone already, or in use
    }
  }
  return removed;
}

/**
 * Save an image into `root`/.cli-companion/images. Returns the path relative to `root`, with
 * forward slashes (what goes into the prompt). Throws Error with a plain message if it isn't
 * an image or is too big.
 */
export async function saveUpload(root, buf, { hint = "", now = new Date() } = {}) {
  if (!buf?.length) throw new Error("That was empty.");
  if (buf.length > MAX_UPLOAD) throw new Error("Images can be up to 20 MB.");
  const ext = imageType(buf);
  if (!ext) throw new Error("Only PNG, JPEG, GIF and WebP images can be added.");
  const dir = join(root, ...UPLOAD_DIR.split("/"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".gitignore"), "# Images added from CLI Companion's composer; git ignores this folder.\n*\n", { flag: "wx" }).catch(() => {});
  const base = uploadName(ext, { now, hint });
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? base : base.replace(/\.(\w+)$/, `-${n}.$1`);
    try {
      await writeFile(join(dir, name), buf, { flag: "wx" });
      void pruneUploads(dir, { now: now.getTime() });
      return `${UPLOAD_DIR}/${name}`;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error("Couldn't pick a free file name.");
}

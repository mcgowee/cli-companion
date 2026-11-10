// The right panel's Files tab for a Pi session running on an SSH computer (shown here through New
// session's tunnel, server/envs.mjs): the folder is there, so it is listed and read over ssh.
//
// Rules, as for workbench.mjs: read-only; every path is relative to the session's folder, `..`
// is refused, and the remote script checks again after following links (pwd -P / realpath) that
// the target is still inside that folder. Paths reach the remote shell only single-quoted.

import { posix } from "node:path";
import { HIDDEN_NAMES, IMAGE_TYPES, MAX_TEXT_BYTES, WorkbenchError } from "./workbench.mjs";

/** Images bigger than this aren't pulled over ssh. */
export const MAX_REMOTE_IMAGE_BYTES = 16 * 1024 * 1024;

/** A word for the remote shell, single-quoted. */
export function shQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

const BAD_CHARS = /[\0\n\r]/;

/** The session's folder there: an absolute path (as Pi reported it). */
export function checkRemoteRoot(root) {
  const r = String(root ?? "");
  if (!r.startsWith("/") || BAD_CHARS.test(r) || r.split("/").includes("..")) throw new WorkbenchError(404, "workspace folder not found");
  return r;
}

/** A path inside it: relative, no `..`; "" means the folder itself. */
export function checkRemoteRel(rel) {
  const r = String(rel ?? "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (BAD_CHARS.test(r) || /^[a-zA-Z]:/.test(r)) throw new WorkbenchError(400, "path must be relative");
  if (r.split("/").includes("..")) throw new WorkbenchError(403, "path is outside the workspace");
  return r || ".";
}

// Shared start of both scripts: $r = the folder (links followed), or a one-word reason and stop.
function rootLines(root) {
  return `r=$(cd -- ${shQuote(checkRemoteRoot(root))} 2>/dev/null && pwd -P) || { echo NOROOT; exit 0; }`;
}
const INSIDE = `case "$t/" in "$r"/*) ;; *) echo OUTSIDE; exit 0;; esac`;

/** Lists one folder: "OK", then "d<name>\0" / "f<name>\0" per entry (links followed). */
export function remoteListScript(root, rel) {
  return [
    rootLines(root),
    `t=$(cd -- "$r" && cd -- ${shQuote(checkRemoteRel(rel))} 2>/dev/null && pwd -P) || { echo NOTFOUND; exit 0; }`,
    INSIDE,
    `cd -- "$t" && echo OK && find . -mindepth 1 -maxdepth 1 \\( -xtype d -printf 'd%f\\0' \\) -o \\( -xtype f -printf 'f%f\\0' \\) 2>/dev/null`,
  ].join("\n");
}

/** Its output → [{ name, kind }], folders first, then files, by name. */
export function parseRemoteList(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer);
  const nl = text.indexOf("\n");
  const head = (nl < 0 ? text : text.slice(0, nl)).trim();
  failOn(head);
  const rows = [];
  for (const item of text.slice(nl + 1).split("\0")) {
    if (item.length < 2) continue;
    const kind = item[0] === "d" ? "dir" : "file";
    const name = item.slice(1);
    if (HIDDEN_NAMES.has(name)) continue;
    rows.push({ name, kind });
  }
  rows.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.kind === "dir" ? -1 : 1));
  return rows;
}

/** Reads one file: "OK <size>", then its bytes if size ≤ max. */
export function remoteFileScript(root, rel, max) {
  return [
    rootLines(root),
    `t=$(cd -- "$r" && realpath -e -- ${shQuote(checkRemoteRel(rel))} 2>/dev/null) || { echo NOTFOUND; exit 0; }`,
    INSIDE,
    `[ -f "$t" ] || { echo NOTFILE; exit 0; }`,
    `s=$(stat -c %s -- "$t") || { echo NOTFOUND; exit 0; }`,
    `echo "OK $s"`,
    `[ "$s" -le ${Math.floor(max)} ] && head -c ${Math.floor(max)} -- "$t"`,
    `exit 0`,
  ].join("\n");
}

/** The largest file worth pulling for this path: images up to 16 MB, everything else 1 MB. */
export function remoteFileMax(rel) {
  return IMAGE_TYPES[posix.extname(String(rel)).toLowerCase()] ? MAX_REMOTE_IMAGE_BYTES : MAX_TEXT_BYTES;
}

/** Its output → the same view readFileForView gives ({ kind, size, text | mimeType, bytes }). */
export function parseRemoteFile(buffer, rel) {
  const nl = buffer.indexOf(10);
  const head = buffer.subarray(0, nl < 0 ? buffer.length : nl).toString("utf8").trim();
  failOn(head);
  const size = Number(head.split(" ")[1]);
  const body = buffer.subarray(nl + 1);
  const image = IMAGE_TYPES[posix.extname(String(rel)).toLowerCase()];
  if (image) {
    if (size > MAX_REMOTE_IMAGE_BYTES) return { kind: "too-big", size };
    return { kind: "image", mimeType: image, size, bytes: body };
  }
  if (size > MAX_TEXT_BYTES) return { kind: "too-big", size };
  if (body.subarray(0, 8000).includes(0)) return { kind: "binary", size };
  return { kind: "text", size, text: body.toString("utf8") };
}

function failOn(head) {
  if (head === "OK" || head.startsWith("OK ")) return;
  if (head === "NOROOT") throw new WorkbenchError(404, "workspace folder not found");
  if (head === "OUTSIDE") throw new WorkbenchError(403, "path is outside the workspace");
  if (head === "NOTFILE") throw new WorkbenchError(400, "not a file");
  throw new WorkbenchError(404, "not found");
}

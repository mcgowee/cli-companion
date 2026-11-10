// Right-panel tools: read-only file browsing and git review for a workspace.
//
// Every path is resolved inside a workspace root the server already knows
// (a cwd of a Pi session), and checked again after following symlinks, so a
// request can never read outside that folder. Nothing here writes anything.

import { execFile } from "node:child_process";
import { mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
export const IMAGE_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
};
export const HIDDEN_NAMES = new Set([".git"]);

export class WorkbenchError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function samePath(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInside(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve `relPath` inside `root`. Rejects absolute paths, `..` escapes, and symlinks that
 * lead outside the root. Returns the real absolute path.
 */
export async function resolveInside(root, relPath = "") {
  const cleaned = String(relPath ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) throw new WorkbenchError(400, "path must be relative");
  const realRoot = await realpath(root).catch(() => {
    throw new WorkbenchError(404, "workspace folder not found");
  });
  const target = resolve(realRoot, cleaned);
  if (!isInside(realRoot, target)) throw new WorkbenchError(403, "path is outside the workspace");
  const realTarget = await realpath(target).catch(() => {
    throw new WorkbenchError(404, "not found");
  });
  if (!isInside(realRoot, realTarget)) throw new WorkbenchError(403, "path is outside the workspace");
  return realTarget;
}

const RESERVED_WIN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** A new folder's name: one path part, no characters Windows/macOS/Linux refuse. Throws WorkbenchError(400). */
export function checkFolderName(input) {
  const name = String(input ?? "").trim();
  if (!name) throw new WorkbenchError(400, "Give the folder a name.");
  if (name.length > 120) throw new WorkbenchError(400, "That name is too long (120 characters at most).");
  if (name === "." || name === "..") throw new WorkbenchError(400, "That name isn't allowed.");
  // eslint-disable-next-line no-control-regex
  if (/[\\/:*?"<>|\x00-\x1f]/.test(name)) throw new WorkbenchError(400, 'A folder name can\'t contain \\ / : * ? " < > |');
  if (/[. ]$/.test(name)) throw new WorkbenchError(400, "A folder name can't end with a dot or a space.");
  if (RESERVED_WIN.test(name)) throw new WorkbenchError(400, "Windows reserves that name.");
  return name;
}

/**
 * Create folder `name` inside `parentRel` (relative to the workspace `root`). Never overwrites:
 * a file or folder already there is a 409. Returns the new folder's path relative to the root.
 */
export async function makeFolder(root, parentRel, name) {
  const clean = checkFolderName(name);
  const parent = await resolveInside(root, parentRel);
  if (!(await stat(parent)).isDirectory()) throw new WorkbenchError(400, "That isn't a folder.");
  try {
    await mkdir(join(parent, clean));
  } catch (error) {
    if (error.code === "EEXIST") throw new WorkbenchError(409, `"${clean}" already exists there.`);
    if (error.code === "EACCES" || error.code === "EPERM") throw new WorkbenchError(403, "No permission to create a folder there.");
    throw error;
  }
  const realRoot = await resolveInside(root, "");
  return relative(realRoot, join(parent, clean)).split(sep).join("/");
}

/** Immediate children of a folder: folders first, then files, by name. */
export async function listDir(root, relPath) {
  const dir = await resolveInside(root, relPath);
  const entries = await readdir(dir, { withFileTypes: true });
  const rows = [];
  for (const entry of entries) {
    if (HIDDEN_NAMES.has(entry.name)) continue;
    let kind = entry.isDirectory() ? "dir" : entry.isFile() ? "file" : undefined;
    if (entry.isSymbolicLink()) {
      try {
        const s = await stat(join(dir, entry.name));
        kind = s.isDirectory() ? "dir" : "file";
      } catch {
        continue;
      }
    }
    if (!kind) continue;
    rows.push({ name: entry.name, kind });
  }
  rows.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.kind === "dir" ? -1 : 1));
  return rows;
}

/** A file for the viewer: text (up to 1 MB), an image, or a note that it is binary or too big. */
export async function readFileForView(root, relPath) {
  const file = await resolveInside(root, relPath);
  const s = await stat(file);
  if (!s.isFile()) throw new WorkbenchError(400, "not a file");
  const image = IMAGE_TYPES[extname(file).toLowerCase()];
  if (image) return { kind: "image", mimeType: image, size: s.size, file };
  if (s.size > MAX_TEXT_BYTES) return { kind: "too-big", size: s.size };
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(s.size);
    await handle.read(buffer, 0, s.size, 0);
    if (buffer.subarray(0, 8000).includes(0)) return { kind: "binary", size: s.size };
    return { kind: "text", size: s.size, text: buffer.toString("utf8") };
  } finally {
    await handle.close();
  }
}

function git(root, args, { allowExit1 = false } = {}) {
  return new Promise((resolveGit, reject) => {
    execFile(
      "git",
      ["-C", root, "-c", "core.quotepath=off", "--no-pager", ...args],
      { timeout: 15_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && !(allowExit1 && error.code === 1)) {
          if (error.code === "ENOENT") {
            reject(new WorkbenchError(501, "Git isn't installed (or isn't on your PATH), so changes can't be shown. Install it from git-scm.com."));
            return;
          }
          reject(new WorkbenchError(500, (stderr || error.message).trim().split("\n")[0]));
          return;
        }
        resolveGit(stdout);
      },
    );
  });
}

/** Parse `git diff --name-status -z` output. */
export function parseNameStatus(text) {
  const parts = text.split("\0").filter((p) => p !== "");
  const files = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++];
    const status = code[0];
    if (status === "R" || status === "C") {
      const from = parts[i++];
      const to = parts[i++];
      files.push({ status, path: to, from });
    } else {
      files.push({ status, path: parts[i++] });
    }
  }
  return files;
}

/** Parse `git diff --numstat -z` output into path -> { added, removed }. */
export function parseNumstat(text) {
  const counts = new Map();
  const parts = text.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const m = parts[i].match(/^(-|\d+)\t(-|\d+)\t(.*)$/);
    if (!m) continue;
    let path = m[3];
    if (path === "") {
      // Rename: the next two fields are the old and new path.
      i += 2;
      path = parts[i];
    }
    counts.set(path, { added: m[1] === "-" ? null : Number(m[1]), removed: m[2] === "-" ? null : Number(m[2]) });
  }
  return counts;
}

/** `git status --porcelain=v2 --branch -z` → branch, ahead/behind, changed and untracked file counts. */
export function parseStatusV2(text) {
  const out = { branch: undefined, ahead: 0, behind: 0, changed: 0, untracked: 0 };
  const parts = text.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.startsWith("# branch.head ")) out.branch = p.slice(14);
    else if (p.startsWith("# branch.ab ")) {
      const m = p.match(/\+(\d+) -(\d+)/);
      if (m) [out.ahead, out.behind] = [Number(m[1]), Number(m[2])];
    } else if (p.startsWith("1 ") || p.startsWith("u ")) out.changed += 1;
    else if (p.startsWith("2 ")) {
      out.changed += 1;
      i += 1; // a rename is followed by its old path
    } else if (p.startsWith("? ")) out.untracked += 1;
  }
  if (out.branch === "(detached)") out.branch = "detached";
  return out;
}

/**
 * A one-line git summary of a workspace for the sidebar: branch, ahead/behind its upstream, and
 * uncommitted changes (+added −removed lines in tracked files, plus untracked files).
 * undefined when the folder isn't in a git repository.
 */
export async function gitSummary(root) {
  const inside = await git(root, ["rev-parse", "--is-inside-work-tree"]).catch(() => "");
  if (inside.trim() !== "true") return undefined;
  const status = parseStatusV2(await git(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"]));
  let added = 0;
  let removed = 0;
  const hasHead = await git(root, ["rev-parse", "--verify", "HEAD"]).then(() => true, () => false);
  if (hasHead) {
    for (const c of parseNumstat(await git(root, ["diff", "--numstat", "-z", "-M", "HEAD"])).values()) {
      added += c.added ?? 0;
      removed += c.removed ?? 0;
    }
  }
  return { ...status, added, removed };
}

async function gitInfo(root) {
  const inside = await git(root, ["rev-parse", "--is-inside-work-tree"]).catch(() => "");
  if (inside.trim() !== "true") return undefined;
  const top = (await git(root, ["rev-parse", "--show-toplevel"])).trim();
  const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "HEAD")).trim();
  const hasHead = await git(root, ["rev-parse", "--verify", "HEAD"]).then(() => true, () => false);
  return { top, branch, hasHead };
}

async function baseRef(root) {
  const candidates = [];
  const originHead = await git(root, ["rev-parse", "--abbrev-ref", "origin/HEAD"]).catch(() => "");
  if (originHead.trim() && originHead.trim() !== "origin/HEAD") candidates.push(originHead.trim());
  candidates.push("origin/main", "origin/master", "main", "master");
  for (const ref of candidates) {
    const ok = await git(root, ["rev-parse", "--verify", "--quiet", ref]).then(() => true, () => false);
    if (ok) return ref;
  }
  return undefined;
}

/**
 * Changed files for a scope: "uncommitted" (working tree + staged vs HEAD, plus untracked)
 * or "branch" (everything since the merge-base with the base branch, uncommitted included).
 */
export async function reviewStatus(root, scope = "uncommitted") {
  const info = await gitInfo(root);
  if (!info) return { git: false };
  let against = info.hasHead ? "HEAD" : undefined;
  let base;
  if (scope === "branch") {
    base = await baseRef(root);
    if (!base) return { git: true, branch: info.branch, scope, files: [], note: "No main/master branch to compare with." };
    against = (await git(root, ["merge-base", "HEAD", base])).trim();
  }
  const files = [];
  if (against) {
    const nameStatus = parseNameStatus(await git(root, ["diff", "--name-status", "-z", "-M", against]));
    const counts = parseNumstat(await git(root, ["diff", "--numstat", "-z", "-M", against]));
    for (const f of nameStatus) files.push({ ...f, ...(counts.get(f.path) ?? {}) });
  }
  const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  for (const path of untracked) files.push({ status: "?", path });
  files.sort((a, b) => a.path.localeCompare(b.path));
  // Paths from git are relative to the repository top; the panel works relative to the workspace.
  const prefix = relative(info.top, root).replace(/\\/g, "/");
  return { git: true, branch: info.branch, base, scope, prefix, files };
}

/** Unified diff text for one file in a scope (untracked files are shown as all added). */
export async function reviewDiff(root, scope, repoPath) {
  const info = await gitInfo(root);
  if (!info) throw new WorkbenchError(400, "not a git repository");
  const file = resolve(info.top, String(repoPath ?? ""));
  if (!isInside(info.top, file)) throw new WorkbenchError(403, "path is outside the repository");
  let against = info.hasHead ? "HEAD" : undefined;
  if (scope === "branch") {
    const base = await baseRef(root);
    if (base) against = (await git(root, ["merge-base", "HEAD", base])).trim();
  }
  const tracked = await git(root, ["ls-files", "--error-unmatch", "--", file]).then(() => true, () => false);
  let text = "";
  if (tracked && against) {
    text = await git(root, ["diff", "-M", against, "--", file]);
  } else {
    // Untracked (or no commits yet): show the whole file as added.
    const view = await readFileForView(info.top, relative(info.top, file)).catch(() => undefined);
    if (view?.kind === "text") {
      const lines = view.text.replace(/\n$/, "").split("\n");
      text = `--- /dev/null\n+++ b/${repoPath}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`;
    } else {
      text = view ? `Binary or large file (${view.kind}).` : "File not found.";
    }
  }
  if (text.length > MAX_DIFF_BYTES) text = `${text.slice(0, MAX_DIFF_BYTES)}\n… diff cut short (over 2 MB)`;
  return { text };
}

export { samePath };

// Small file and process helpers shared by the server and the CLI sources.

import { open, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";

/** Is `file` inside `dir`? (Case-insensitive on Windows.) */
export function isUnderDir(dir, file) {
  if (typeof file !== "string" || !dir) return false;
  const absolute = resolve(file);
  const root = dir.endsWith(sep) ? dir : dir + sep;
  return process.platform === "win32" ? absolute.toLowerCase().startsWith(root.toLowerCase()) : absolute.startsWith(root);
}

/** Is a process alive? Unknown pids count as alive. */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * A reader for JSONL files that only grow (appended transcripts, possibly hundreds of MB): the
 * first read parses the whole file, later reads only the bytes added since. A StringDecoder keeps
 * multi-byte characters split across reads intact; a file that shrank is read again from the
 * start. Keeps the last `keep` files. `parseLines(text)` turns complete lines into entries.
 */
export function appendingJsonlReader(parseLines, keep = 3) {
  const cache = new Map();
  return async function read(file) {
    try {
      const stats = await stat(file);
      let c = cache.get(file);
      if (c && c.size === stats.size && c.mtimeMs === stats.mtimeMs) return c.entries;
      if (!c || stats.size < c.offset) c = { offset: 0, carry: "", entries: [], decoder: new StringDecoder("utf8") };
      const handle = await open(file, "r");
      try {
        const CHUNK = 8 * 1024 * 1024;
        const buffer = Buffer.alloc(CHUNK);
        while (c.offset < stats.size) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK, stats.size - c.offset), c.offset);
          if (!bytesRead) break;
          c.offset += bytesRead;
          const text = c.carry + c.decoder.write(buffer.subarray(0, bytesRead));
          const cut = text.lastIndexOf("\n");
          c.carry = cut < 0 ? text : text.slice(cut + 1);
          if (cut >= 0) for (const entry of parseLines(text.slice(0, cut))) c.entries.push(entry);
        }
      } finally {
        await handle.close();
      }
      c.size = stats.size;
      c.mtimeMs = stats.mtimeMs;
      cache.delete(file);
      cache.set(file, c);
      while (cache.size > keep) cache.delete(cache.keys().next().value);
      return c.entries;
    } catch {
      return undefined;
    }
  };
}

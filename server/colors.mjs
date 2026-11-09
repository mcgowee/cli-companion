// A colour per session for the sidebar (to match, say, the tab colour you gave its terminal):
// ~/.cli-companion/session-colors.json ({ "colors": { "<session id>": "#rrggbb" } }).
// Only ids and colours are stored, never session content. Colours are strict #rrggbb so the
// page can put them straight into a style attribute.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { checkFavoriteId, FavoriteError } from "./favorites.mjs";

export class ColorError extends Error {}

const MAX = 500;
const HEX = /^#[0-9a-f]{6}$/;

/** "#ABC123" → "#abc123"; "" or null → "" (clear); anything else throws. */
export function checkColor(color) {
  const c = String(color ?? "").trim().toLowerCase();
  if (c && !HEX.test(c)) throw new ColorError("A colour is #rrggbb.");
  return c;
}

export async function loadColors(file) {
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    const out = {};
    for (const [id, c] of Object.entries(data?.colors ?? {})) {
      if (/^[\w.:-]{1,200}$/.test(id) && typeof c === "string" && HEX.test(c.toLowerCase())) out[id] = c.toLowerCase();
    }
    return out;
  } catch {
    return {};
  }
}

/** Set (or with "" clear) one session's colour. Returns the whole map. */
export async function setColor(file, id, color) {
  try {
    checkFavoriteId(id);
  } catch (error) {
    if (error instanceof FavoriteError) throw new ColorError(error.message);
    throw error;
  }
  const c = checkColor(color);
  const colors = await loadColors(file);
  if (c) colors[id] = c;
  else delete colors[id];
  if (Object.keys(colors).length > MAX) throw new ColorError(`At most ${MAX} coloured sessions.`);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ colors }, null, 2)}\n`);
  await rename(tmp, file);
  return colors;
}

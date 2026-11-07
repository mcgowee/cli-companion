// Favorite sessions for the sidebar's Favorites section: a list of session ids kept in
// ~/.cli-companion/favorites.json ({ "favorites": ["<id>", ...] }, most recently added first).
// Only ids are stored, never session content.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class FavoriteError extends Error {}

const MAX = 200;
const ID = /^[\w.:-]{1,200}$/;

export function checkFavoriteId(id) {
  if (typeof id !== "string" || !ID.test(id)) throw new FavoriteError("That isn't a session id.");
  return id;
}

export async function loadFavorites(file) {
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    const list = Array.isArray(data?.favorites) ? data.favorites : [];
    return [...new Set(list.filter((id) => typeof id === "string" && ID.test(id)))].slice(0, MAX);
  } catch {
    return [];
  }
}

async function save(file, favorites) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ favorites }, null, 2)}\n`);
  await rename(tmp, file);
}

/** Add `id` at the top (moving it there if it was already a favorite). Returns the new list. */
export async function addFavorite(file, id) {
  checkFavoriteId(id);
  const list = (await loadFavorites(file)).filter((other) => other !== id);
  list.unshift(id);
  if (list.length > MAX) throw new FavoriteError(`At most ${MAX} favorites.`);
  await save(file, list);
  return list;
}

/** Remove `id`. Returns the new list. */
export async function removeFavorite(file, id) {
  checkFavoriteId(id);
  const list = await loadFavorites(file);
  const kept = list.filter((other) => other !== id);
  if (kept.length !== list.length) await save(file, kept);
  return kept;
}

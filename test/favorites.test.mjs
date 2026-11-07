import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addFavorite, FavoriteError, loadFavorites, removeFavorite } from "../server/favorites.mjs";

test("favorites: add puts it on top, remove drops it, the file survives", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fav-"));
  const file = join(dir, "favorites.json");
  try {
    assert.deepEqual(await loadFavorites(file), []);
    await addFavorite(file, "claude:c3b8dfaf-3d87-4732-8488-b5695e3b23d1");
    await addFavorite(file, "01a1b3c9-f58b-76d1");
    assert.deepEqual(await addFavorite(file, "claude:c3b8dfaf-3d87-4732-8488-b5695e3b23d1"), [
      "claude:c3b8dfaf-3d87-4732-8488-b5695e3b23d1",
      "01a1b3c9-f58b-76d1",
    ]);
    assert.deepEqual(await removeFavorite(file, "01a1b3c9-f58b-76d1"), ["claude:c3b8dfaf-3d87-4732-8488-b5695e3b23d1"]);
    assert.deepEqual(await removeFavorite(file, "not-there"), ["claude:c3b8dfaf-3d87-4732-8488-b5695e3b23d1"]);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { favorites: ["claude:c3b8dfaf-3d87-4732-8488-b5695e3b23d1"] });
    await assert.rejects(addFavorite(file, "../etc/passwd"), FavoriteError);
    await assert.rejects(addFavorite(file, 42), FavoriteError);
    // A hand-edited file with junk and repeats is cleaned up on read.
    await writeFile(file, JSON.stringify({ favorites: ["a", "a", 7, "b c", "codex:x"] }));
    assert.deepEqual(await loadFavorites(file), ["a", "codex:x"]);
    await writeFile(file, "not json");
    assert.deepEqual(await loadFavorites(file), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkColor, ColorError, loadColors, setColor } from "../server/colors.mjs";

test("checkColor: #rrggbb only, lower-cased; blank clears", () => {
  assert.equal(checkColor("#AB12cd"), "#ab12cd");
  assert.equal(checkColor(""), "");
  assert.equal(checkColor(null), "");
  for (const bad of ["red", "#abc", "#abcdefg", "#12345g", "url(x)", "#123456;color:red"]) {
    assert.throws(() => checkColor(bad), ColorError, bad);
  }
});

test("colours are set, changed, cleared and survive a reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-col-"));
  try {
    const file = join(dir, "session-colors.json");
    assert.deepEqual(await loadColors(file), {});
    assert.deepEqual(await setColor(file, "abc-1", "#FF0000"), { "abc-1": "#ff0000" });
    await setColor(file, "def:2", "#00ff00");
    await setColor(file, "abc-1", "#0000ff");
    assert.deepEqual(await loadColors(file), { "abc-1": "#0000ff", "def:2": "#00ff00" });
    assert.deepEqual(await setColor(file, "abc-1", ""), { "def:2": "#00ff00" });
    await assert.rejects(setColor(file, "../x", "#000000"), ColorError);
    await assert.rejects(setColor(file, "abc", "blue"), ColorError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a hand-edited file: bad ids and colours are dropped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-col-"));
  try {
    const file = join(dir, "session-colors.json");
    await writeFile(file, JSON.stringify({ colors: { ok: "#ABCDEF", "bad id": "#000000", x: "red", y: 5 } }));
    assert.deepEqual(await loadColors(file), { ok: "#abcdef" });
    await writeFile(file, "not json");
    assert.deepEqual(await loadColors(file), {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

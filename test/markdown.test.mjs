import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.window = globalThis.window ?? {};
await import("../public/markdown.js");
const md = (text) => globalThis.window.renderMarkdown(text);

test("markdown: [text](local path) becomes a file link for the side panel", () => {
  assert.match(md("[Play the demo](C:/work/studio/videos/x/riff-preview.html)"), /<a href="#" class="file-link" data-file-path="C:\/work\/studio\/videos\/x\/riff-preview\.html"[^>]*>Play the demo<\/a>/);
  assert.match(md("[shot](./out/a.png)"), /data-file-path="\.\/out\/a\.png"/);
  assert.match(md("[notes](notes.md)"), /data-file-path="notes\.md"/);
  assert.match(md("[spaced](<C:/a b/c.html>)"), /data-file-path="C:\/a b\/c\.html"/);
});

test("markdown: web links stay web links; other schemes stay text; quotes stay escaped", () => {
  assert.match(md("[w](https://example.com)"), /<a href="https:\/\/example\.com" target="_blank"/);
  assert.doesNotMatch(md("[bad](javascript:alert(1))"), /<a /);
  assert.doesNotMatch(md("[m](mailto:a@b.c)"), /<a /);
  assert.match(md('[e](src/"x.html)'), /data-file-path="src\/&quot;x\.html"/);
});

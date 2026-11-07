import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanSuggestions, isCloudModel, lastExchange, localModels, ollamaUrl, SuggestError, suggestionCache, suggestReplies } from "../server/suggest.mjs";

const items = [
  { id: "u1", kind: "user", text: "fix the menu" },
  { id: "a1", kind: "assistant", text: "Looking.", toolCalls: [{}] },
  { id: "a2", kind: "assistant", text: "" },
  { id: "a3", kind: "assistant", text: "Fixed. Push it to GitHub?" },
];

test("lastExchange: the CLI's last text after the user's last message", () => {
  assert.deepEqual(lastExchange(items), { id: "a3", reply: "Fixed. Push it to GitHub?", ask: "fix the menu" });
  // Still working: the user's message is last.
  assert.equal(lastExchange([...items, { id: "u2", kind: "user", text: "yes" }]), null);
  assert.equal(lastExchange([...items, { id: "u2", kind: "user", text: "yes" }, { id: "a4", kind: "assistant", text: "" }]), null);
  assert.equal(lastExchange([]), null);
  assert.equal(lastExchange(undefined), null);
});

test("cleanSuggestions: strings, trimmed, numbering and quotes removed, no repeats, at most four", () => {
  assert.deepEqual(cleanSuggestions({ replies: ["1. Yes, push it", '"Not yet"', "yes, push it", 7, "", "- Show the diff", "A) Option A", "extra"] }), [
    "Yes, push it",
    "Not yet",
    "Show the diff",
    "Option A",
  ]);
  assert.deepEqual(cleanSuggestions({}), []);
});

test("only local Ollama and local models", () => {
  assert.equal(ollamaUrl({}), "http://127.0.0.1:11434");
  assert.equal(ollamaUrl({ OLLAMA_HOST: "0.0.0.0" }), "http://127.0.0.1:11434");
  assert.equal(ollamaUrl({ OLLAMA_HOST: "127.0.0.1:11500" }), "http://127.0.0.1:11500");
  assert.equal(ollamaUrl({ OLLAMA_HOST: "http://100.72.12.1:11434" }), "http://127.0.0.1:11434");
  assert.ok(isCloudModel("glm-5.3:cloud") && isCloudModel("gemma4:31b-cloud") && isCloudModel({ name: "x", remote_host: "https://ollama.com" }));
  assert.ok(!isCloudModel("qwen3.8:27b") && !isCloudModel("cloudy:7b"));
});

test("localModels drops cloud and embedding models, smallest first", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      models: [
        { name: "qwen3.8:27b", size: 17e9, details: { parameter_size: "27B" } },
        { name: "glm-5.3:cloud", size: 300 },
        { name: "qwen3-embedding:latest", size: 1e9 },
        { name: "glm-ocr:latest", size: 2e9 },
        { name: "tev1:4b", size: 3e9 },
      ],
    }),
  });
  assert.deepEqual((await localModels("http://127.0.0.1:11434", { fetchImpl })).map((m) => m.name), ["tev1:4b", "qwen3.8:27b"]);
  await assert.rejects(localModels("http://127.0.0.1:1", { fetchImpl: async () => { throw new TypeError("fetch failed"); } }), SuggestError);
});

test("suggestReplies sends the exchange to local Ollama with a JSON format and reads the answer", async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ message: { content: JSON.stringify({ replies: ["Yes, push it", "Not yet"] }) } }) };
  };
  const exchange = lastExchange(items);
  assert.deepEqual(await suggestReplies({ baseUrl: "http://127.0.0.1:11434", model: "tev1:4b", exchange, fetchImpl }), ["Yes, push it", "Not yet"]);
  assert.equal(sent.url, "http://127.0.0.1:11434/api/chat");
  assert.equal(sent.body.model, "tev1:4b");
  assert.equal(sent.body.stream, false);
  assert.ok(sent.body.format?.properties?.replies);
  assert.match(sent.body.messages[1].content, /fix the menu[\s\S]*Push it to GitHub\?/);
  await assert.rejects(suggestReplies({ baseUrl: "http://100.72.12.1:11434", model: "tev1:4b", exchange, fetchImpl }), SuggestError);
  await assert.rejects(suggestReplies({ baseUrl: "http://127.0.0.1:11434", model: "glm-5.3:cloud", exchange, fetchImpl }), SuggestError);
  const garbled = async () => ({ ok: true, json: async () => ({ message: { content: "sure! here you go" } }) });
  await assert.rejects(suggestReplies({ baseUrl: "http://127.0.0.1:11434", model: "tev1:4b", exchange, fetchImpl: garbled }), SuggestError);
});

test("suggestionCache shares one request per key and forgets failures", async () => {
  const cache = suggestionCache();
  let calls = 0;
  const make = async () => ++calls;
  assert.equal(await cache.get("a", make), 1);
  assert.equal(await cache.get("a", make), 1);
  await assert.rejects(cache.get("b", async () => { throw new Error("down"); }));
  assert.equal(await cache.get("b", make), 2);
});

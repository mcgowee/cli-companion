import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyRequest, loadRemote, remoteAllowed, REMOTE_DEFAULTS, saveRemote, selfFromStatus, serveTarget } from "../server/remote.mjs";

const port = 30143;
const on = { enabled: true, reply: false, host: "lenovo.tail1.ts.net", login: "me@example.com" };
const viaServe = (extra = {}) => ({ host: "lenovo.tail1.ts.net", headers: { "x-forwarded-for": "100.1.2.3", "tailscale-user-login": "me@example.com", ...extra } });

test("classifyRequest: this computer by its loopback name", () => {
  assert.deepEqual(classifyRequest({ host: "127.0.0.1:30143", headers: {} }, { port }), { ok: true, remote: false });
  assert.deepEqual(classifyRequest({ host: "localhost:30143", headers: {} }, { port }), { ok: true, remote: false });
  assert.equal(classifyRequest({ host: "evil.example:30143", headers: {} }, { port }).status, 421);
  assert.equal(classifyRequest({ host: "127.0.0.1:9999", headers: {} }, { port }).ok, false);
});

test("classifyRequest: phone requests are refused while phone access is off", () => {
  assert.equal(classifyRequest(viaServe(), { port }).ok, false);
  assert.equal(classifyRequest(viaServe(), { port, remote: { ...on, enabled: false } }).ok, false);
  // Forwarded through serve to the loopback name: still treated as remote, so still refused.
  assert.equal(classifyRequest({ host: "127.0.0.1:30143", headers: { "x-forwarded-for": "100.1.2.3" } }, { port }).ok, false);
});

test("classifyRequest: with phone access on, only the owner's account at this machine's name", () => {
  assert.deepEqual(classifyRequest(viaServe(), { port, remote: on }), { ok: true, remote: true, login: "me@example.com" });
  assert.equal(classifyRequest({ ...viaServe(), host: "LENOVO.tail1.ts.net:443" }, { port, remote: on }).ok, true);
  assert.equal(classifyRequest(viaServe({ "tailscale-user-login": "someone@else.com" }), { port, remote: on }).status, 403);
  assert.equal(classifyRequest(viaServe({ "tailscale-user-login": "" }), { port, remote: on }).status, 403);
  assert.equal(classifyRequest({ ...viaServe(), host: "other.tail1.ts.net" }, { port, remote: on }).status, 421);
});

test("remoteAllowed: read anything; send only with replies on; never bridge or other writes", () => {
  assert.equal(remoteAllowed("GET", "/api/history", on), true);
  assert.equal(remoteAllowed("GET", "/events", on), true);
  assert.equal(remoteAllowed("POST", "/api/send", on), false);
  assert.equal(remoteAllowed("POST", "/api/send", { ...on, reply: true }), true);
  for (const path of ["/api/launch", "/api/handoff", "/api/settings", "/api/shortcut", "/api/server", "/api/remote", "/api/favorites", "/api/folder", "/api/dashboards"]) {
    assert.equal(remoteAllowed("POST", path, { ...on, reply: true }), false, path);
  }
  assert.equal(remoteAllowed("DELETE", "/api/favorites", on), false);
  assert.equal(remoteAllowed("GET", "/bridge/inbox", on), false);
  assert.equal(remoteAllowed("POST", "/ingest", on), false);
});

test("loadRemote / saveRemote: defaults when missing, booleans and strings only", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "remote-")), "remote.json");
  assert.deepEqual(await loadRemote(file), REMOTE_DEFAULTS);
  await saveRemote(file, { enabled: true, reply: "yes", host: "h", login: "l" });
  assert.deepEqual(await loadRemote(file), { enabled: true, reply: false, host: "h", login: "l" });
});

test("selfFromStatus and serveTarget read tailscale's JSON", () => {
  const status = { BackendState: "Running", Self: { DNSName: "lenovo.tail1.ts.net.", UserID: 42, Online: true }, User: { 42: { LoginName: "me@example.com" } } };
  assert.deepEqual(selfFromStatus(status), { host: "lenovo.tail1.ts.net", login: "me@example.com", online: true, running: true });
  assert.equal(selfFromStatus({}), null);
  const serve = { Web: { "lenovo.tail1.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:30143" } } } } };
  assert.equal(serveTarget(serve, "lenovo.tail1.ts.net"), "http://127.0.0.1:30143");
  assert.equal(serveTarget({}, "lenovo.tail1.ts.net"), "");
});

// Pi companion server: a live, read-only view of running Pi CLI sessions.
//
// - The bridge extension (~/.pi/agent/extensions/companion.ts) POSTs event
//   batches to /ingest. Pi stays the source of truth; this only mirrors it.
// - The page subscribes to /events (Server-Sent Events) and fetches history
//   from the session JSONL through /api/history.
//
// Rules: bind 127.0.0.1 only, Node built-ins only,
// never touch Pi's files except to read them.

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { findImage, parseEntries, transcriptItems } from "./session-file.mjs";
import { groupByWorkspace, scanSessions } from "./session-index.mjs";
import { listDir, readFileForView, reviewDiff, reviewStatus, WorkbenchError } from "./workbench.mjs";

const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.PI_COMPANION_PORT ?? "30143", 10);
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const SESSIONS_DIR = resolve(AGENT_DIR, "sessions");
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const MAX_BODY = 4 * 1024 * 1024;

/** Live sessions keyed by Pi session id. */
const sessions = new Map();
/** Open SSE responses. */
const clients = new Set();

function now() {
  return Date.now();
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function isUnderSessionsDir(file) {
  if (typeof file !== "string") return false;
  const absolute = resolve(file);
  const root = SESSIONS_DIR.endsWith(sep) ? SESSIONS_DIR : SESSIONS_DIR + sep;
  return process.platform === "win32"
    ? absolute.toLowerCase().startsWith(root.toLowerCase())
    : absolute.startsWith(root);
}

function newSession(id) {
  return {
    id,
    pid: undefined,
    sessionFile: undefined,
    cwd: undefined,
    name: undefined,
    model: undefined,
    leafId: undefined,
    context: undefined,
    status: "idle",
    compaction: undefined,
    lastCompaction: undefined,
    stream: undefined,
    tools: {},
    turnStartedAt: undefined,
    historyVersion: 0,
    lastEventAt: now(),
    ended: false,
  };
}

/** Apply one batch from the bridge extension. Returns true when history changed on disk. */
function applyBatch(batch) {
  const id = typeof batch.sessionId === "string" ? batch.sessionId : undefined;
  if (!id) return false;
  let session = sessions.get(id);
  if (!session) {
    session = newSession(id);
    sessions.set(id, session);
  }
  session.pid = Number.isInteger(batch.pid) ? batch.pid : session.pid;
  if (isUnderSessionsDir(batch.sessionFile)) session.sessionFile = batch.sessionFile;
  if (typeof batch.cwd === "string") session.cwd = batch.cwd;
  if (typeof batch.name === "string") session.name = batch.name;
  if (typeof batch.model === "string") session.model = batch.model;
  if (typeof batch.leafId === "string") session.leafId = batch.leafId;
  if (typeof batch.mode === "string") session.mode = batch.mode;
  if (batch.context && typeof batch.context === "object") session.context = batch.context;
  session.lastEventAt = now();
  session.ended = false;

  let persisted = false;
  for (const event of Array.isArray(batch.events) ? batch.events : []) {
    switch (event?.type) {
      case "hello":
      case "session_start":
        persisted = true;
        break;
      case "agent_start":
        session.status = "running";
        session.turnStartedAt = event.at ?? now();
        break;
      case "agent_settled":
        session.status = session.compaction ? "compacting" : "idle";
        session.stream = undefined;
        session.tools = {};
        session.turnStartedAt = undefined;
        persisted = true;
        break;
      case "stream":
        session.stream = { text: event.text ?? "", thinking: event.thinking ?? "" };
        break;
      case "message_end":
        session.stream = undefined;
        persisted = true;
        break;
      case "turn_end":
        persisted = true;
        break;
      case "tool_start":
        session.tools[event.toolCallId] = {
          name: event.toolName,
          args: event.args ?? "",
          partial: "",
          startedAt: event.at ?? now(),
        };
        break;
      case "tool_update":
        if (session.tools[event.toolCallId]) session.tools[event.toolCallId].partial = event.partial ?? "";
        break;
      case "tool_end":
        delete session.tools[event.toolCallId];
        break;
      case "compaction_start":
        session.compaction = { reason: event.reason, startedAt: event.at ?? now(), tokens: event.tokens };
        session.status = "compacting";
        break;
      case "compaction_end":
        session.lastCompaction = {
          ok: true,
          reason: event.reason,
          tokensBefore: event.tokensBefore,
          startedAt: session.compaction?.startedAt,
          endedAt: event.at ?? now(),
        };
        session.compaction = undefined;
        session.status = session.status === "compacting" ? "idle" : session.status;
        persisted = true;
        break;
      case "compaction_failed":
        session.lastCompaction = {
          ok: false,
          reason: event.reason,
          aborted: Boolean(event.aborted),
          errorMessage: event.errorMessage,
          startedAt: session.compaction?.startedAt,
          endedAt: event.at ?? now(),
        };
        session.compaction = undefined;
        session.status = session.status === "compacting" ? "idle" : session.status;
        break;
      case "shutdown":
        session.ended = true;
        session.status = "ended";
        session.stream = undefined;
        session.tools = {};
        session.compaction = undefined;
        break;
      default:
        break;
    }
  }
  // Self-heal from missed events: the bridge reports whether Pi is idle on every batch.
  if (batch.idle === true && session.status === "running" && !session.compaction) {
    session.status = "idle";
    session.stream = undefined;
    session.tools = {};
  }
  if (persisted) session.historyVersion += 1;
  return session;
}

function publicSession(session) {
  return {
    id: session.id,
    pid: session.pid,
    cwd: session.cwd,
    name: session.name,
    model: session.model,
    context: session.context,
    status: session.status,
    compaction: session.compaction,
    lastCompaction: session.lastCompaction,
    stream: session.stream,
    tools: session.tools,
    turnStartedAt: session.turnStartedAt,
    historyVersion: session.historyVersion,
    lastEventAt: session.lastEventAt,
    ended: session.ended,
    hasHistory: Boolean(session.sessionFile),
    mode: session.mode,
    // The bridge polls for commands while the session is open; this says whether it is listening now.
    listening: (inboxes.get(session.id)?.waiters.length ?? 0) > 0 || now() - (inboxes.get(session.id)?.lastPollAt ?? 0) < 35_000,
  };
}

/* ── page → Pi commands (the bridge long-polls for them) ── */

const COMMAND_TTL_MS = 20_000;
const MAX_SEND_CHARS = 200_000;
/** sessionId -> { queue: command[], waiters: res[], lastPollAt } */
const inboxes = new Map();

function inboxFor(id) {
  let inbox = inboxes.get(id);
  if (!inbox) {
    inbox = { queue: [], waiters: [], lastPollAt: 0 };
    inboxes.set(id, inbox);
  }
  return inbox;
}

function deliver(inbox) {
  while (inbox.queue.length && inbox.waiters.length) {
    const res = inbox.waiters.shift();
    const commands = inbox.queue.splice(0);
    sendJson(res, 200, { commands });
  }
}

function enqueueCommand(sessionId, command) {
  const inbox = inboxFor(sessionId);
  inbox.queue.push(command);
  deliver(inbox);
  // Not picked up in time: tell the page, and drop it so it never arrives late.
  setTimeout(() => {
    const index = inbox.queue.indexOf(command);
    if (index >= 0) {
      inbox.queue.splice(index, 1);
      broadcast({
        type: "delivered",
        cmdId: command.cmdId,
        ok: false,
        error: "Pi didn't pick it up. Is the companion extension loaded in that Pi? Try /reload there.",
      });
    }
  }, COMMAND_TTL_MS).unref();
}

function broadcast(message) {
  const payload = `data: ${JSON.stringify(message)}\n\n`;
  for (const res of clients) res.write(payload);
}

/** Coalesce per-session broadcasts so streaming text goes out at most ~12 times a second. */
const pendingBroadcast = new Map();
function scheduleSessionBroadcast(session) {
  if (pendingBroadcast.has(session.id)) return;
  pendingBroadcast.set(
    session.id,
    setTimeout(() => {
      pendingBroadcast.delete(session.id);
      broadcast({ type: "session", session: publicSession(session) });
    }, 80),
  );
}

// Drop sessions whose Pi process has exited.
setInterval(() => {
  for (const [id, session] of sessions) {
    if (session.pid && !isProcessAlive(session.pid)) {
      sessions.delete(id);
      inboxes.delete(id);
      broadcast({ type: "removed", id });
    }
  }
}, 10_000).unref();

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Parsed entries of the few most recently opened session files, reused until the file changes. */
const entriesCache = new Map();
async function readEntries(file) {
  if (!isUnderSessionsDir(file)) return undefined;
  try {
    const stats = await stat(file);
    const cached = entriesCache.get(file);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.entries;
    const entries = parseEntries(await readFile(file, "utf8"));
    entriesCache.delete(file);
    entriesCache.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, entries });
    while (entriesCache.size > 4) entriesCache.delete(entriesCache.keys().next().value);
    return entries;
  } catch {
    return undefined;
  }
}

/* ── saved sessions (from disk) ───────────────────────── */

/** id -> metadata of the latest scan */
let savedById = new Map();
let lastScanAt = 0;
let scanInFlight;
async function refreshSaved() {
  if (Date.now() - lastScanAt < 2000) return;
  if (!scanInFlight) {
    scanInFlight = scanSessions(SESSIONS_DIR)
      .then((metas) => {
        savedById = new Map(metas.map((meta) => [meta.id, meta]));
        lastScanAt = Date.now();
      })
      .finally(() => {
        scanInFlight = undefined;
      });
  }
  await scanInFlight;
}

/** Where a session's history lives: a live session first, else the saved index. */
function locate(id) {
  const live = sessions.get(id);
  if (live?.sessionFile) return { file: live.sessionFile, leafId: live.leafId, historyVersion: live.historyVersion };
  const saved = savedById.get(id);
  if (saved) return { file: saved.file, leafId: undefined, historyVersion: 0 };
  return undefined;
}

/** The workspace folder of a session (live or saved). Only these folders are ever browsed. */
async function workspaceRootFor(id) {
  if (!sessions.has(id) && !savedById.has(id)) await refreshSaved();
  const root = sessions.get(id)?.cwd ?? savedById.get(id)?.cwd;
  if (!root) throw new WorkbenchError(404, "unknown session");
  return root;
}

async function workspaceTree() {
  await refreshSaved();
  const rows = new Map();
  for (const meta of savedById.values()) {
    rows.set(meta.id, {
      id: meta.id,
      cwd: meta.cwd,
      name: meta.name,
      preview: meta.preview,
      created: meta.created,
      lastActivity: meta.mtimeMs,
      live: undefined,
    });
  }
  for (const live of sessions.values()) {
    const row = rows.get(live.id) ?? {
      id: live.id,
      cwd: live.cwd ?? "",
      name: undefined,
      preview: "",
      created: undefined,
      lastActivity: 0,
    };
    row.live = live.status;
    if (live.name && !["New thread", "New session"].includes(live.name)) row.name = live.name;
    row.lastActivity = Math.max(row.lastActivity ?? 0, live.lastEventAt ?? 0);
    rows.set(live.id, row);
  }
  return groupByWorkspace([...rows.values()]).map(({ key, ...group }) => ({ id: key, ...group }));
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(resolve(PUBLIC_DIR))) {
    res.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  // DNS-rebinding guard: only answer requests addressed to this machine by its loopback name.
  const host = String(req.headers.host ?? "").toLowerCase();
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) {
    res.writeHead(421, { "content-type": "text/plain" }).end("wrong host");
    return;
  }
  try {
    if (url.pathname === "/bridge/inbox") {
      // Long poll from the bridge extension in Pi: wait up to 25 s for commands for this session.
      if (req.method !== "GET" || req.headers["x-pi-companion"] !== "1") {
        res.writeHead(403).end();
        return;
      }
      const id = url.searchParams.get("session") ?? "";
      if (!id) {
        res.writeHead(400).end();
        return;
      }
      const inbox = inboxFor(id);
      inbox.lastPollAt = now();
      inbox.waiters.push(res);
      const live = sessions.get(id);
      if (live && inbox.waiters.length === 1) scheduleSessionBroadcast(live);
      const timer = setTimeout(() => {
        const i = inbox.waiters.indexOf(res);
        if (i < 0) return; // already answered with commands
        inbox.waiters.splice(i, 1);
        res.writeHead(204).end();
      }, 25_000);
      // res (not req) "close": fires when the answer is sent or the bridge disconnects.
      res.on("close", () => {
        clearTimeout(timer);
        const i = inbox.waiters.indexOf(res);
        if (i >= 0) inbox.waiters.splice(i, 1);
        inbox.lastPollAt = now();
      });
      deliver(inbox);
      return;
    }

    if (url.pathname === "/bridge/ack") {
      if (req.method !== "POST" || req.headers["x-pi-companion"] !== "1") {
        res.writeHead(403).end();
        return;
      }
      const ack = JSON.parse(await readBody(req));
      broadcast({ type: "delivered", cmdId: String(ack.cmdId ?? ""), ok: ack.ok === true, error: ack.error, detail: ack.detail });
      res.writeHead(204).end();
      return;
    }

    if (url.pathname === "/api/send") {
      // From the companion page. The custom header means a cross-site page can't send this
      // without a CORS preflight (never answered), and the Host check above stops DNS rebinding.
      if (req.method !== "POST" || req.headers["x-pi-companion-page"] !== "1") {
        res.writeHead(403).end();
        return;
      }
      const body = JSON.parse(await readBody(req));
      const id = String(body.id ?? "");
      const live = sessions.get(id);
      if (!live || live.ended) {
        sendJson(res, 409, { error: "That session isn't running." });
        return;
      }
      const text = typeof body.text === "string" ? body.text : "";
      if (!text.trim()) {
        sendJson(res, 400, { error: "Nothing to send." });
        return;
      }
      if (text.length > MAX_SEND_CHARS) {
        sendJson(res, 413, { error: "Too long to paste (over 200,000 characters)." });
        return;
      }
      const command = { cmdId: randomUUID(), type: "paste", text };
      enqueueCommand(id, command);
      sendJson(res, 202, { cmdId: command.cmdId });
      return;
    }

    if (url.pathname === "/ingest") {
      // A custom header forces a CORS preflight, which this server never answers,
      // so a web page in the browser cannot post fake events here.
      if (req.method !== "POST" || req.headers["x-pi-companion"] !== "1") {
        res.writeHead(403).end();
        return;
      }
      const batch = JSON.parse(await readBody(req));
      const session = applyBatch(batch);
      if (session) scheduleSessionBroadcast(session);
      res.writeHead(204).end();
      return;
    }

    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }

    if (url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "hello", sessions: [...sessions.values()].map(publicSession) })}\n\n`);
      clients.add(res);
      const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 20_000);
      req.on("close", () => {
        clearInterval(keepAlive);
        clients.delete(res);
      });
      return;
    }

    if (url.pathname === "/api/sessions") {
      sendJson(res, 200, [...sessions.values()].map(publicSession));
      return;
    }

    if (url.pathname === "/api/workspaces") {
      sendJson(res, 200, { workspaces: await workspaceTree() });
      return;
    }

    if (url.pathname === "/api/history") {
      const id = url.searchParams.get("id") ?? "";
      if (!sessions.has(id) && !savedById.has(id)) await refreshSaved();
      const where = locate(id);
      const entries = where ? await readEntries(where.file) : undefined;
      if (!entries) {
        sendJson(res, 404, { error: "no history for that session" });
        return;
      }
      sendJson(res, 200, { ...transcriptItems(entries, where.leafId), historyVersion: where.historyVersion });
      return;
    }

    if (url.pathname === "/api/image") {
      const where = locate(url.searchParams.get("id") ?? "");
      const entries = where ? await readEntries(where.file) : undefined;
      const image = entries ? findImage(entries, url.searchParams.get("ref")) : undefined;
      if (!image) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": image.mimeType, "cache-control": "private, max-age=3600" });
      res.end(image.data);
      return;
    }

    if (url.pathname.startsWith("/api/files") || url.pathname.startsWith("/api/file") || url.pathname.startsWith("/api/review")) {
      try {
        const root = await workspaceRootFor(url.searchParams.get("id") ?? "");
        const path = url.searchParams.get("path") ?? "";
        const scope = url.searchParams.get("scope") === "branch" ? "branch" : "uncommitted";
        if (url.pathname === "/api/files") {
          sendJson(res, 200, { root, entries: await listDir(root, path) });
        } else if (url.pathname === "/api/file") {
          const view = await readFileForView(root, path);
          if (view.kind === "image" && url.searchParams.get("raw") === "1") {
            res.writeHead(200, { "content-type": view.mimeType, "cache-control": "no-cache" });
            res.end(await readFile(view.file));
          } else {
            const { file, ...rest } = view;
            sendJson(res, 200, rest);
          }
        } else if (url.pathname === "/api/review") {
          sendJson(res, 200, await reviewStatus(root, scope));
        } else if (url.pathname === "/api/review/diff") {
          sendJson(res, 200, await reviewDiff(root, scope, path));
        } else {
          res.writeHead(404).end();
        }
      } catch (error) {
        if (error instanceof WorkbenchError) sendJson(res, error.status, { error: error.message });
        else throw error;
      }
      return;
    }

    if (url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true, sessions: sessions.size, clients: clients.size });
      return;
    }

    await serveStatic(res, url.pathname);
  } catch (error) {
    console.error("[companion]", error);
    if (!res.headersSent) res.writeHead(400);
    res.end();
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`[companion] ${HOST}:${PORT} is already in use; another companion is probably running.`);
    process.exit(2);
  }
  throw error;
});

server.listen(PORT, HOST, () => {
  console.log(`[companion] listening on http://${HOST}:${PORT} (sessions: ${SESSIONS_DIR})`);
});

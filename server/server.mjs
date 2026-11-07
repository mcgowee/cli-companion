// CLI Companion server: a live view of coding-agent CLI sessions (Pi live, others read-only).
//
// - The bridge extension (extension/companion.ts) POSTs event batches to /ingest
//   and long-polls /bridge/inbox for text the page sends. Pi stays the source of truth.
// - The page subscribes to /events (Server-Sent Events) and fetches history from the
//   session JSONL through /api/history.
// - Each CLI is a "source" (server/sources/): where its sessions are, how to read one, whether
//   it's running, and its start/resume commands. Sources without a live bridge (Claude Code)
//   are listed and read, never written; the page polls /api/stat to follow a growing one.
//
// Rules: bind 127.0.0.1 only, Node built-ins only, never write any CLI's files.

import { commandFromRequest } from "./commands.mjs";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { groupByWorkspace, workspaceKey } from "./session-index.mjs";
import { addDashboard, DashboardError, isLoopbackUrl, loadDashboards, removeDashboard } from "./dashboards.mjs";
import { usageSummary } from "./usage.mjs";
import { copyLine, LaunchError, openPlan, resumeCommand, workspaceActions } from "./launch.mjs";
import { execFileSync, spawn } from "node:child_process";
import { isProcessAlive } from "./fsutil.mjs";
import { createSources, describeSources, nativeId, sourceForId } from "./sources/index.mjs";
import { APP_ID, companionPort, migrateStateFile, stateDir } from "./start.mjs";
import { listDir, readFileForView, reviewDiff, reviewStatus, WorkbenchError } from "./workbench.mjs";

const HOST = "127.0.0.1";
const PORT = companionPort();
// The CLIs the companion reads (server/sources/): Pi, Claude Code, …
const SOURCES = createSources();
const PI = SOURCES.find((s) => s.id === "pi");
const sourceById = (id) => SOURCES.find((s) => s.id === id) ?? PI;
// With no running/idle signal from a CLI, a transcript written this recently counts as running.
const ACTIVE_FALLBACK_MS = 2 * 60_000;
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const MAX_BODY = 4 * 1024 * 1024;
const SERVER_STARTED_AT = Date.now();
// The one file the companion writes: your custom dashboard links.
migrateStateFile("dashboards.json");
const DASHBOARDS_FILE = join(stateDir(), "dashboards.json");

/** Live sessions keyed by Pi session id. */
const sessions = new Map();
/** Open SSE responses. */
const clients = new Set();

function now() {
  return Date.now();
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
  if (PI.owns(batch.sessionFile)) session.sessionFile = batch.sessionFile;
  if (typeof batch.cwd === "string") session.cwd = batch.cwd;
  if (typeof batch.name === "string") session.name = batch.name;
  if (typeof batch.model === "string") session.model = batch.model;
  if (typeof batch.leafId === "string") session.leafId = batch.leafId;
  if (typeof batch.mode === "string") session.mode = batch.mode;
  if (batch.context && typeof batch.context === "object") session.context = batch.context;
  if (Array.isArray(batch.commands)) session.commands = batch.commands.slice(0, 500);
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
  // Self-heal from missed events: every batch says whether Pi is working (agent_start until
  // agent_settled). Older extensions sent `idle` (ctx.isIdle(), "not streaming"), which is also
  // true while a tool runs, so it is no longer used: it showed Idle while Pi was working.
  if (typeof batch.running === "boolean" && !session.compaction && session.status !== "ended") {
    if (batch.running && session.status !== "running") {
      session.status = "running";
      session.turnStartedAt ??= now();
    } else if (!batch.running && session.status === "running") {
      session.status = "idle";
      session.stream = undefined;
      session.tools = {};
      session.turnStartedAt = undefined;
    }
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

/* ── saved sessions (from disk) ───────────────────────── */

/** id -> metadata of the latest scan */
let savedById = new Map();
let lastScanAt = 0;
let scanInFlight;
async function refreshSaved() {
  if (Date.now() - lastScanAt < 2000) return;
  if (!scanInFlight) {
    scanInFlight = Promise.all(SOURCES.filter((source) => source.enabled).map((source) => source.scan()))
      .then((lists) => {
        const metas = lists.flat();
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
  if (live?.sessionFile) return { file: live.sessionFile, leafId: live.leafId, historyVersion: live.historyVersion, source: PI };
  const saved = savedById.get(id);
  if (saved) return { file: saved.file, leafId: undefined, historyVersion: 0, source: sourceById(saved.source) };
  return undefined;
}

/** The workspace folder of a session (live or saved). Only these folders are ever browsed. */
async function workspaceRootFor(id) {
  if (!sessions.has(id) && !savedById.has(id)) await refreshSaved();
  const root = sessions.get(id)?.cwd ?? savedById.get(id)?.cwd;
  if (!root) throw new WorkbenchError(404, "unknown session");
  return root;
}

/**
 * Running or idle, for sessions without a live bridge: "<source>:<id>" -> "busy" | "idle", from
 * every enabled source that can tell (each caches its own). .supported = the sources that can.
 */
async function runningMap() {
  const merged = new Map();
  merged.supported = new Set();
  for (const source of SOURCES) {
    if (!source.enabled || !source.running) continue;
    const map = await source.running();
    for (const [id, status] of map) merged.set(id, status);
    if (map.supported) merged.supported.add(source.id);
  }
  return merged;
}

/** Is a session without a bridge running? Its CLI's own signal first, else a recent transcript write. */
function fileActivity(source, id, mtimeMs, running) {
  if (source.live) return {};
  const status = running.get(id);
  if (status) return { active: true, runStatus: status };
  return { active: !running.supported.has(source.id) && now() - mtimeMs < ACTIVE_FALLBACK_MS ? true : undefined };
}

/* ── terminal menu: open a workspace or saved session ── */

/** The folder (and session) a menu is for; only folders and sessions from the index. */
async function launchTarget(kind, id) {
  await refreshSaved();
  if (kind === "session") {
    const meta = savedById.get(id);
    if (!meta?.cwd) throw new LaunchError("Unknown session.");
    const source = sourceById(meta.source);
    const sessionId = nativeId(source, id);
    const running = source.live ? Boolean(sessions.get(id) && !sessions.get(id).ended) : (await runningMap()).has(id);
    return { kind, cwd: await existingDir(meta.cwd), source, sessionId, running };
  }
  if (kind === "workspace") {
    const meta = [...savedById.values()].find((m) => workspaceKey(m.cwd) === id);
    const live = [...sessions.values()].find((s) => workspaceKey(s.cwd) === id);
    const cwd = meta?.cwd ?? live?.cwd;
    if (!cwd) throw new LaunchError("Unknown workspace.");
    return { kind, cwd: await existingDir(cwd) };
  }
  throw new LaunchError("Unknown kind.");
}

async function existingDir(dir) {
  try {
    if ((await stat(dir)).isDirectory()) return dir;
  } catch {
    // fall through
  }
  throw new LaunchError(`The folder ${dir} doesn't exist any more.`);
}

function launchOptions(target) {
  const make = ({ action, label, command }, disabled) => ({
    action,
    label,
    command,
    copy: copyLine(target.cwd, command),
    ...(disabled ? { disabled } : {}),
  });
  if (target.kind === "session") {
    const disabled = target.running ? "This session is already running. Use its open terminal." : undefined;
    const command = resumeCommand(target.source, target.sessionId);
    return [make({ action: "resume", label: `Resume in ${target.source.label}`, command }, disabled)];
  }
  return workspaceActions(SOURCES).map((option) => make(option));
}

let shellName;
function preferredShell() {
  if (shellName) return shellName;
  try {
    execFileSync("where.exe", ["pwsh"], { stdio: "ignore", windowsHide: true });
    shellName = "pwsh";
  } catch {
    shellName = "powershell.exe";
  }
  return shellName;
}

function spawnDetached(file, args, options = {}) {
  return new Promise((resolveSpawn, reject) => {
    const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: false, ...options });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolveSpawn();
    });
  });
}

async function openTerminal(cwd, command) {
  const plan = openPlan(cwd, command, { shell: preferredShell() });
  if (!plan) throw new LaunchError("Opening a terminal works on Windows only for now. Use Copy.");
  try {
    await spawnDetached(plan.terminal.file, plan.terminal.args);
  } catch {
    await spawnDetached(plan.fallback.file, plan.fallback.args, { cwd: plan.fallback.cwd });
  }
}

async function workspaceTree() {
  await refreshSaved();
  const running = await runningMap();
  const rows = new Map();
  for (const meta of savedById.values()) {
    rows.set(meta.id, {
      id: meta.id,
      source: meta.source ?? "pi",
      cwd: meta.cwd,
      name: meta.name,
      preview: meta.preview,
      created: meta.created,
      lastActivity: meta.mtimeMs,
      live: undefined,
      ...fileActivity(sourceById(meta.source), meta.id, meta.mtimeMs, running),
    });
  }
  for (const live of sessions.values()) {
    const row = rows.get(live.id) ?? {
      id: live.id,
      source: "pi",
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
      broadcast({
        type: "delivered",
        cmdId: String(ack.cmdId ?? ""),
        ok: ack.ok === true,
        error: typeof ack.error === "string" ? ack.error.slice(0, 500) : undefined,
        detail: typeof ack.detail === "string" ? ack.detail.slice(0, 100) : undefined,
        // What Pi's input box holds after the command, so the page can show and verify it.
        editor: typeof ack.editor === "string" ? ack.editor.slice(0, 50_000) : undefined,
      });
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
      // The page picks the id before sending, so a reply that arrives before this response can't be missed.
      const { command, status, error } = commandFromRequest(body);
      if (!command) {
        sendJson(res, status, { error });
        return;
      }
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

    // Everything below is read-only, except adding/removing custom dashboard links.
    if (req.method !== "GET" && url.pathname !== "/api/dashboards" && url.pathname !== "/api/launch") {
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
      const entries = where ? await where.source.readEntries(where.file) : undefined;
      if (!entries) {
        sendJson(res, 404, { error: "no history for that session" });
        return;
      }
      const transcript = where.source.transcript(entries, { leafId: where.leafId });
      sendJson(res, 200, { ...transcript, source: where.source.id, historyVersion: where.historyVersion });
      return;
    }

    if (url.pathname === "/api/commands") {
      // Slash commands for the composer's "/" lookup, for the selected session's CLI.
      const id = url.searchParams.get("id") ?? "";
      const source = sourceForId(SOURCES, id);
      if (!sessions.has(id) && !savedById.has(id)) await refreshSaved();
      const live = sessions.get(id);
      const cwd = live?.cwd ?? savedById.get(id)?.cwd;
      sendJson(res, 200, { cli: source.id, commands: await source.slashCommands({ cwd, live }) });
      return;
    }

    if (url.pathname === "/api/stat") {
      // Cheap change check for sessions without a live bridge (Claude Code): size + mtime only.
      const id = url.searchParams.get("id") ?? "";
      const where = locate(id);
      if (!where) {
        sendJson(res, 404, { error: "unknown session" });
        return;
      }
      try {
        const s = await stat(where.file);
        const activity = fileActivity(where.source, id, s.mtimeMs, await runningMap());
        sendJson(res, 200, { size: s.size, mtimeMs: s.mtimeMs, active: Boolean(activity.active), runStatus: activity.runStatus });
      } catch {
        sendJson(res, 404, { error: "file not found" });
      }
      return;
    }

    if (url.pathname === "/api/image") {
      const where = locate(url.searchParams.get("id") ?? "");
      const entries = where ? await where.source.readEntries(where.file) : undefined;
      const ref = url.searchParams.get("ref");
      const image = entries ? where.source.findImage(entries, ref) : undefined;
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

    if (url.pathname === "/api/sources") {
      // Which CLIs this server reads, and what the page can do with each.
      sendJson(res, 200, { sources: describeSources(SOURCES) });
      return;
    }

    if (url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true, app: APP_ID, sessions: sessions.size, clients: clients.size });
      return;
    }

    if (url.pathname === "/api/launch") {
      // Terminal menu for a workspace or saved session: GET lists the options (with the line to
      // copy); POST opens one in a new terminal window (page header required).
      if (req.method === "POST" && req.headers["x-pi-companion-page"] !== "1") {
        res.writeHead(403).end();
        return;
      }
      const params = req.method === "POST" ? JSON.parse(await readBody(req)) : Object.fromEntries(url.searchParams);
      try {
        const target = await launchTarget(String(params.kind ?? ""), String(params.id ?? ""));
        if (req.method === "GET") {
          sendJson(res, 200, { cwd: target.cwd, canOpen: process.platform === "win32", options: launchOptions(target) });
          return;
        }
        const option = launchOptions(target).find((o) => o.action === params.action);
        if (!option) throw new LaunchError("That isn't available here.");
        if (option.disabled) throw new LaunchError(option.disabled);
        await openTerminal(target.cwd, option.command);
        sendJson(res, 200, { ok: true, opened: option.label });
      } catch (error) {
        sendJson(res, error instanceof LaunchError ? 400 : 500, { error: error.message });
      }
      return;
    }

    if (url.pathname === "/api/usage") {
      await refreshSaved();
      const days = [7, 30, 90].includes(Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 30;
      const offsetMin = Math.max(-840, Math.min(840, Number.parseInt(url.searchParams.get("tz") ?? "0", 10) || 0));
      const ids = SOURCES.filter((source) => source.enabled).map((source) => source.id);
      sendJson(res, 200, usageSummary([...savedById.values()], { days, offsetMin, sources: ids }));
      return;
    }

    if (url.pathname === "/api/dashboards") {
      if (req.method === "GET") {
        const list = await loadDashboards(DASHBOARDS_FILE);
        // "online" only for addresses on this computer; anything else is left unknown.
        const withStatus = await Promise.all(
          list.map(async (d) => {
            if (!isLoopbackUrl(d.url)) return { ...d, online: null };
            try {
              const r = await fetch(d.url, { method: "GET", signal: AbortSignal.timeout(1200), redirect: "manual" });
              await r.body?.cancel();
              return { ...d, online: true };
            } catch {
              return { ...d, online: false };
            }
          }),
        );
        sendJson(res, 200, { file: DASHBOARDS_FILE, dashboards: withStatus });
        return;
      }
      // Changes come only from this page (custom header: a cross-site page can't send it).
      if (req.headers["x-pi-companion-page"] !== "1") {
        res.writeHead(403).end();
        return;
      }
      try {
        if (req.method === "POST") {
          sendJson(res, 201, await addDashboard(DASHBOARDS_FILE, JSON.parse(await readBody(req))));
        } else if (req.method === "DELETE") {
          const removed = await removeDashboard(DASHBOARDS_FILE, url.searchParams.get("id") ?? "");
          sendJson(res, removed ? 200 : 404, { removed });
        } else {
          res.writeHead(405).end();
        }
      } catch (error) {
        sendJson(res, error instanceof DashboardError ? 400 : 500, { error: error.message });
      }
      return;
    }

    if (url.pathname === "/api/about") {
      // For the About page: version and where this server reads from.
      let version;
      try {
        version = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
      } catch {
        version = undefined;
      }
      const running = await runningMap();
      sendJson(res, 200, {
        version,
        address: `http://${HOST}:${PORT}`,
        node: process.version,
        platform: process.platform,
        sources: describeSources(SOURCES),
        dashboardsFile: DASHBOARDS_FILE,
        livePi: [...sessions.values()].filter((s) => !s.ended).length,
        runningOther: running.size,
        startedAt: SERVER_STARTED_AT,
      });
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
  console.log(`[companion] listening on http://${HOST}:${PORT} (reading: ${SOURCES.filter((source) => source.enabled).map((source) => source.label).join(", ")})`);
});

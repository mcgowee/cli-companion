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
import { lastExchange, localModels, ollamaUrl, SuggestError, suggestionCache, suggestReplies } from "./suggest.mjs";
import { addFavorite, FavoriteError, loadFavorites, removeFavorite } from "./favorites.mjs";
import { APP_FILE_HEADERS, APP_MIME, exchangeText, fileKind, findApps, resolveAppFile, urlName } from "./apps.mjs";
import { createReadStream } from "node:fs";
import { addDashboard, DashboardError, isLoopbackUrl, loadDashboards, removeDashboard } from "./dashboards.mjs";
import { usageSummary } from "./usage.mjs";
import { createTokenTracker } from "./token-usage.mjs";
import { createSearchIndex } from "./search.mjs";
import { copyLine, defaultSshHost, headlessNote, isHeadless, LaunchError, openPlan, pidAncestry, quotePath, resumeCommand, sshAttachOption, terminalsFor, tmuxSessionFromPanes, workspaceActions } from "./launch.mjs";
import { handoffBrief, handoffFileName, saveHandoff, sessionMarkdown } from "./handoff.mjs";
import { PLACES, setShortcut, shortcutStatus } from "./shortcut.mjs";
import { frequentPrompts, loadPrompts, PromptError, savePrompts, validatePrompts } from "./prompts.mjs";
import { classifyRequest, loadRemote, remoteAllowed, saveRemote, serveOff, serveOn, serving, tailscaleSelf } from "./remote.mjs";
import { loadSettings, readSettingsStrict, saveSettings, SettingsError, settingsStamp, sourceEnv, validateSettings } from "./settings.mjs";
import { execFileSync, spawn } from "node:child_process";
import { isProcessAlive } from "./fsutil.mjs";
import { createSources, describeSources, nativeId, sourceForId } from "./sources/index.mjs";
import { APP_ID, accessKey, companionPort, ensureServer, isPortUp, migrateStateFile, removeRuntimeFile, stateDir, writeRuntimeFile } from "./start.mjs";
import { hasKey, keyCookie, lockedPage, needsKey, sameKey } from "./access.mjs";
import { MAX_UPLOAD, saveUpload } from "./uploads.mjs";
import { createRunner, encodedCommand, looksInteractive, MAX_COMMAND } from "./runner.mjs";
import { gitSummary, listDir, makeFolder, readFileForView, resolveInside, reviewDiff, reviewStatus, WorkbenchError } from "./workbench.mjs";

const HOST = "127.0.0.1";
const PORT = companionPort();
// This computer's access key (server/access.mjs): made on first start, kept in the state folder.
const ACCESS_KEY = accessKey();
// Your settings (the Settings page): which CLIs to read, their folders, the terminal for Open.
const SETTINGS_FILE = join(stateDir(), "settings.json");
let settings = await loadSettings(SETTINGS_FILE);
// The file's stamp when `settings` was read; moves on disk mean a hand edit to pick up.
let settingsRev = await settingsStamp(SETTINGS_FILE);
// Non-empty while settings.json on disk can't be parsed: GET shows it, saves are refused.
let settingsError = "";
// Phone access over Tailscale (server/remote.mjs): off unless switched on in Settings.
const REMOTE_FILE = join(stateDir(), "remote.json");
let remote = await loadRemote(REMOTE_FILE);

// The CLIs the companion reads (server/sources/): Pi, Claude Code, Codex. Rebuilt when settings change.
let SOURCES = createSources(sourceEnv(settings));
let PI = SOURCES.find((s) => s.id === "pi");
const sourceById = (id) => SOURCES.find((s) => s.id === id) ?? PI;

/** New settings (saved from the page, or hand-edited on disk): rebuild what depends on them. */
function applySettings(next, rev) {
  settings = next;
  settingsRev = rev;
  SOURCES = createSources(sourceEnv(settings));
  PI = SOURCES.find((s) => s.id === "pi");
  lastScanAt = 0;
  broadcast({ type: "sources" });
}

/**
 * Pick up hand edits: re-read settings.json when it changed on disk since the server read it.
 * A file that doesn't parse (a typo, or an editor caught mid-write) changes nothing: the loaded
 * settings stay live, settingsRev stays put so the next refresh tries the file again, and
 * settingsError tells the page (and refuses saves) until the file is fixed.
 */
async function refreshSettings() {
  const rev = await settingsStamp(SETTINGS_FILE);
  if (rev === settingsRev) {
    settingsError = "";
    return;
  }
  try {
    const next = await readSettingsStrict(SETTINGS_FILE);
    settingsError = "";
    applySettings(next, rev);
  } catch (error) {
    if (!settingsError) console.error(`[companion] ${SETTINGS_FILE} changed but isn't valid JSON (${error.message}); keeping the settings already loaded.`);
    settingsError = `settings.json isn't valid JSON, so the settings shown are from before that edit, and saving is off. Fix the file (${SETTINGS_FILE}), then reload this page.`;
  }
}
// With no running/idle signal from a CLI, a transcript written this recently counts as running.
const ACTIVE_FALLBACK_MS = 2 * 60_000;
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const MAX_BODY = 4 * 1024 * 1024;
const SERVER_STARTED_AT = Date.now();
// The companion's own files (it writes nothing else): your custom dashboard links, and settings below.
migrateStateFile("dashboards.json");
const DASHBOARDS_FILE = join(stateDir(), "dashboards.json");
const FAVORITES_FILE = join(stateDir(), "favorites.json");
const PROMPTS_FILE = join(stateDir(), "prompts.json");
// Token use per session, read from the CLIs' session files (cached in token-usage.json).
const tokenUsage = createTokenTracker({ cacheFile: join(stateDir(), "token-usage.json") });
// Search across sessions: message text in memory only (never written to disk).
const searchIndex = createSearchIndex();
const OLLAMA_URL = ollamaUrl();
const suggestions = suggestionCache();

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

/** The raw request body as a Buffer, up to `limit` bytes. */
function readRaw(req, limit) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      // Too big: stop keeping it, but read the rest so the answer still reaches the page
      // (cut off only if it goes on far past the limit).
      if (size > limit) {
        chunks.length = 0;
        if (size > limit * 2) req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => (size > limit ? reject(new WorkbenchError(413, "Images can be up to 20 MB.")) : resolveBody(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

/* ── Terminal tab (server/runner.mjs) ──────────────────── */

const runner = createRunner();

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
 * Running state for sessions without a live bridge: "<source>:<id>" -> "busy" | "idle" |
 * "waiting" (asking you something; .waitingFor has why), from
 * every enabled source that can tell (each caches its own). .supported = the sources that can.
 */
async function runningMap() {
  const merged = new Map();
  merged.supported = new Set();
  merged.where = new Map();
  merged.waitingFor = new Map();
  for (const source of SOURCES) {
    if (!source.enabled || !source.running) continue;
    const map = await source.running();
    for (const [id, status] of map) merged.set(id, status);
    for (const [id, where] of map.where ?? []) merged.where.set(id, where);
    for (const [id, why] of map.waitingFor ?? []) merged.waitingFor.set(id, why);
    if (map.supported) merged.supported.add(source.id);
  }
  return merged;
}

/** Is a session without a bridge running? Its CLI's own signal first, else a recent transcript write. */
function fileActivity(source, id, mtimeMs, running) {
  if (source.live) return {};
  const status = running.get(id);
  if (status) return { active: true, runStatus: status, ...(status === "waiting" ? { waitingFor: running.waitingFor?.get(id) ?? "" } : {}) };
  return { active: !running.supported.has(source.id) && now() - mtimeMs < ACTIVE_FALLBACK_MS ? true : undefined };
}

/** gitSummary per folder, reused for 10 s (several rows share a folder; the page asks often). */
const gitCache = new Map();
function gitFor(root) {
  const key = root.toLowerCase();
  const hit = gitCache.get(key);
  if (hit && Date.now() - hit.at < 10_000) return hit.value;
  const value = gitSummary(root).catch(() => undefined);
  gitCache.set(key, { at: Date.now(), value });
  if (gitCache.size > 200) gitCache.delete(gitCache.keys().next().value);
  return value;
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
    let running;
    let where;
    let pid;
    if (source.live) {
      running = Boolean(sessions.get(id) && !sessions.get(id).ended);
      pid = sessions.get(id)?.pid;
    } else {
      const map = await runningMap();
      running = map.has(id);
      where = map.where.get(id);
    }
    return { kind, cwd: await existingDir(meta.cwd), source, sessionId, running, where, pid };
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
    const command = resumeCommand(target.source, target.sessionId);
    if (!target.running) return [make({ action: "resume", label: `Resume in ${target.source.label}`, command })];
    // Running: a plain terminal in its folder is still useful. Resuming would put the same session
    // in two places at once, which can mix up its history, so say where it is open instead.
    const where =
      target.where === "desktop"
        ? "Open in the Claude desktop app. To move it to a terminal, close it there first; Resume then appears here."
        : "Already running in a terminal. Switch to that window.";
    return [
      make({ action: "terminal", label: "Terminal here", command: "" }),
      make({ action: "resume", label: `Resume in ${target.source.label}`, command }, where),
    ];
  }
  return workspaceActions(SOURCES).map((option) => make(option));
}

/** The tmux session a running CLI sits in ("" when it isn't in one, or tmux isn't here). */
function tmuxSessionOf(pid) {
  if (!Number.isInteger(pid) || process.platform === "win32") return "";
  try {
    const panes = execFileSync("tmux", ["list-panes", "-a", "-F", "#{pane_pid}\t#{session_name}"], { encoding: "utf8", timeout: 2000, windowsHide: true });
    return tmuxSessionFromPanes(panes, pidAncestry(pid));
  } catch {
    return ""; // no tmux, or no tmux server running for this user
  }
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

/**
 * macOS: run osascript to the end, so a refusal (Terminal or iTerm2 not allowed to be controlled)
 * comes back as an error instead of nothing happening.
 */
function runOsascript(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn("osascript", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) return resolveRun();
      const denied = /-1743|not allowed|not authori[sz]ed/i.test(stderr);
      reject(
        new LaunchError(
          denied
            ? "macOS didn't let the companion control the terminal. Allow it in System Settings → Privacy & Security → Automation (for the browser or node), then try again."
            : `The terminal didn't open (${stderr.trim().split("\n").pop() || `osascript exited with ${code}`}). Use Copy instead.`,
        ),
      );
    });
  });
}

async function openTerminal(cwd, command, { typed = false } = {}) {
  const plans = openPlan(cwd, command, {
    // A command you typed goes to PowerShell encoded, so nothing in it is misread on the way.
    encoded: typed && process.platform === "win32" ? encodedCommand(command) : undefined,
    shell: process.platform === "win32" ? preferredShell() : undefined,
    terminal: settings.terminal,
    userShell: process.env.SHELL,
  });
  let lastError;
  for (const plan of plans) {
    try {
      if (plan.file === "osascript") await runOsascript(plan.args);
      else await spawnDetached(plan.file, plan.args, plan.cwd ? { cwd: plan.cwd } : {});
      return;
    } catch (error) {
      if (error instanceof LaunchError) throw error; // it ran and said no: don't try another
      lastError = error; // not installed: try the next one
    }
  }
  throw new LaunchError(
    plans.length > 1
      ? "No terminal program was found to open. Pick one in Settings, or use Copy."
      : `Couldn't start ${plans[0].file} (${lastError?.code ?? "error"}). Pick another terminal in Settings, or use Copy.`,
  );
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

/** Is a web address answering? Only addresses on this computer are tried. */
async function isOnline(href) {
  if (!isLoopbackUrl(href)) return null;
  try {
    const r = await fetch(href, { method: "GET", signal: AbortSignal.timeout(1200), redirect: "manual" });
    await r.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

/** Apps found in a session's last exchange (reply + your message), cached per exchange (online status is checked each time). */
const appsByReply = new Map();
async function appsFor(id) {
  if (!sessions.has(id) && !savedById.has(id)) await refreshSaved();
  const where = locate(id);
  const entries = where ? await where.source.readEntries(where.file) : undefined;
  if (!entries) throw new WorkbenchError(404, "no history for that session");
  const exchange = lastExchange(where.source.transcript(entries, { leafId: where.leafId }).items);
  if (!exchange) return { for: null, apps: [] };
  const key = `${id} ${exchange.id} ${exchange.reply.length} ${exchange.ask.length}`;
  let found = appsByReply.get(key);
  if (!found) {
    const own = [`http://${HOST}:${PORT}`, `http://localhost:${PORT}`, `http://[::1]:${PORT}`];
    const { urls, files } = findApps(exchangeText(exchange), { exclude: own });
    const root = await workspaceRootFor(id).catch(() => null);
    const resolved = root ? await Promise.all(files.map((f) => resolveAppFile(root, f))) : [];
    const seen = new Set();
    found = [
      ...urls.map((url) => ({ kind: "url", name: urlName(url), url })),
      ...resolved
        .filter((rel) => rel && !seen.has(rel.toLowerCase()) && seen.add(rel.toLowerCase()))
        .map((rel) => ({
          kind: "file",
          type: fileKind(rel),
          name: rel,
          path: rel,
          url: `/app-files/${encodeURIComponent(id)}/${rel.split("/").map(encodeURIComponent).join("/")}`,
        })),
    ];
    appsByReply.set(key, found);
    while (appsByReply.size > 100) appsByReply.delete(appsByReply.keys().next().value);
  }
  const apps = await Promise.all(found.map(async (a) => (a.kind === "url" ? { ...a, online: await isOnline(a.url) } : a)));
  return { for: exchange.id, apps };
}

/** /app-files/<session id>/<path>: a file from inside that session's folder, sandboxed. */
async function serveAppFile(req, res, pathname) {
  const [, , encodedId, ...parts] = pathname.split("/");
  try {
    const id = decodeURIComponent(encodedId ?? "");
    const root = await workspaceRootFor(id);
    const file = await resolveInside(root, parts.map(decodeURIComponent).join("/"));
    const info = await stat(file);
    if (!info.isFile()) throw new WorkbenchError(404, "not a file");
    const ext = extname(file).toLowerCase();
    const headers = { "content-type": APP_MIME[ext] ?? "application/octet-stream", "accept-ranges": "bytes", ...APP_FILE_HEADERS };
    // Chrome's PDF viewer refuses to run inside a sandboxed response; PDFs get nosniff only.
    if (ext === ".pdf") delete headers["content-security-policy"];
    // Videos can be large and are seeked: stream them and answer byte ranges.
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
      let end = range[1] && range[2] ? Number(range[2]) : info.size - 1;
      end = Math.min(end, info.size - 1);
      if (start > end || start >= info.size) {
        res.writeHead(416, { "content-range": `bytes */${info.size}` }).end();
        return;
      }
      res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${info.size}`, "content-length": end - start + 1 });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, "content-length": info.size });
    createReadStream(file).pipe(res);
  } catch (error) {
    res.writeHead(error instanceof WorkbenchError ? error.status : 400, { "content-type": "text/plain; charset=utf-8", ...APP_FILE_HEADERS });
    res.end(error instanceof WorkbenchError ? error.message : "bad path");
  }
}

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
  // DNS-rebinding guard: only answer requests addressed to this machine by its loopback name, or,
  // with phone access on, to its Tailscale name from your own Tailscale account (server/remote.mjs).
  const who = classifyRequest({ host: req.headers.host, headers: req.headers }, { port: PORT, remote });
  if (!who.ok) {
    res.writeHead(who.status, { "content-type": "text/plain" }).end(who.reason);
    return;
  }
  if (who.remote && !remoteAllowed(req.method, url.pathname, remote)) {
    sendJson(res, 403, { error: "Not available from your phone. Use the companion on the computer." });
    return;
  }
  // Access key (requests from this computer; the phone is checked by its Tailscale identity).
  if (!who.remote) {
    const given = url.searchParams.get("key");
    if (given !== null && (req.method === "GET" || req.method === "HEAD") && !needsKey(url.pathname) && sameKey(given, ACCESS_KEY)) {
      // Opened with ?key=: keep it as a cookie and drop it from the address.
      url.searchParams.delete("key");
      res.writeHead(302, { location: url.pathname + url.search, "set-cookie": keyCookie(PORT, ACCESS_KEY), "cache-control": "no-store" }).end();
      return;
    }
    const allowed = hasKey(req.headers, { port: PORT, key: ACCESS_KEY });
    if (!allowed && needsKey(url.pathname)) {
      sendJson(res, 401, { error: "Open CLI Companion from its shortcut or the cli-companion command (this window has no access key)." });
      return;
    }
    if (!allowed && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(lockedPage());
      return;
    }
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
    if (url.pathname === "/api/server" && req.method === "POST") {
      // Stop or restart this server (About page's Restart, `cli-companion --stop/--restart`).
      if (req.headers["x-pi-companion-page"] !== "1") {
        res.writeHead(403).end();
        return;
      }
      const { action } = JSON.parse(await readBody(req));
      if (action !== "stop" && action !== "restart") {
        sendJson(res, 400, { error: "action must be stop or restart" });
        return;
      }
      sendJson(res, 202, { ok: true, action });
      shutDown(action === "restart");
      return;
    }

    if (req.method !== "GET" && !["/api/dashboards", "/api/favorites", "/api/folder", "/api/handoff", "/api/launch", "/api/prompts", "/api/remote", "/api/settings", "/api/shortcut", "/api/upload", "/api/run", "/api/run/stop", "/api/run/open"].includes(url.pathname)) {
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
      let usage;
      try {
        usage = await tokenUsage.forSession({ id, source: where.source.id, file: where.file });
      } catch {
        // Token use is extra: the transcript still shows without it.
      }
      sendJson(res, 200, { ...transcript, usage, source: where.source.id, historyVersion: where.historyVersion });
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
        sendJson(res, 200, { size: s.size, mtimeMs: s.mtimeMs, active: Boolean(activity.active), runStatus: activity.runStatus, waitingFor: activity.waitingFor });
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

    if (url.pathname === "/api/run" || url.pathname.startsWith("/api/run/") || url.pathname === "/api/runs") {
      // The Terminal tab. Every request needs the page header (reading output too), and only
      // works with Settings → Terminal → "Let the companion run commands" on.
      if (req.headers["x-pi-companion-page"] !== "1") {
        res.writeHead(403).end();
        return;
      }
      try {
        if (url.pathname === "/api/runs") {
          const id = url.searchParams.get("id") ?? "";
          const cwd = id ? await workspaceRootFor(id).catch(() => "") : "";
          sendJson(res, 200, { enabled: settings.runCommands === true, cwd, platform: process.platform, runs: cwd ? runner.list(cwd) : [] });
          return;
        }
        if (url.pathname === "/api/run" && req.method === "GET") {
          const run = runner.read(url.searchParams.get("run") ?? "", url.searchParams.get("from"));
          if (!run) throw new WorkbenchError(404, "That run is gone (the companion restarted, or it was one of the oldest).");
          sendJson(res, 200, run);
          return;
        }
        if (url.pathname === "/api/run/stop") {
          const body = JSON.parse((await readBody(req)) || "{}");
          const run = runner.stop(String(body.run ?? ""));
          if (!run) throw new WorkbenchError(404, "That run is gone.");
          sendJson(res, 200, run);
          return;
        }
        if (settings.runCommands !== true) {
          throw new WorkbenchError(403, "Running commands is off. Turn it on in Settings → Terminal.");
        }
        const body = JSON.parse((await readBody(req)) || "{}");
        const command = String(body.command ?? "").trim();
        if (!command) throw new WorkbenchError(400, "Type a command first.");
        if (command.length > MAX_COMMAND) throw new WorkbenchError(400, "That command is too long.");
        const cwd = await workspaceRootFor(String(body.id ?? ""));
        const info = await stat(cwd).catch(() => null);
        if (!info?.isDirectory()) throw new WorkbenchError(404, "This session's folder doesn't exist any more.");
        if (url.pathname === "/api/run/open") {
          await openTerminal(cwd, command, { typed: true });
          sendJson(res, 200, { ok: true });
          return;
        }
        if (url.pathname !== "/api/run") throw new WorkbenchError(404, "not found");
        const run = runner.start({
          command,
          cwd,
          sessionId: String(body.id ?? ""),
          shell: process.platform === "win32" ? preferredShell() : undefined,
          userShell: process.env.SHELL,
        });
        sendJson(res, 200, { ...run, interactive: looksInteractive(command) });
      } catch (error) {
        const status = error instanceof WorkbenchError ? error.status : error instanceof LaunchError ? 400 : 400;
        sendJson(res, status, { error: error.message });
      }
      return;
    }

    if (url.pathname === "/api/upload") {
      // An image from the composer, saved into the selected session's folder (server/uploads.mjs).
      // The body is the image itself. Page header required; the phone can't (remoteAllowed).
      if (req.method !== "POST" || req.headers["x-pi-companion-page"] !== "1") {
        res.writeHead(req.method !== "POST" ? 405 : 403).end();
        return;
      }
      try {
        const root = await workspaceRootFor(url.searchParams.get("id") ?? "");
        const info = await stat(root).catch(() => null);
        if (!info?.isDirectory()) throw new WorkbenchError(404, "This session's folder doesn't exist any more.");
        if (Number(req.headers["content-length"]) > MAX_UPLOAD) throw new WorkbenchError(413, "Images can be up to 20 MB.");
        const body = await readRaw(req, MAX_UPLOAD);
        const path = await saveUpload(root, body, { hint: url.searchParams.get("name") ?? "" }).catch((error) => {
          throw error instanceof WorkbenchError ? error : new WorkbenchError(400, error.message);
        });
        sendJson(res, 200, { path, url: `/app-files/${encodeURIComponent(url.searchParams.get("id"))}/${path.split("/").map(encodeURIComponent).join("/")}` });
      } catch (error) {
        sendJson(res, error instanceof WorkbenchError ? error.status : 500, { error: error.message });
      }
      return;
    }

    if (url.pathname === "/api/folder") {
      // New folder in the right panel's Files tab: inside the selected session's folder only (the
      // page sends a session id and a relative parent, never a full path). Page header required.
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      if (req.headers["x-pi-companion-page"] !== "1") {
        res.writeHead(403).end();
        return;
      }
      try {
        const root = await workspaceRootFor(url.searchParams.get("id") ?? "");
        const body = JSON.parse(await readBody(req));
        sendJson(res, 201, { path: await makeFolder(root, body?.parent ?? "", body?.name) });
      } catch (error) {
        if (error instanceof WorkbenchError) sendJson(res, error.status, { error: error.message });
        else sendJson(res, error instanceof SyntaxError ? 400 : 500, { error: error.message });
      }
      return;
    }

    if (url.pathname === "/api/prompts") {
      // GET: your saved prompts. GET ?suggest=1: messages you typed more than once (from the search
      // index, in memory), not yet saved. POST { prompts } (page header): replace the saved list.
      const clis = new Set(SOURCES.map((source) => source.id));
      try {
        if (req.method === "POST") {
          if (req.headers["x-pi-companion-page"] !== "1") {
            res.writeHead(403).end();
            return;
          }
          const prompts = validatePrompts(JSON.parse(await readBody(req))?.prompts, clis);
          await savePrompts(PROMPTS_FILE, prompts);
          sendJson(res, 200, { prompts });
          return;
        }
        const prompts = await loadPrompts(PROMPTS_FILE, clis);
        if (url.searchParams.get("suggest") !== "1") {
          sendJson(res, 200, { prompts });
          return;
        }
        await refreshSaved();
        const enabled = new Set(SOURCES.filter((source) => source.enabled).map((source) => source.id));
        const metas = [...savedById.values()].filter((meta) => enabled.has(meta.source ?? "pi"));
        const build = searchIndex.updateAll(metas);
        await Promise.race([build, new Promise((done) => setTimeout(done, 1200))]);
        const progress = searchIndex.progress();
        const suggestions = frequentPrompts(searchIndex.userMessages(metas), { saved: prompts.map((p) => p.text) });
        sendJson(res, 200, { prompts, suggestions, indexing: progress.running ? { done: progress.done, total: progress.total } : undefined });
      } catch (error) {
        sendJson(res, error instanceof PromptError || error instanceof SyntaxError ? 400 : 500, { error: error.message });
      }
      return;
    }

    if (url.pathname === "/api/search") {
      // ?q= words and "phrases" (all must be in one message). The first search reads every
      // session file (seconds); later ones only what was added. While reading, partial results
      // come back with { indexing: { done, total } } and the page asks again.
      await refreshSaved();
      const enabled = new Set(SOURCES.filter((source) => source.enabled).map((source) => source.id));
      const metas = [...savedById.values()].filter((meta) => enabled.has(meta.source ?? "pi"));
      const build = searchIndex.updateAll(metas);
      await Promise.race([build, new Promise((done) => setTimeout(done, 1200))]);
      const progress = searchIndex.progress();
      const found = searchIndex.search(metas, url.searchParams.get("q") ?? "");
      sendJson(res, 200, { ...found, indexing: progress.running ? { done: progress.done, total: progress.total } : undefined });
      return;
    }

    if (url.pathname === "/api/handoff") {
      // GET ?id=&format=brief|full: the session as Markdown (a brief another CLI can continue from,
      // or the whole session). POST { id, to } (page header): save the brief in the companion's
      // own handoffs folder and open a terminal in the session's folder running CLI `to` with a
      // fixed prompt to read it. `to` names a CLI; the command comes from its source.
      if (req.method === "POST" && req.headers["x-pi-companion-page"] !== "1") {
        res.writeHead(403).end();
        return;
      }
      try {
        const params = req.method === "POST" ? JSON.parse(await readBody(req)) : Object.fromEntries(url.searchParams);
        const id = String(params.id ?? "");
        if (!sessions.has(id) && !savedById.has(id)) await refreshSaved();
        const where = locate(id);
        const entries = where ? await where.source.readEntries(where.file) : undefined;
        if (!entries) throw new WorkbenchError(404, "no history for that session");
        const transcript = where.source.transcript(entries, { leafId: where.leafId });
        const saved = savedById.get(id);
        const live = sessions.get(id);
        const cwd = live?.cwd ?? saved?.cwd ?? transcript.cwd;
        const title = transcript.name || live?.name || saved?.name || saved?.preview || "session";
        const git = cwd ? await gitFor(cwd).catch(() => undefined) : undefined;
        const meta = { title, cli: where.source.label, assistant: where.source.assistant, cwd, file: where.file, git, model: transcript.model };
        const targets = SOURCES.filter((source) => source.enabled && source.installed).map((source) => ({ id: source.id, label: source.label }));
        if (req.method === "GET") {
          const full = params.format === "full";
          const markdown = full ? sessionMarkdown(transcript, meta) : handoffBrief(transcript, meta);
          sendJson(res, 200, { markdown, filename: full ? handoffFileName(title).replace(/^handoff-/, "session-") : handoffFileName(title), targets });
          return;
        }
        const to = SOURCES.find((source) => source.id === params.to && source.enabled);
        const start = to?.startActions[0]?.command;
        if (!start) throw new LaunchError("That CLI isn't available.");
        if (!cwd) throw new LaunchError("This session has no folder to open.");
        const file = await saveHandoff(join(stateDir(), "handoffs"), handoffFileName(title), handoffBrief(transcript, meta));
        const prompt = `Read the handoff notes in ${file} and continue the work from there.`;
        await openTerminal(await existingDir(cwd), `${start} ${quotePath(prompt)}`);
        sendJson(res, 200, { ok: true, file, opened: to.label });
      } catch (error) {
        const status = error instanceof WorkbenchError ? error.status : error instanceof LaunchError || error instanceof SyntaxError ? 400 : 500;
        sendJson(res, status, { error: error.message });
      }
      return;
    }

    if (url.pathname === "/api/old-sessions") {
      // Cleanup list: saved sessions not used for ?days= (default 30), not running. Read-only:
      // nothing is moved or deleted; the page lists them so you can decide.
      await refreshSaved();
      await tokenUsage.load();
      const days = Math.max(1, Math.min(3650, Number.parseInt(url.searchParams.get("days") ?? "30", 10) || 30));
      const cutoff = Date.now() - days * 86_400_000;
      const running = await runningMap();
      const enabled = new Set(SOURCES.filter((source) => source.enabled).map((source) => source.id));
      const list = [];
      for (const meta of savedById.values()) {
        const source = meta.source ?? "pi";
        if (!enabled.has(source) || sessions.has(meta.id) || running.has(meta.id)) continue;
        if ((meta.mtimeMs ?? 0) > cutoff) continue;
        const usage = tokenUsage.peek(meta.file);
        const t = usage?.tokens;
        list.push({
          id: meta.id,
          source,
          name: meta.name || meta.preview || "",
          cwd: meta.cwd ?? "",
          created: meta.created,
          lastActivity: meta.mtimeMs,
          size: meta.size ?? 0,
          file: meta.file,
          tokens: t ? t.input + t.output + t.cacheRead + t.cacheWrite : undefined,
        });
      }
      list.sort((a, b) => a.lastActivity - b.lastActivity);
      sendJson(res, 200, { days, sessions: list, totalSize: list.reduce((sum, s) => sum + s.size, 0) });
      return;
    }

    if (url.pathname === "/api/git") {
      // Branch and uncommitted changes for the sidebar rows: ?ids=a,b,c (session ids, never paths).
      const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean).slice(0, 40);
      const out = {};
      await Promise.all(
        ids.map(async (id) => {
          try {
            out[id] = (await gitFor(await workspaceRootFor(id))) ?? null;
          } catch {
            out[id] = null;
          }
        }),
      );
      sendJson(res, 200, out);
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

    if (url.pathname === "/api/remote") {
      // GET: phone access state, and whether this request is from the phone. POST (this computer,
      // page header) { enabled, reply }: turn tailscale serve on or off and save remote.json.
      try {
        if (req.method === "POST") {
          if (req.headers["x-pi-companion-page"] !== "1") {
            res.writeHead(403).end();
            return;
          }
          const body = JSON.parse(await readBody(req));
          const wantOn = body.enabled === true;
          const reply = body.reply === true;
          if (wantOn) {
            const me = await serveOn(PORT);
            remote = { enabled: true, reply, host: me.host, login: me.login };
          } else {
            if (remote.enabled) await serveOff(PORT);
            remote = { ...remote, enabled: false, reply };
          }
          await saveRemote(REMOTE_FILE, remote);
        }
        let me = null;
        let error = "";
        if (!who.remote) me = await tailscaleSelf().catch((e) => ((error = e.message), null));
        const on = remote.enabled && (who.remote || (await serving(PORT, remote.host).catch(() => false)));
        sendJson(res, 200, {
          you: { remote: who.remote },
          enabled: remote.enabled,
          serving: Boolean(on),
          reply: remote.reply,
          url: remote.host ? `https://${remote.host}/` : me?.host ? `https://${me.host}/` : "",
          login: remote.login || me?.login || "",
          tailscale: who.remote ? undefined : { installed: !/isn't installed/.test(error), running: Boolean(me?.running), error },
        });
      } catch (error) {
        sendJson(res, error instanceof SyntaxError ? 400 : 500, { error: error.message });
      }
      return;
    }

    if (url.pathname === "/api/shortcut") {
      // GET: is there a "CLI Companion" shortcut in the Start menu / on the desktop. POST (page
      // header) { place: "start"|"desktop", on }: make or remove it. Only this copy's own launcher.
      try {
        if (req.method === "POST") {
          if (req.headers["x-pi-companion-page"] !== "1") {
            res.writeHead(403).end();
            return;
          }
          const body = JSON.parse(await readBody(req));
          if (!PLACES.includes(body.place)) throw new SyntaxError("place must be start or desktop");
          await setShortcut(body.place, body.on === true);
        }
        sendJson(res, 200, await shortcutStatus());
      } catch (error) {
        sendJson(res, error instanceof SyntaxError ? 400 : 500, { error: error.message });
      }
      return;
    }

    if (url.pathname === "/api/settings") {
      // GET: your settings and what they can be set to, re-read if the file was hand-edited.
      // POST (page header): save them — but never over a hand edit the page hasn't seen: the page
      // sends back the stamp (rev) it loaded, and a save with an old stamp gets a 409 instead.
      if (req.method === "POST") {
        if (req.headers["x-pi-companion-page"] !== "1") {
          res.writeHead(403).end();
          return;
        }
        try {
          const body = JSON.parse(await readBody(req));
          const next = validateSettings(body);
          await refreshSettings();
          if (settingsError) {
            sendJson(res, 409, { error: `Not saved: ${settingsError}` });
            return;
          }
          if (body.rev !== settingsRev) {
            sendJson(res, 409, { error: "Settings were changed on disk after this page read them. Reload the page to see the current settings, then make your changes again." });
            return;
          }
          await saveSettings(SETTINGS_FILE, next);
          applySettings(next, await settingsStamp(SETTINGS_FILE));
        } catch (error) {
          sendJson(res, error instanceof SettingsError || error instanceof SyntaxError ? 400 : 500, { error: error.message });
          return;
        }
      } else {
        await refreshSettings();
      }
      sendJson(res, 200, {
        settings,
        rev: settingsRev,
        error: settingsError,
        file: SETTINGS_FILE,
        port: PORT,
        portFromEnv: process.env.CLI_COMPANION_PORT_SET
          ? process.env.CLI_COMPANION_PORT_SET === "1"
          : Boolean(process.env.CLI_COMPANION_PORT || process.env.PI_COMPANION_PORT),
        platform: process.platform,
        terminals: terminalsFor(),
        sshDefault: defaultSshHost(),
        sources: describeSources(SOURCES),
      });
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
          // Headless (no graphical session to open a terminal in): hide Open, say why, and lead
          // with the line that reaches a running tmux session from another computer.
          const headless = isHeadless();
          const options = launchOptions(target);
          const sshHost = settings.sshHost || defaultSshHost();
          if (headless && target.running) {
            const tmux = tmuxSessionOf(target.pid);
            if (tmux) options.unshift(sshAttachOption(tmux, sshHost));
          }
          sendJson(res, 200, {
            cwd: target.cwd,
            canOpen: !headless,
            platform: process.platform,
            ...(headless ? { note: headlessNote(sshHost, { custom: Boolean(settings.sshHost) }) } : {}),
            options,
          });
          return;
        }
        if (isHeadless()) throw new LaunchError(headlessNote(settings.sshHost || defaultSshHost(), { custom: Boolean(settings.sshHost) }));
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
      const metas = [...savedById.values()];
      // Tokens: the first time, every session file is read (can take a while); after that only
      // what was added. Wait a little, then answer with what's done and say it's still reading.
      const scan = tokenUsage.updateAll(metas.filter((meta) => ids.includes(meta.source ?? "pi")));
      await Promise.race([scan, new Promise((done) => setTimeout(done, 1500))]);
      sendJson(res, 200, {
        ...usageSummary(metas, { days, offsetMin, sources: ids }),
        tokens: tokenUsage.summary(metas, { days, offsetMin, sources: ids }),
      });
      return;
    }

    if (url.pathname === "/api/suggest" || url.pathname === "/api/suggest/models") {
      // Suggested replies from a local Ollama model (Settings). Page header required: these
      // run a model, and a cross-site page can't send the header without a preflight.
      if (req.headers["x-pi-companion-page"] !== "1") {
        res.writeHead(403).end();
        return;
      }
      try {
        if (url.pathname === "/api/suggest/models") {
          sendJson(res, 200, { url: OLLAMA_URL, models: await localModels(OLLAMA_URL) });
          return;
        }
        const { enabled, model } = settings.suggest ?? {};
        if (!enabled || !model) {
          sendJson(res, 200, { enabled: false });
          return;
        }
        const id = url.searchParams.get("id") ?? "";
        if (!sessions.has(id) && !savedById.has(id)) await refreshSaved();
        const where = locate(id);
        const entries = where ? await where.source.readEntries(where.file) : undefined;
        if (!entries) {
          sendJson(res, 404, { enabled: true, error: "no history for that session" });
          return;
        }
        const exchange = lastExchange(where.source.transcript(entries, { leafId: where.leafId }).items);
        if (!exchange) {
          sendJson(res, 200, { enabled: true, model, suggestions: [] });
          return;
        }
        const list = await suggestions.get(`${id} ${exchange.id} ${model}`, () =>
          suggestReplies({ baseUrl: OLLAMA_URL, model, exchange }),
        );
        sendJson(res, 200, { enabled: true, model, for: exchange.id, suggestions: list });
      } catch (error) {
        sendJson(res, error instanceof SuggestError ? 502 : 500, { enabled: true, error: error.message });
      }
      return;
    }

    if (url.pathname === "/api/app-file") {
      // A file link in the transcript: where it is inside the session's folder, and how to show it.
      try {
        const id = url.searchParams.get("id") ?? "";
        let path = url.searchParams.get("path") ?? "";
        if (/^file:/i.test(path)) path = fileURLToPath(path);
        const root = await workspaceRootFor(id);
        const rel = root ? await resolveAppFile(root, path) : null;
        if (!rel) throw new WorkbenchError(404, "That file isn't inside this session's folder (or doesn't exist).");
        sendJson(res, 200, {
          kind: "file",
          type: fileKind(rel) ?? null,
          name: rel,
          path: rel,
          url: `/app-files/${encodeURIComponent(id)}/${rel.split("/").map(encodeURIComponent).join("/")}`,
        });
      } catch (error) {
        sendJson(res, error instanceof WorkbenchError ? error.status : 400, { error: error.message });
      }
      return;
    }

    if (url.pathname === "/api/apps") {
      // Apps in the selected session's last exchange (right panel). Page header required: it
      // checks local web addresses, and a cross-site page shouldn't be able to make it do that.
      if (req.headers["x-pi-companion-page"] !== "1") {
        res.writeHead(403).end();
        return;
      }
      try {
        sendJson(res, 200, await appsFor(url.searchParams.get("id") ?? ""));
      } catch (error) {
        sendJson(res, error instanceof WorkbenchError ? error.status : 500, { error: error.message });
      }
      return;
    }

    if (url.pathname.startsWith("/app-files/")) {
      await serveAppFile(req, res, url.pathname);
      return;
    }

    if (url.pathname === "/api/favorites") {
      // Favorite session ids for the sidebar. Changes need the page header; every window hears them.
      if (req.method === "GET") {
        sendJson(res, 200, { favorites: await loadFavorites(FAVORITES_FILE) });
        return;
      }
      if (req.headers["x-pi-companion-page"] !== "1") {
        res.writeHead(403).end();
        return;
      }
      try {
        let favorites;
        if (req.method === "POST") favorites = await addFavorite(FAVORITES_FILE, JSON.parse(await readBody(req))?.id);
        else if (req.method === "DELETE") favorites = await removeFavorite(FAVORITES_FILE, url.searchParams.get("id") ?? "");
        else {
          res.writeHead(405).end();
          return;
        }
        broadcast({ type: "favorites", favorites });
        sendJson(res, 200, { favorites });
      } catch (error) {
        sendJson(res, error instanceof FavoriteError || error instanceof SyntaxError ? 400 : 500, { error: error.message });
      }
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

/**
 * Close the port and exit; with `restart`, first start a fresh server (detached, logging to
 * server.log) once the port is free. Live Pis reconnect on their own; open pages reconnect too.
 */
let shuttingDown = false;
function shutDown(restart) {
  if (shuttingDown) return;
  shuttingDown = true;
  runner.stopAll(); // Terminal tab commands end with the server (their output lives in it)
  console.log(`[companion] ${restart ? "restarting" : "stopping"} on request`);
  setTimeout(async () => {
    for (const client of clients) client.end();
    server.close();
    server.closeAllConnections();
    if (restart) {
      for (let i = 0; i < 20 && (await isPortUp(PORT)); i++) await new Promise((r) => setTimeout(r, 100));
      const result = await ensureServer({ port: PORT, env: process.env });
      if (result.error) console.error(`[companion] restart failed: ${result.error}`);
    }
    // Only if it's still ours: on a restart the fresh server has already written its own.
    removeRuntimeFile();
    process.exit(0);
  }, 100);
}

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`[companion] ${HOST}:${PORT} is already in use; another companion is probably running.`);
    process.exit(2);
  }
  throw error;
});

server.listen(PORT, HOST, () => {
  // Say where this server is (server.json), for Pis and CLIs started without its environment.
  writeRuntimeFile(PORT);
  console.log(`[companion] listening on http://${HOST}:${PORT} (reading: ${SOURCES.filter((source) => source.enabled).map((source) => source.label).join(", ")})`);
});

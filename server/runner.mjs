// The right panel's Terminal tab: runs one command you typed (or put there from a code block)
// in the selected session's folder and keeps its output for the page to read.
//
// Rules:
//   - Off unless Settings → Terminal → "Let the companion run commands" is on (server.mjs checks).
//   - Nothing runs by itself: the page sends a command only when you press Run.
//   - PowerShell on Windows (pwsh, else Windows PowerShell), your login shell elsewhere.
//   - No input: stdin is closed, so a program that waits for typing ends or fails. Interactive
//     programs (codex, pi, ssh, a REPL…) belong in "Open in terminal", a real terminal window.
//   - Output kept in memory only (the last 1 MB per run, the last 20 runs); never written to disk.
//   - Stop ends the whole process tree.

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

export const MAX_COMMAND = 8000;
const MAX_OUTPUT = 1024 * 1024;
const KEEP_RUNS = 20;
const MAX_RUNNING = 4;

/**
 * How to run `command`: { file, args } for spawn() (no extra shell in between).
 * `shell` is the Windows shell to use ("pwsh" or "powershell.exe").
 */
export function runPlan(command, { platform = process.platform, shell = "pwsh", userShell } = {}) {
  if (platform === "win32") {
    // UTF-8 out, so non-English text survives; the command goes in as one -Command argument.
    const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'\n${command}`;
    return { file: shell, args: ["-NoLogo", "-NonInteractive", "-Command", script] };
  }
  return { file: userShell || "/bin/sh", args: ["-lc", command] };
}

/**
 * The same command for a real terminal window, as a PowerShell -EncodedCommand (UTF-16LE,
 * base64): no quoting or ";" problems on the way through Windows Terminal. It shows the
 * command first, so you can see what was run.
 */
export function encodedCommand(command) {
  const shown = `'${String(command).replace(/'/g, "''")}'`;
  const script = `Write-Host ('PS> ' + ${shown}) -ForegroundColor DarkGray\n${command}`;
  return Buffer.from(script, "utf16le").toString("base64");
}

/** Does this look like a program that needs you to type into it while it runs? */
export function looksInteractive(command) {
  const first = String(command).trim().split(/\r?\n/)[0].trim();
  const word = first.split(/\s+/)[0]?.replace(/^&\s*/, "").replace(/^["']|["']$/g, "").toLowerCase() ?? "";
  const name = word.split(/[\\/]/).pop().replace(/\.(cmd|exe|bat|ps1)$/, "");
  if (["codex", "pi", "claude", "ssh", "vim", "nvim", "nano", "less", "more", "top", "htop", "ollama", "psql", "mysql", "sqlite3", "wsl"].includes(name)) {
    // "codex exec …", "ollama list", "pi --version" and the like finish on their own.
    const rest = first.slice(first.indexOf(word) + word.length).trim();
    if (/^(exec|list|ls|ps|pull|show|--version|-v|--help|-h|login|logout|install|update)\b/i.test(rest)) return false;
    return true;
  }
  // A bare REPL: python / node / pwsh with nothing after it.
  return /^(python3?|py|node|pwsh|powershell|bash|sh|zsh|cmd|irb|ghci)(\.exe)?$/i.test(first);
}

/** Kill a process and everything it started. */
function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true }, () => {});
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

export function createRunner({ spawnFn = spawn } = {}) {
  const runs = new Map(); // runId -> run

  function publicRun(run, from = 0) {
    const start = Math.max(0, from - run.dropped);
    return {
      runId: run.id,
      command: run.command,
      cwd: run.cwd,
      sessionId: run.sessionId,
      status: run.status, // running | done | failed | stopped
      exitCode: run.exitCode,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      output: run.output.slice(start),
      next: run.dropped + run.output.length,
      trimmed: run.dropped > 0 && from < run.dropped,
      error: run.error,
    };
  }

  function append(run, text) {
    run.output += text;
    if (run.output.length > MAX_OUTPUT) {
      const cut = run.output.length - MAX_OUTPUT;
      run.output = run.output.slice(cut);
      run.dropped += cut;
    }
  }

  /** Start a command. Returns the run (public shape). Throws Error with a plain message. */
  function start({ command, cwd, sessionId, platform, shell, userShell }) {
    const text = String(command ?? "").replace(/\r\n/g, "\n").trim();
    if (!text) throw new Error("Type a command first.");
    if (text.length > MAX_COMMAND) throw new Error("That command is too long.");
    if ([...runs.values()].filter((r) => r.status === "running").length >= MAX_RUNNING) {
      throw new Error(`${MAX_RUNNING} commands are already running. Stop one first.`);
    }
    const plan = runPlan(text, { platform, shell, userShell });
    const run = {
      id: randomBytes(8).toString("hex"),
      command: text,
      cwd,
      sessionId,
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      output: "",
      dropped: 0,
      error: undefined,
      child: null,
    };
    const child = spawnFn(plan.file, plan.args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32", // its own process group, so Stop ends all of it
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
    });
    run.child = child;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => append(run, chunk));
    child.stderr?.on("data", (chunk) => append(run, chunk));
    child.once("error", (error) => {
      if (run.status !== "running") return;
      run.status = "failed";
      run.error = error.code === "ENOENT" ? `${plan.file} wasn't found.` : error.message;
      run.endedAt = Date.now();
    });
    child.once("close", (code) => {
      if (run.status === "running") run.status = code === 0 ? "done" : "failed";
      run.exitCode = code;
      run.endedAt ??= Date.now();
      run.child = null;
    });
    runs.set(run.id, run);
    // Keep the newest runs only (finished ones go first).
    for (const old of [...runs.values()]) {
      if (runs.size <= KEEP_RUNS) break;
      if (old.status !== "running") runs.delete(old.id);
    }
    return publicRun(run);
  }

  function stop(runId) {
    const run = runs.get(runId);
    if (!run) return undefined;
    if (run.status === "running" && run.child) {
      run.status = "stopped";
      run.endedAt = Date.now();
      killTree(run.child);
    }
    return publicRun(run);
  }

  function read(runId, from = 0) {
    const run = runs.get(runId);
    return run ? publicRun(run, Math.max(0, Number(from) || 0)) : undefined;
  }

  /** Recent runs in one folder, newest first, without their output. */
  function list(cwd) {
    return [...runs.values()]
      .filter((r) => String(r.cwd).toLowerCase() === String(cwd).toLowerCase())
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((r) => ({ ...publicRun(r, Infinity), output: undefined }));
  }

  function stopAll() {
    for (const run of runs.values()) if (run.status === "running" && run.child) killTree(run.child);
  }

  return { start, stop, read, list, stopAll };
}

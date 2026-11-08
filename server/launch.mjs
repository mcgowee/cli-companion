// Open a workspace or saved session in a new terminal, or give the command to paste.
//
// The page never sends a command: it names an action plus a workspace or session the server
// already knows from the session index. The commands come from each CLI source's fixed list
// (server/sources/*.mjs: startActions and resumeCommand); the server starts them with spawn()
// (an argument list, no shell).
//
// Open uses the terminal picked in Settings: on Windows, Windows Terminal (else a PowerShell
// window); on macOS, Terminal or iTerm2 (through osascript); on Linux, the first terminal
// program found. Copy always works. macOS and Linux are less tested than Windows.
//
// Headless (Linux/BSD with no graphical session): Open can't work, so the menu says why and
// offers only the lines to paste over SSH — for a Pi running inside tmux, an attach line.

import { readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";

const SESSION_ID = /^[0-9a-f][0-9a-f-]{7,63}$/i;

export class LaunchError extends Error {}

/** A session id safe to put on a command line (hex and dashes only), or a LaunchError. */
export function checkSessionId(sessionId) {
  if (!SESSION_ID.test(String(sessionId ?? ""))) throw new LaunchError("Bad session id.");
  return String(sessionId);
}

/** The workspace menu: a plain terminal, then the start actions of each CLI that is on and installed. */
export function workspaceActions(sources) {
  return [
    { action: "terminal", label: "Terminal here", command: "" },
    ...sources.filter((s) => s.enabled && s.installed).flatMap((s) => s.startActions),
  ];
}

/** The command for a session's resume action. */
export function resumeCommand(source, sessionId) {
  return source.resumeCommand(checkSessionId(sessionId));
}

/** A shell-quoted path: PowerShell single quotes on Windows, POSIX single quotes elsewhere. */
export function quotePath(path, platform = process.platform) {
  const p = String(path);
  return platform === "win32" ? `'${p.replace(/'/g, "''")}'` : `'${p.replace(/'/g, `'\\''`)}'`;
}

/** The line to paste into a terminal (PowerShell on Windows). */
export function copyLine(cwd, command, platform = process.platform) {
  const cd = `cd ${quotePath(cwd, platform)}`;
  if (!command) return cd;
  return platform === "win32" ? `${cd}; ${command}` : `${cd} && ${command}`;
}

/** Terminals Open can use, per platform, in the order "auto" tries them. */
export const TERMINALS = {
  win32: [
    { id: "wt", label: "Windows Terminal" },
    { id: "console", label: "PowerShell window" },
  ],
  darwin: [
    { id: "terminal", label: "Terminal" },
    { id: "iterm", label: "iTerm2" },
  ],
  linux: [
    { id: "x-terminal-emulator", label: "System default (x-terminal-emulator)" },
    { id: "gnome-terminal", label: "GNOME Terminal" },
    { id: "konsole", label: "Konsole" },
    { id: "xfce4-terminal", label: "Xfce Terminal" },
    { id: "kitty", label: "kitty" },
    { id: "alacritty", label: "Alacritty" },
    { id: "wezterm", label: "WezTerm" },
    { id: "xterm", label: "xterm" },
  ],
};

export function terminalsFor(platform = process.platform) {
  return TERMINALS[platform] ?? TERMINALS.linux;
}

/** A string inside AppleScript double quotes. */
function appleString(text) {
  return `"${String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** One way to open a terminal, or undefined if this terminal id doesn't apply. */
function plan(id, cwd, command, { platform, shell, userShell, encoded }) {
  if (platform === "win32") {
    // encoded: a command you typed, as PowerShell -EncodedCommand (no quoting or ";" trouble).
    const shellArgs = encoded ? ["-NoExit", "-EncodedCommand", encoded] : command ? ["-NoExit", "-Command", command] : ["-NoLogo"];
    if (id === "wt") {
      // Windows Terminal treats ";" in its arguments as a separator between its own commands.
      if (String(cwd).includes(";")) return undefined;
      return { file: "wt.exe", args: ["-w", "new", "-d", cwd, shell, ...shellArgs] };
    }
    // A detached console program gets its own new window.
    if (id === "console") return { file: shell, args: shellArgs, cwd };
    return undefined;
  }
  const line = copyLine(cwd, command, platform);
  if (platform === "darwin") {
    if (id === "terminal") {
      return { file: "osascript", args: ["-e", `tell application "Terminal" to do script ${appleString(line)}`, "-e", 'tell application "Terminal" to activate'] };
    }
    if (id === "iterm") {
      return {
        file: "osascript",
        args: [
          "-e",
          `tell application "iTerm" to tell current session of (create window with default profile) to write text ${appleString(line)}`,
          "-e",
          'tell application "iTerm" to activate',
        ],
      };
    }
    return undefined;
  }
  // Linux and others: a login shell that runs the command, then stays open.
  const sh = userShell || "bash";
  const run = [sh, "-lc", command ? `${command}; exec ${sh}` : `exec ${sh}`];
  switch (id) {
    case "gnome-terminal":
      return { file: id, args: ["--working-directory", cwd, "--", ...run], cwd };
    case "konsole":
      return { file: id, args: ["--workdir", cwd, "-e", ...run], cwd };
    case "xfce4-terminal":
      return { file: id, args: ["--working-directory", cwd, "-x", ...run], cwd };
    case "kitty":
      return { file: id, args: ["--directory", cwd, ...run], cwd };
    case "alacritty":
      return { file: id, args: ["--working-directory", cwd, "-e", ...run], cwd };
    case "wezterm":
      return { file: id, args: ["start", "--cwd", cwd, "--", ...run], cwd };
    case "xterm":
    case "x-terminal-emulator":
      return { file: id, args: ["-e", ...run], cwd };
    default:
      return undefined;
  }
}

/**
 * No window to open one in: Linux (or another non-Windows, non-macOS system) with no graphical
 * session. Windows and macOS always have a desktop, so they never count as headless.
 */
export function isHeadless({ platform = process.platform, env = process.env } = {}) {
  return platform !== "win32" && platform !== "darwin" && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

/**
 * What other machines type after `ssh` to reach this one, when Settings (sshHost) doesn't say:
 * user@hostname, so at least the user is right even if the name needs ~/.ssh/config on the
 * other side.
 */
export function defaultSshHost() {
  try {
    return `${userInfo().username}@${hostname()}`;
  } catch {
    return hostname();
  }
}

/** What the menu says instead of Open buttons on a headless computer. `custom` = sshHost is set. */
export function headlessNote(host = defaultSshHost(), { custom = false } = {}) {
  return `This computer has no graphical terminal, so Open can't work here. Copy a line and paste it into a terminal logged in to ${host} (for example over SSH).${custom ? "" : " If that name isn't how your other computers reach this one, set “SSH name for this computer” in Settings."}`;
}

/**
 * The pid and its parents, nearest first, read from /proc/<pid>/stat (Linux only; [] where
 * /proc isn't available). The chain is capped, and a vanished process ends it quietly.
 */
export function pidAncestry(pid, read = (p) => readFileSync(`/proc/${p}/stat`, "utf8")) {
  const chain = [];
  let current = Number(pid);
  while (Number.isInteger(current) && current > 1 && chain.length < 32) {
    chain.push(current);
    try {
      // "pid (comm) state ppid …" — comm can hold spaces and ")", so parse after the last ")".
      const stat = read(current);
      current = Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(" ")[1]);
    } catch {
      break;
    }
  }
  return chain;
}

/**
 * The tmux session holding a process: `panes` is `tmux list-panes -a -F "#{pane_pid}\t#{session_name}"`
 * output, `ancestry` the process's pid chain (pidAncestry). A pane's pid is the shell tmux
 * started in it, so the CLI running there has it as an ancestor. "" when it isn't in tmux.
 */
export function tmuxSessionFromPanes(panes, ancestry) {
  const byPid = new Map();
  for (const line of String(panes ?? "").split("\n")) {
    const tab = line.indexOf("\t");
    if (tab > 0) byPid.set(Number(line.slice(0, tab)), line.slice(tab + 1));
  }
  for (const pid of ancestry) {
    const name = byPid.get(pid);
    if (name) return name;
  }
  return "";
}

/** The menu entry that reaches a running tmux session from another computer. */
export function sshAttachOption(tmuxSession, host = defaultSshHost()) {
  return {
    action: "ssh-attach",
    label: `Attach over SSH (tmux: ${tmuxSession})`,
    command: "",
    copy: `ssh -t ${host} tmux attach -t ${quotePath(tmuxSession, "linux")}`,
  };
}

/**
 * How to open a terminal in `cwd` running `command` ("" = just a shell): the ways to try, in
 * order, each { file, args, cwd? } for spawn() (no shell). `terminal` is a TERMINALS id, or
 * "auto" to try them all. With a command the window stays open after it ends.
 */
export function openPlan(cwd, command, { platform = process.platform, shell = "pwsh", terminal = "auto", userShell, encoded } = {}) {
  const ids = terminal === "auto" ? terminalsFor(platform).map((t) => t.id) : [terminal];
  const plans = ids.map((id) => plan(id, cwd, command, { platform, shell, userShell, encoded })).filter(Boolean);
  if (!plans.length) {
    if (platform === "win32" && String(cwd).includes(";")) {
      throw new LaunchError("That folder name contains ';', which Windows Terminal can't open. Use Copy.");
    }
    throw new LaunchError("That terminal can't open here. Pick another in Settings, or use Copy.");
  }
  return plans;
}

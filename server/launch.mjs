// Open a workspace or saved session in a new terminal, or give the command to paste.
//
// The page never sends a command: it names an action plus a workspace or session the server
// already knows from the session index. The commands come from each CLI source's fixed list
// (server/sources/*.mjs: startActions and resumeCommand); the server starts them with spawn()
// (an argument list, no shell).
//
// Opening is Windows-only for now (Windows Terminal, else a PowerShell window); elsewhere the
// menu offers Copy only.

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
    ...sources.filter((s) => s.enabled && (s.installed || s.live)).flatMap((s) => s.startActions),
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
function plan(id, cwd, command, { platform, shell, userShell }) {
  if (platform === "win32") {
    const shellArgs = command ? ["-NoExit", "-Command", command] : ["-NoLogo"];
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
 * How to open a terminal in `cwd` running `command` ("" = just a shell): the ways to try, in
 * order, each { file, args, cwd? } for spawn() (no shell). `terminal` is a TERMINALS id, or
 * "auto" to try them all. With a command the window stays open after it ends.
 */
export function openPlan(cwd, command, { platform = process.platform, shell = "pwsh", terminal = "auto", userShell } = {}) {
  const ids = terminal === "auto" ? terminalsFor(platform).map((t) => t.id) : [terminal];
  const plans = ids.map((id) => plan(id, cwd, command, { platform, shell, userShell })).filter(Boolean);
  if (!plans.length) {
    if (platform === "win32" && String(cwd).includes(";")) {
      throw new LaunchError("That folder name contains ';', which Windows Terminal can't open. Use Copy.");
    }
    throw new LaunchError("That terminal can't open here. Pick another in Settings, or use Copy.");
  }
  return plans;
}

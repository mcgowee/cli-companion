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

/**
 * How to open it: Windows Terminal in the folder running PowerShell (with the command, the
 * window stays open after it ends). undefined where opening isn't supported.
 */
export function openPlan(cwd, command, { platform = process.platform, shell = "pwsh" } = {}) {
  if (platform !== "win32") return undefined;
  // Windows Terminal treats ";" in its arguments as a separator between its own commands.
  if (String(cwd).includes(";")) throw new LaunchError("That folder name contains ';', which Windows Terminal can't open. Use Copy.");
  const shellArgs = command ? [shell, "-NoExit", "-Command", command] : [shell, "-NoLogo"];
  return {
    terminal: { file: "wt.exe", args: ["-w", "new", "-d", cwd, ...shellArgs] },
    // No Windows Terminal: a plain console window in the folder.
    fallback: { file: shell, args: command ? ["-NoExit", "-Command", command] : ["-NoLogo"], cwd },
  };
}

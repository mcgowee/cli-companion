// Open a workspace or saved session in a new terminal, or give the command to paste.
//
// The page never sends a command: it names an action from the fixed list below plus a
// workspace or session the server already knows from the session index. The server
// builds the command here and starts it with spawn() (an argument list, no shell).
//
//   workspace actions: terminal, pi, pi-continue, claude
//   session action:    resume (pi --session <id> / claude --resume <id>, in its folder)
//
// Opening is Windows-only for now (Windows Terminal, else a PowerShell window); elsewhere the
// menu offers Copy only.

export const WORKSPACE_ACTIONS = ["terminal", "pi", "pi-continue", "claude"];

const SESSION_ID = /^[0-9a-f][0-9a-f-]{7,63}$/i;

export class LaunchError extends Error {}

/** The CLI command (no cd) for an action, or "" for a plain terminal. */
export function cliCommand(action, { source, sessionId } = {}) {
  switch (action) {
    case "terminal":
      return "";
    case "pi":
      return "pi";
    case "pi-continue":
      return "pi -c";
    case "claude":
      return "claude";
    case "resume":
      if (!SESSION_ID.test(String(sessionId ?? ""))) throw new LaunchError("Bad session id.");
      return source === "claude" ? `claude --resume ${sessionId}` : `pi --session ${sessionId}`;
    default:
      throw new LaunchError("Unknown action.");
  }
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

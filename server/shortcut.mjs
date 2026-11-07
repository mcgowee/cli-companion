// "CLI Companion" shortcut: an app-style launcher that starts the server if needed and opens the
// window, with no terminal. Made or removed only when you ask (Settings → Shortcut, or
// `cli-companion --shortcut`). These are the only files the companion writes outside
// ~/.cli-companion, and it only ever removes the exact files it names here.
//
//   Windows: "CLI Companion.lnk" in the Start menu (and/or on the desktop). It runs this copy's
//            bin/cli-companion.mjs with node through `conhost --headless`, so no console shows.
//   Linux:   cli-companion.desktop in ~/.local/share/applications (and/or ~/Desktop).
//   macOS:   not yet.

import { execFile } from "node:child_process";
import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeBinary } from "./start.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "cli-companion.mjs");
const NAME = "CLI Companion";

export const PLACES = ["start", "desktop"];

function run(file, args, env) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env: { ...process.env, ...env }, windowsHide: true, timeout: 15_000 }, (error, stdout, stderr) =>
      error ? reject(new Error(String(stderr || error.message).trim())) : resolve(String(stdout).trim()),
    );
  });
}

const powershell = (script, env) => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], env);

let desktopDir;
async function windowsDesktop() {
  // The real Desktop folder (it may be redirected to OneDrive).
  desktopDir ??= await powershell("[Environment]::GetFolderPath('Desktop')").catch(() => join(homedir(), "Desktop"));
  return desktopDir;
}

/** Where each shortcut goes on this platform, or null when shortcuts aren't supported. */
export async function shortcutPaths({ platform = process.platform, env = process.env } = {}) {
  if (platform === "win32") {
    const appData = env.APPDATA || join(homedir(), "AppData", "Roaming");
    return {
      start: join(appData, "Microsoft", "Windows", "Start Menu", "Programs", `${NAME}.lnk`),
      desktop: join(await windowsDesktop(), `${NAME}.lnk`),
    };
  }
  if (platform === "linux") {
    const data = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    return { start: join(data, "applications", "cli-companion.desktop"), desktop: join(homedir(), "Desktop", "cli-companion.desktop") };
  }
  return null;
}

/** The Linux .desktop entry. */
export function desktopEntry({ node = nodeBinary(), bin = BIN, icon = join(ROOT, "public", "icon.png") } = {}) {
  const q = (s) => `"${String(s).replace(/(["`$\\])/g, "\\$1")}"`;
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${NAME}`,
    "Comment=Live side window for Pi, Claude Code and Codex",
    `Exec=${q(node)} ${q(bin)}`,
    `Icon=${icon}`,
    "Terminal=false",
    "Categories=Development;",
    "",
  ].join("\n");
}

async function exists(file) {
  return stat(file).then(
    () => true,
    () => false,
  );
}

/** { supported, places: { start: { path, exists }, desktop: { … } } } */
export async function shortcutStatus(opts) {
  const paths = await shortcutPaths(opts);
  if (!paths) return { supported: false, places: {} };
  const places = {};
  for (const place of PLACES) places[place] = { path: paths[place], exists: await exists(paths[place]) };
  return { supported: true, places };
}

/** Make (on) or remove (off) the shortcut in `place` ("start" or "desktop"). Returns its path. */
export async function setShortcut(place, on, opts = {}) {
  if (!PLACES.includes(place)) throw new Error(`unknown place ${place}`);
  const paths = await shortcutPaths(opts);
  if (!paths) throw new Error("Shortcuts aren't supported on this system yet.");
  const file = paths[place];
  if (!on) {
    await rm(file, { force: true });
    return file;
  }
  await mkdir(dirname(file), { recursive: true });
  if ((opts.platform ?? process.platform) === "win32") {
    const system = process.env.SystemRoot || "C:\\Windows";
    await powershell(
      `$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:CC_LNK)
       $s.TargetPath = $env:CC_TARGET
       $s.Arguments = $env:CC_ARGS
       $s.WorkingDirectory = $env:CC_HOME
       $s.IconLocation = $env:CC_ICON + ',0'
       $s.Description = 'Live side window for Pi, Claude Code and Codex'
       $s.WindowStyle = 7
       $s.Save()`,
      {
        CC_LNK: file,
        CC_TARGET: join(system, "System32", "conhost.exe"),
        CC_ARGS: `--headless "${nodeBinary()}" "${BIN}"`,
        CC_HOME: homedir(),
        CC_ICON: join(ROOT, "public", "icon.ico"),
      },
    );
  } else {
    await writeFile(file, desktopEntry());
    await chmod(file, 0o755);
  }
  return file;
}

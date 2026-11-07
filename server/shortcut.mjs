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
import { findAppBrowser, nodeBinary } from "./start.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "cli-companion.mjs");
const NAME = "CLI Companion";

export const PLACES = ["start", "desktop"];

/**
 * The taskbar identity (AppUserModelID) Chrome gives the companion's app window: "Chrome." + the
 * page (host_path, no port) + the profile folder (browser-profile, as Chrome shortens it) + the
 * profile. The Windows shortcut carries the same id, so the window groups under a pinned shortcut
 * and pinning the window pins the shortcut instead of plain Chrome. Read off a live window
 * (Chrome 2026-11); if Chrome changes it, pinning falls back to plain Chrome and nothing else breaks.
 * Edge isn't covered (unknown id), so no id is set when Edge opens the window.
 */
export function windowAppId(browser = findAppBrowser()) {
  return /[\\/]chrome\.exe$/i.test(browser ?? "") ? "Chrome.127.0.0.1_/.browserprole.Default" : "";
}

// Sets System.AppUserModel.ID on a saved .lnk ($env:CC_LNK) to $env:CC_APPID.
const SET_APP_ID = `
if ($env:CC_APPID) { try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CcLnkId {
  [StructLayout(LayoutKind.Sequential, Pack = 4)] public struct PK { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Sequential)] public struct PV { public ushort vt; public ushort a, b, c; public IntPtr p; public IntPtr q; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore { int GetCount(out uint c); int GetAt(uint i, out PK k); int GetValue(ref PK k, out PV v); int SetValue(ref PK k, ref PV v); int Commit(); }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHGetPropertyStoreFromParsingName(string path, IntPtr bc, int flags, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore ps);
  public static void Set(string path, string id) {
    Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    IPropertyStore ps;
    Marshal.ThrowExceptionForHR(SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, 2, ref iid, out ps));
    PK k = new PK { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
    PV v = new PV { vt = 31, p = Marshal.StringToCoTaskMemUni(id) };
    try { Marshal.ThrowExceptionForHR(ps.SetValue(ref k, ref v)); Marshal.ThrowExceptionForHR(ps.Commit()); }
    finally { Marshal.FreeCoTaskMem(v.p); Marshal.ReleaseComObject(ps); }
  }
}
'@
[CcLnkId]::Set($env:CC_LNK, $env:CC_APPID)
} catch { } }`;

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
       $s.Save()
${SET_APP_ID}`,
      {
        CC_LNK: file,
        CC_TARGET: join(system, "System32", "conhost.exe"),
        CC_ARGS: `--headless "${nodeBinary()}" "${BIN}"`,
        CC_HOME: homedir(),
        CC_ICON: join(ROOT, "public", "icon.ico"),
        CC_APPID: windowAppId(),
      },
    );
  } else {
    await writeFile(file, desktopEntry());
    await chmod(file, 0o755);
  }
  return file;
}

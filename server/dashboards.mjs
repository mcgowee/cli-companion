// Custom dashboards for the Dashboards page: a small list of links kept in
// ~/.cli-companion/dashboards.json ({ "dashboards": [{ id, name, url, description, start?, startCwd? }] }).
// You can edit that file by hand too. Only http(s) URLs are accepted.
// `start` is an optional command that starts the dashboard's server (run detached by
// POST /api/dashboards/start when the dashboard is offline; Copy works without running anything).

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

export class DashboardError extends Error {}

export async function loadDashboards(file) {
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    return (Array.isArray(data?.dashboards) ? data.dashboards : [])
      .filter((d) => d && typeof d.url === "string")
      .map((d) => ({
        id: String(d.id ?? d.url),
        name: String(d.name ?? d.url),
        url: d.url,
        description: String(d.description ?? ""),
        ...(typeof d.start === "string" && d.start.trim() ? { start: d.start.trim() } : {}),
        ...(typeof d.startCwd === "string" && d.startCwd.trim() ? { startCwd: d.startCwd.trim() } : {}),
      }));
  } catch {
    return [];
  }
}

async function save(file, dashboards) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ dashboards }, null, 2)}\n`);
  await rename(tmp, file);
}

/** Check and normalise what the page sent; throws DashboardError with a readable message. */
export function validateDashboard(input) {
  const name = String(input?.name ?? "").trim();
  const description = String(input?.description ?? "").trim();
  let url;
  try {
    url = new URL(String(input?.url ?? "").trim());
  } catch {
    throw new DashboardError("That address isn't a valid URL (for example http://127.0.0.1:30142).");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new DashboardError("Only http:// and https:// addresses work.");
  if (!name) throw new DashboardError("Give the dashboard a name.");
  if (name.length > 80 || description.length > 300) throw new DashboardError("Name or description is too long.");
  return { name, url: url.href, description, ...validateStart(input) };
}

export const MAX_START = 2000;

/** The optional start command and its folder; empty means none. */
export function validateStart(input) {
  const start = String(input?.start ?? "").trim();
  const startCwd = String(input?.startCwd ?? "").trim();
  if (start.length > MAX_START) throw new DashboardError("The start command is too long.");
  if (/[\r\n]/.test(start)) throw new DashboardError("Put the start command on one line (join steps with ; or &&).");
  if (startCwd && !isAbsolute(startCwd)) throw new DashboardError("The start folder must be a full path.");
  if (startCwd && !start) throw new DashboardError("A start folder needs a start command.");
  return { ...(start ? { start } : {}), ...(startCwd ? { startCwd } : {}) };
}

export async function addDashboard(file, input) {
  const entry = { id: randomUUID(), ...validateDashboard(input) };
  const list = await loadDashboards(file);
  list.push(entry);
  await save(file, list);
  return entry;
}

/** Change a dashboard's start command and folder (empty clears them). Null when the id is unknown. */
export async function setDashboardStart(file, id, input) {
  const start = validateStart(input);
  const list = await loadDashboards(file);
  const i = list.findIndex((d) => d.id === id);
  if (i < 0) return null;
  const { start: _s, startCwd: _c, ...rest } = list[i];
  list[i] = { ...rest, ...start };
  await save(file, list);
  return list[i];
}

export async function removeDashboard(file, id) {
  const list = await loadDashboards(file);
  const kept = list.filter((d) => d.id !== id);
  if (kept.length === list.length) return false;
  await save(file, kept);
  return true;
}

/** Only addresses on this computer are checked for "online", so the server never calls out. */
export function isLoopbackUrl(href) {
  try {
    const host = new URL(href).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

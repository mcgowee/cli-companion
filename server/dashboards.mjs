// Custom dashboards for the Dashboards page: a small list of links kept in
// ~/.pi/agent/companion/dashboards.json ({ "dashboards": [{ id, name, url, description }] }).
// You can edit that file by hand too. Only http(s) URLs are accepted.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class DashboardError extends Error {}

export async function loadDashboards(file) {
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    return (Array.isArray(data?.dashboards) ? data.dashboards : [])
      .filter((d) => d && typeof d.url === "string")
      .map((d) => ({ id: String(d.id ?? d.url), name: String(d.name ?? d.url), url: d.url, description: String(d.description ?? "") }));
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
  return { name, url: url.href, description };
}

export async function addDashboard(file, input) {
  const entry = { id: randomUUID(), ...validateDashboard(input) };
  const list = await loadDashboards(file);
  list.push(entry);
  await save(file, list);
  return entry;
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

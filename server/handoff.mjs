// Handoff between CLIs: turn a session's transcript into Markdown, either the whole session or a
// short brief another CLI can pick the work up from. No model: the brief is assembled from the
// session itself (where it started, the latest exchange, recent messages, files touched, git).
//
// Handoff files (for "Continue in …") are the companion's own, in ~/.cli-companion/handoffs; only
// the newest few are kept. They hold session text, written only when you ask for a handoff.

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const KEEP_FILES = 20;

function clip(text, max) {
  const t = String(text ?? "").trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}\n… (cut, ${t.length - max} more characters)` : t;
}

function oneLine(text, max) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
}

/** Files a session wrote or edited, from its tool calls (newest last, no repeats). */
export function touchedFiles(items) {
  const files = [];
  const add = (path) => {
    const p = String(path ?? "").trim();
    if (!p || p.length > 400) return;
    const at = files.indexOf(p);
    if (at >= 0) files.splice(at, 1);
    files.push(p);
  };
  for (const item of items ?? []) {
    if (item.kind === "compaction") for (const f of item.modifiedFiles ?? []) add(f);
    for (const call of item.toolCalls ?? []) {
      if (!/edit|write|patch|create|notebook/i.test(call.name ?? "")) continue;
      const args = typeof call.args === "string" ? call.args : JSON.stringify(call.args ?? {});
      for (const m of args.matchAll(/"(?:file_path|path|filePath|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)+)"/g)) {
        try {
          add(JSON.parse(`"${m[1]}"`));
        } catch {
          add(m[1]);
        }
      }
      for (const m of args.matchAll(/\*\*\* (?:Update|Add|Delete) File: ([^\n\\]+)/g)) add(m[1]);
    }
  }
  return files;
}

function gitLine(git) {
  if (!git) return "";
  const changes = git.changed || git.untracked ? `${git.changed} changed and ${git.untracked} untracked files uncommitted (+${git.added} −${git.removed} lines)` : "nothing uncommitted";
  const ahead = git.ahead ? `, ${git.ahead} commit${git.ahead === 1 ? "" : "s"} not pushed` : "";
  return `Git: branch \`${git.branch}\`${ahead}; ${changes}.`;
}

/**
 * A brief another CLI can continue from.
 * @param transcript { items } from a source's transcript()
 * @param meta { title, cli, assistant, cwd, id, file, git }
 */
export function handoffBrief(transcript, meta, { now = new Date() } = {}) {
  const items = (transcript?.items ?? []).filter((i) => !i.compacted || i.kind === "compaction");
  const talk = items.filter((i) => (i.kind === "user" || i.kind === "assistant") && String(i.text ?? "").trim());
  const firstUser = talk.find((i) => i.kind === "user");
  const lastUserAt = talk.map((i) => i.kind).lastIndexOf("user");
  const latest = lastUserAt >= 0 ? talk.slice(lastUserAt) : talk.slice(-1);
  const before = talk.slice(Math.max(0, (lastUserAt >= 0 ? lastUserAt : talk.length) - 10), lastUserAt >= 0 ? lastUserAt : talk.length);
  const summary = [...items].reverse().find((i) => i.kind === "compaction" && i.summary);
  const files = touchedFiles(transcript?.items).slice(-25);
  const who = (i) => (i.kind === "user" ? "You" : meta.assistant || "Assistant");

  const parts = [
    `# Handoff: ${meta.title || "session"}`,
    "",
    `Picked up from a **${meta.cli}** session${meta.cwd ? ` in \`${meta.cwd}\`` : ""}, ${now.toISOString().slice(0, 16).replace("T", " ")} UTC.`,
    gitLine(meta.git),
    meta.file ? `Full transcript (JSONL, read it if you need more): \`${meta.file}\`` : "",
    "",
    "## Where it started",
    "",
    firstUser ? clip(firstUser.text, 1500) : "(no message from the user yet)",
  ];
  if (summary) parts.push("", "## Summary from the last compaction", "", clip(summary.summary, 4000));
  if (before.length) {
    parts.push("", "## Recent conversation (oldest first)", "");
    for (const i of before) parts.push(`- **${who(i)}:** ${oneLine(i.text, 300)}`);
  }
  if (latest.length) {
    parts.push("", "## Latest exchange", "");
    for (const i of latest) parts.push(`**${who(i)}:**`, "", clip(i.text, i.kind === "user" ? 2500 : 4000), "");
  }
  if (files.length) {
    parts.push("", "## Files written or edited", "");
    for (const f of files) parts.push(`- \`${f}\``);
  }
  parts.push(
    "",
    "## To continue",
    "",
    "Read this brief, check the files above as needed, and carry on from the latest exchange. Ask if anything is unclear before changing code.",
  );
  return `${parts.filter((p, i, all) => !(p === "" && all[i - 1] === "")).join("\n").trim()}\n`;
}

/** The whole session as Markdown (messages and tool calls; tool output left out). */
export function sessionMarkdown(transcript, meta) {
  const parts = [`# ${meta.title || "Session"}`, "", `${meta.cli}${meta.cwd ? ` · \`${meta.cwd}\`` : ""}${meta.model ? ` · ${meta.model}` : ""}`, ""];
  for (const item of transcript?.items ?? []) {
    const when = item.timestamp ? ` · ${String(item.timestamp).slice(0, 16).replace("T", " ")}` : "";
    if (item.kind === "user" && item.text) parts.push(`## You${when}`, "", item.text.trim(), "");
    else if (item.kind === "assistant") {
      if (!item.text && !item.toolCalls?.length) continue;
      parts.push(`## ${meta.assistant || "Assistant"}${when}`, "");
      if (item.text) parts.push(item.text.trim(), "");
      for (const call of item.toolCalls ?? []) parts.push(`- tool \`${call.name}\`: ${oneLine(typeof call.args === "string" ? call.args : JSON.stringify(call.args), 200)}`);
      if (item.toolCalls?.length) parts.push("");
    } else if (item.kind === "compaction") parts.push("## Compaction summary", "", clip(item.summary, 20_000), "");
  }
  return `${parts.join("\n").trim()}\n`;
}

/** A file name from a title: "handoff-2026-11-07-1530-fix-the-build.md". */
export function handoffFileName(title, now = new Date()) {
  const slug = String(title ?? "session").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "session";
  return `handoff-${now.toISOString().slice(0, 16).replace(/[T:]/g, "-")}-${slug}.md`;
}

/** Write a handoff file into `dir`, keeping only the newest few. Returns its path. */
export async function saveHandoff(dir, name, markdown) {
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(file, markdown);
  const old = (await readdir(dir)).filter((n) => /^handoff-.*\.md$/.test(n)).sort().reverse().slice(KEEP_FILES);
  await Promise.all(old.map((n) => rm(join(dir, n), { force: true })));
  return file;
}

// Hand off (session header): continue the selected session's work in another CLI, or take it
// out as Markdown. The server builds the text (/api/handoff); nothing is sent anywhere.
//   Copy handoff brief        → clipboard, to paste into any CLI or chat
//   Continue in Pi / …        → saves the brief in ~/.cli-companion/handoffs and opens a terminal
//                               in the session's folder running that CLI, told to read it
//   Download brief / session  → a .md file
(function () {
  const esc = window.escapeHtml;
  const $ = (id) => document.getElementById(id);
  const button = $("handoff-btn");
  const menu = $("handoff-menu");
  if (!button || !menu) return;
  let targets = null;

  const selected = () => window.companionApp?.selectedId();

  async function getMarkdown(format) {
    const res = await fetch(`/api/handoff?id=${encodeURIComponent(selected())}&format=${format}`, { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    targets = data.targets;
    return data;
  }

  function note(text, kind = "") {
    const el = menu.querySelector(".handoff-note");
    if (el) {
      el.textContent = text;
      el.dataset.kind = kind;
    }
  }

  function render() {
    const id = selected();
    const from = id ? cliSources.forId(id) : null;
    const list = (targets ?? cliSources.list?.() ?? []).filter((t) => t.enabled !== false);
    menu.innerHTML = `<div class="u-head">Hand off<span>${esc(from?.label ?? "")}</span></div>
      <button class="hm-item" type="button" data-do="copy"><b>Copy handoff brief</b><small>Where it started, the latest exchange, recent messages, files touched, git. Paste it into any CLI.</small></button>
      ${list
        .map(
          (t) => `<button class="hm-item" type="button" data-do="continue" data-to="${esc(t.id)}"><b>Continue in ${esc(t.label)}</b>
          <small>Opens a terminal in this folder running ${esc(t.label)}, told to read the brief${t.id === from?.id ? " (a fresh session)" : ""}.</small></button>`,
        )
        .join("")}
      <div class="hm-row">
        <button class="btn small" type="button" data-do="download-brief">Download brief</button>
        <button class="btn small" type="button" data-do="download-full">Download whole session</button>
      </div>
      <p class="handoff-note" role="status" aria-live="polite"></p>`;
  }

  function download(markdown, filename) {
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function act(what, to) {
    try {
      if (what === "copy") {
        note("Building the brief…");
        const { markdown } = await getMarkdown("brief");
        await navigator.clipboard.writeText(markdown);
        note(`Copied ✓ (${markdown.length.toLocaleString()} characters). Paste it into the CLI you're moving to.`, "ok");
      } else if (what === "download-brief" || what === "download-full") {
        const { markdown, filename } = await getMarkdown(what === "download-full" ? "full" : "brief");
        download(markdown, filename);
        note(`Downloaded ${filename}.`, "ok");
      } else if (what === "continue") {
        note("Opening a terminal…");
        const res = await fetch("/api/handoff", {
          method: "POST",
          headers: { "content-type": "application/json", "x-pi-companion-page": "1" },
          body: JSON.stringify({ id: selected(), to }),
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
        note(`Opened ${out.opened} with the brief (${out.file}).`, "ok");
      }
    } catch (error) {
      note(error.message, "error");
    }
  }

  function close(focus) {
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (focus) button.focus();
  }

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!menu.hidden) return close(false);
    render();
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    const r = button.getBoundingClientRect();
    menu.classList.toggle("align-left", r.right - menu.offsetWidth < $("topbar").getBoundingClientRect().left + 8);
    menu.querySelector(".hm-item")?.focus();
  });
  menu.addEventListener("click", (event) => {
    event.stopPropagation();
    const b = event.target.closest("[data-do]");
    if (b) void act(b.dataset.do, b.dataset.to);
  });
  document.addEventListener("click", () => {
    if (!menu.hidden) close(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) close(true);
  });

  /** For the command palette. */
  window.handoff = {
    copy: () => act("copy"),
    continueIn: (to) => act("continue", to),
    open: () => setTimeout(() => menu.hidden && selected() && button.click(), 0),
  };
})();

// Saved prompts (composer → Prompts, and Ctrl+K): click one to put it in the composer, where you
// can edit it before sending. Prompts for every CLI, or just one, are kept by the server in
// ~/.cli-companion/prompts.json. Manage adds, edits, reorders and removes them, saves the
// composer's text as a prompt, and offers messages you typed more than once ("From your
// history"); nothing is saved until you choose. On the phone the list is read-only.
(function () {
  const esc = window.escapeHtml;
  const $ = (id) => document.getElementById(id);
  const button = $("prompts-open");
  const pop = $("prompts-pop");
  if (!button || !pop) return;

  const state = {
    prompts: [],
    loaded: false,
    manage: false,
    editing: null, // { index (or -1 for new), text, label, cli }
    suggestions: null, // null = not asked yet
    suggestNote: "",
    note: { text: "", kind: "" },
    busy: false,
  };

  const remote = () => document.documentElement.classList.contains("remote-view");
  const currentCli = () => {
    const id = window.companionApp?.selectedId();
    return id ? cliSources.forId(id)?.id : "";
  };
  const forHere = (p) => !p.cli || p.cli === currentCli();
  const title = (p) => p.label || p.text.split("\n")[0];
  const cliLabel = (id) => (id ? (cliSources.list().find((s) => s.id === id)?.label ?? id) : "All CLIs");

  async function load() {
    try {
      const res = await fetch("/api/prompts", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) state.prompts = data.prompts ?? [];
    } catch {
      // keep what we have
    }
    state.loaded = true;
  }

  async function save(next, okText) {
    state.busy = true;
    render();
    try {
      const res = await fetch("/api/prompts", {
        method: "POST",
        headers: { "content-type": "application/json", "x-pi-companion-page": "1" },
        body: JSON.stringify({ prompts: next }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
      state.prompts = out.prompts;
      state.note = { text: okText, kind: "ok" };
      if (state.suggestions) {
        const saved = new Set(state.prompts.map((p) => p.text.trim().toLowerCase()));
        state.suggestions = state.suggestions.filter((s) => !saved.has(s.text.trim().toLowerCase()));
      }
      state.busy = false;
      return true;
    } catch (error) {
      state.note = { text: error.message, kind: "error" };
      state.busy = false;
      return false;
    } finally {
      render();
    }
  }

  async function loadSuggestions() {
    state.suggestNote = "Looking through your sessions…";
    render();
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch("/api/prompts?suggest=1", { cache: "no-store" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        state.suggestions = data.suggestions ?? [];
        if (!data.indexing) {
          state.suggestNote = state.suggestions.length ? "" : "Nothing you typed more than once yet.";
          break;
        }
        state.suggestNote = `Reading sessions… ${data.indexing.done} of ${data.indexing.total}`;
      } catch (error) {
        state.suggestNote = error.message;
        break;
      }
      if (pop.hidden) return;
      render();
      await new Promise((r) => setTimeout(r, 1500));
    }
    render();
  }

  function editorHtml() {
    const e = state.editing;
    const clis = [["", "All CLIs"], ...cliSources.list().map((s) => [s.id, s.label])];
    return `<form class="pr-edit" data-pr-form>
      <textarea name="text" rows="4" placeholder="The prompt" aria-label="Prompt text" required>${esc(e.text)}</textarea>
      <div class="pr-edit-row">
        <input name="label" value="${esc(e.label)}" placeholder="Short name (optional)" aria-label="Short name" maxlength="60">
        <select name="cli" aria-label="Which CLI">${clis.map(([id, label]) => `<option value="${esc(id)}" ${id === e.cli ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>
      </div>
      <div class="pr-edit-row end">
        <button class="btn small" type="button" data-pr="cancel">Cancel</button>
        <button class="btn small primary" type="submit" ${state.busy ? "disabled" : ""}>${e.index < 0 ? "Save prompt" : "Save changes"}</button>
      </div>
    </form>`;
  }

  function listHtml() {
    const shown = state.manage ? state.prompts.map((p, i) => [p, i]) : state.prompts.map((p, i) => [p, i]).filter(([p]) => forHere(p));
    if (!state.loaded) return `<p class="pr-empty">Loading…</p>`;
    if (!shown.length) {
      return `<p class="pr-empty">${state.prompts.length ? "No saved prompts for this CLI." : "No saved prompts yet."}${remote() ? "" : " Use <b>Manage</b> to add some, or save what's in the composer."}</p>`;
    }
    return `<div class="pr-list" role="${state.manage ? "list" : "menu"}">${shown
      .map(([p, i]) => {
        const tag = p.cli ? `<span class="pr-tag">${esc(cliLabel(p.cli))}</span>` : "";
        if (!state.manage) {
          return `<button class="pr-item" type="button" role="menuitem" data-pr-use="${i}" title="${esc(p.text)}"><span class="pr-title">${esc(title(p))}</span>${tag}</button>`;
        }
        return `<div class="pr-row" role="listitem"><span class="pr-title" title="${esc(p.text)}">${esc(title(p))}</span>${tag}
          <span class="pr-tools">
            <button class="mini" type="button" data-pr-up="${i}" ${i === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
            <button class="mini" type="button" data-pr-down="${i}" ${i === state.prompts.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
            <button class="mini" type="button" data-pr-edit="${i}">Edit</button>
            <button class="mini" type="button" data-pr-del="${i}">Remove</button>
          </span></div>`;
      })
      .join("")}</div>`;
  }

  function suggestionsHtml() {
    if (!state.manage) return "";
    const list = state.suggestions ?? [];
    return `<div class="pr-sugg">
      <div class="pr-sub">From your history <small>messages you typed more than once</small></div>
      ${
        state.suggestions === null
          ? `<button class="btn small" type="button" data-pr="suggest">Show suggestions</button>`
          : list
              .map(
                (s, i) => `<div class="pr-row"><span class="pr-title" title="${esc(s.text)}">${esc(s.text.split("\n")[0])}</span>
                <span class="pr-count">${s.count}×</span>
                <span class="pr-tools"><button class="mini" type="button" data-pr-take="${i}">Save</button></span></div>`,
              )
              .join("")
      }
      ${state.suggestNote ? `<p class="pr-empty">${esc(state.suggestNote)}</p>` : ""}
    </div>`;
  }

  function render() {
    const draft = $("composer-text")?.value.trim() ?? "";
    const canManage = !remote();
    pop.innerHTML = `<div class="pr-head"><b>${state.manage ? "Manage prompts" : "Prompts"}</b>
        <span class="pr-head-tools">
          ${canManage && !state.manage && draft ? `<button class="mini" type="button" data-pr="save-draft">Save composer text</button>` : ""}
          ${canManage ? `<button class="mini" type="button" data-pr="manage">${state.manage ? "Done" : "Manage"}</button>` : ""}
        </span></div>
      ${state.editing ? editorHtml() : ""}
      ${listHtml()}
      ${state.manage && !state.editing ? `<button class="btn small pr-add" type="button" data-pr="new">+ New prompt</button>` : ""}
      ${suggestionsHtml()}
      <p class="pr-note ${esc(state.note.kind)}" role="status">${esc(state.note.text)}</p>`;
    pop.querySelector("[data-pr-form] textarea")?.focus();
  }

  function startEdit(index, preset) {
    const p = index >= 0 ? state.prompts[index] : { text: "", label: "", cli: "", ...preset };
    state.editing = { index, text: p.text, label: p.label, cli: p.cli };
    state.note = { text: "", kind: "" };
    render();
  }

  function use(index) {
    const p = state.prompts[index];
    if (!p) return;
    close(false);
    window.composer?.insert(p.text);
  }

  function move(index, by) {
    const next = [...state.prompts];
    const [p] = next.splice(index, 1);
    next.splice(index + by, 0, p);
    void save(next, "Moved ✓");
  }

  pop.addEventListener("click", (event) => {
    event.stopPropagation();
    const t = event.target.closest("button");
    if (!t) return;
    const d = t.dataset;
    if (d.prUse !== undefined) return use(Number(d.prUse));
    if (d.prUp !== undefined) return move(Number(d.prUp), -1);
    if (d.prDown !== undefined) return move(Number(d.prDown), 1);
    if (d.prEdit !== undefined) return startEdit(Number(d.prEdit));
    if (d.prDel !== undefined) {
      const i = Number(d.prDel);
      return void save(state.prompts.filter((_, j) => j !== i), "Removed ✓");
    }
    if (d.prTake !== undefined) {
      const s = state.suggestions[Number(d.prTake)];
      return void save([...state.prompts, { text: s.text, label: "", cli: "" }], "Saved ✓ (for all CLIs; Edit to change)");
    }
    if (d.pr === "manage") {
      state.manage = !state.manage;
      state.editing = null;
      state.note = { text: "", kind: "" };
      return render();
    }
    if (d.pr === "new") return startEdit(-1, { cli: "" });
    if (d.pr === "save-draft") {
      state.manage = true;
      return startEdit(-1, { text: $("composer-text").value.trim(), cli: "" });
    }
    if (d.pr === "cancel") {
      state.editing = null;
      return render();
    }
    if (d.pr === "suggest") return void loadSuggestions();
  });

  pop.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    const e = state.editing;
    const item = { text: form.text.value, label: form.label.value, cli: form.cli.value };
    const next = [...state.prompts];
    if (e.index < 0) next.push(item);
    else next[e.index] = { ...next[e.index], ...item };
    if (await save(next, e.index < 0 ? "Saved ✓" : "Changed ✓")) {
      state.editing = null;
      render();
    }
  });

  function open() {
    state.note = { text: "", kind: "" };
    pop.hidden = false;
    button.setAttribute("aria-expanded", "true");
    render();
    void load().then(render);
    pop.querySelector(".pr-item, button")?.focus();
  }

  function close(focus) {
    pop.hidden = true;
    state.editing = null;
    state.manage = false;
    button.setAttribute("aria-expanded", "false");
    if (focus) button.focus();
  }

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (pop.hidden) open();
    else close(false);
  });
  document.addEventListener("click", (event) => {
    if (!pop.hidden && !pop.contains(event.target)) close(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !pop.hidden) close(true);
  });

  void load();

  /** For the command palette: the prompts that apply to the selected session's CLI. */
  window.companionPrompts = {
    forPalette: () => state.prompts.filter(forHere).map((p) => ({ label: title(p), hint: p.cli ? cliLabel(p.cli) : "prompt", text: p.text })),
    insert: (text) => window.composer?.insert(text),
    refresh: load,
  };
})();

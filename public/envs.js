// Environments (like the Claude Code desktop app's environment picker): the bar at the bottom
// of the sidebar shows the picked one, with New session to start Pi there. Clicking the bar, or
// the "Workspaces" box at the top, opens the picker: search, Local and SSH groups, a check on the
// picked one, × to remove one, and + New environment (a name, then a folder on this computer, or
// an SSH computer and a folder there).
// The page names an environment id; the server builds what runs (server/envs.mjs). Never from
// the phone.
(function () {
  const esc = window.escapeHtml;
  const bar = document.getElementById("env-bar");
  const pickBtn = document.getElementById("env-pick");
  const newBtn = document.getElementById("env-new-session");
  const msgEl = document.getElementById("env-msg");
  const topBtn = document.querySelector('.nav-item[data-view="workspaces"]');
  if (!bar || !pickBtn || !newBtn) return;

  const page = { "x-pi-companion-page": "1" };
  const json = { "content-type": "application/json", ...page };
  const st = { data: null, q: "", form: null, error: "" };

  const menu = document.createElement("div");
  menu.className = "launch-menu env-menu";
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", "Environments");
  menu.hidden = true;
  document.body.append(menu);
  let anchor = pickBtn;

  const current = () => st.data?.envs.find((e) => e.id === st.data.current);
  const sub = (e) => (e.kind === "ssh" ? `${e.host}${e.path === "~" ? "" : ` · ${e.path}`}` : e.path);

  function renderBar() {
    const e = current();
    pickBtn.querySelector(".env-name").textContent = e ? e.name : "This computer";
    pickBtn.querySelector(".env-kind").textContent = e?.kind === "ssh" ? "SSH" : "Local";
    pickBtn.title = e ? `${e.name}: ${sub(e)}\nClick to pick another environment` : "Pick an environment";
    newBtn.title = e ? `Start Pi in ${e.name} (${sub(e)})${e.kind === "ssh" ? ", in a tmux session there" : ""}` : "Start Pi";
    newBtn.disabled = st.data?.canOpen === false;
  }

  async function load() {
    try {
      const res = await fetch("/api/envs", { cache: "no-store" });
      if (res.ok) st.data = await res.json();
    } catch {
      // Server restarting: the "envs" message or the next click loads it.
    }
    renderBar();
    if (!menu.hidden) render();
  }

  function say(text, kind = "") {
    msgEl.textContent = text;
    msgEl.className = `env-msg ${kind}`;
    clearTimeout(say.timer);
    if (text && kind !== "error") say.timer = setTimeout(() => say(""), 6000);
  }

  function place() {
    const r = anchor.getBoundingClientRect();
    menu.style.left = "0px";
    menu.style.top = "0px";
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    const left = Math.min(Math.max(8, r.left), innerWidth - w - 8);
    // Above the bar at the bottom; below the Workspaces box at the top.
    const top = anchor === pickBtn ? r.top - h - 6 : r.bottom + 4;
    menu.style.left = `${left}px`;
    menu.style.top = `${Math.max(8, Math.min(top, innerHeight - h - 8))}px`;
  }

  function itemHtml(e) {
    const picked = e.id === st.data.current;
    return `<div class="env-item${picked ? " picked" : ""}">
      <button type="button" class="env-choose" data-pick="${esc(e.id)}" role="option" aria-selected="${picked}">
        <span class="env-text"><span class="env-iname">${esc(e.name)}</span><span class="env-sub">${esc(sub(e))}</span></span>
        ${picked ? `<svg class="env-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>` : ""}
      </button>
      ${e.id === "local" ? "" : `<button type="button" class="mini env-remove" data-remove="${esc(e.id)}" aria-label="${esc(`Remove ${e.name}`)}" title="Remove (nothing on disk is touched)">×</button>`}
    </div>`;
  }

  function formHtml() {
    const f = st.form;
    return `<form class="env-form" data-env-form autocomplete="off">
      <div class="env-form-head">New environment</div>
      <label>Name <input name="name" maxlength="60" required value="${esc(f.name ?? "")}" placeholder="${f.kind === "ssh" ? "Aegis SSH charloop" : "charloop"}"></label>
      <div class="env-kinds" role="radiogroup" aria-label="Where">
        <label><input type="radio" name="kind" value="local"${f.kind === "local" ? " checked" : ""}> This computer</label>
        <label><input type="radio" name="kind" value="ssh"${f.kind === "ssh" ? " checked" : ""}> SSH</label>
      </div>
      ${
        f.kind === "ssh"
          ? `<label>Computer <input name="host" required value="${esc(f.host ?? "")}" placeholder="What you type after ssh, e.g. aegis"></label>
             <label>Folder there <input name="path" value="${esc(f.path ?? "")}" placeholder="~ (home), ~/projects/pi/charloop, or /full/path"></label>
             <p class="env-hint">It must log in without asking for a password. New session opens Pi in a tmux session named after the folder.</p>`
          : `<label>Folder <input name="path" required value="${esc(f.path ?? "")}" placeholder="Full path, e.g. C:\\AI\\pi\\charloop"></label>`
      }
      <div class="env-form-foot">
        <span class="env-form-msg error" role="status">${esc(st.error)}</span>
        <button type="button" class="btn small" data-cancel>Cancel</button>
        <button type="submit" class="btn primary small">Add</button>
      </div>
    </form>`;
  }

  function render() {
    if (!st.data) {
      menu.innerHTML = `<div class="launch-msg">Loading…</div>`;
      return;
    }
    if (st.form) {
      menu.innerHTML = formHtml();
      menu.querySelector(st.form.focus ? `[name="${st.form.focus}"]` : '[name="name"]')?.focus();
      return;
    }
    const q = st.q.trim().toLowerCase();
    const match = (e) => !q || `${e.name} ${sub(e)}`.toLowerCase().includes(q);
    const local = st.data.envs.filter((e) => e.kind === "local" && match(e));
    const ssh = st.data.envs.filter((e) => e.kind === "ssh" && match(e));
    menu.innerHTML = `<input class="env-search" type="search" value="${esc(st.q)}" placeholder="Search environments" aria-label="Search environments" spellcheck="false">
      <div class="env-list" role="listbox" aria-label="Environments">
        ${local.length ? `<div class="env-group">Local</div>${local.map(itemHtml).join("")}` : ""}
        ${ssh.length ? `<div class="env-group">SSH</div>${ssh.map(itemHtml).join("")}` : ""}
        ${!local.length && !ssh.length ? `<div class="launch-msg">No environment matches.</div>` : ""}
      </div>
      <button type="button" class="env-add" data-new>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg> New environment
      </button>`;
  }

  function open(from) {
    anchor = from;
    st.q = "";
    st.form = null;
    st.error = "";
    menu.hidden = false;
    from.classList.add("open");
    render();
    place();
    menu.querySelector(".env-search")?.focus();
    void load().then(() => {
      if (!menu.hidden) {
        render();
        place();
        menu.querySelector(".env-search")?.focus();
      }
    });
  }

  function close() {
    menu.hidden = true;
    pickBtn.classList.remove("open");
    topBtn?.classList.remove("open");
  }

  async function send(url, method, body) {
    const res = await fetch(url, { method, headers: body ? json : page, body: body ? JSON.stringify(body) : undefined });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
    return out;
  }

  pickBtn.addEventListener("click", () => (menu.hidden || anchor !== pickBtn ? open(pickBtn) : close()));
  topBtn?.setAttribute("aria-haspopup", "dialog");
  if (topBtn) topBtn.title = "Environments: pick where New session starts Pi, or add one";
  topBtn?.addEventListener("click", (event) => {
    event.preventDefault();
    if (menu.hidden || anchor !== topBtn) open(topBtn);
    else close();
  });

  newBtn.addEventListener("click", async () => {
    const e = current();
    if (!e) return;
    newBtn.disabled = true;
    say(`Starting Pi in ${e.name}…`);
    try {
      await send("/api/envs/start", "POST", { id: e.id });
      say(`Pi started in ${e.name}, in a new terminal window ✓`, "ok");
    } catch (error) {
      say(error.message, "error");
    } finally {
      newBtn.disabled = st.data?.canOpen === false;
    }
  });

  menu.addEventListener("input", (event) => {
    if (event.target.classList.contains("env-search")) {
      st.q = event.target.value;
      const caret = event.target.selectionStart;
      render();
      place();
      const box = menu.querySelector(".env-search");
      box.focus();
      box.setSelectionRange(caret, caret);
    }
  });

  menu.addEventListener("keydown", (event) => {
    // Enter in the search box picks the first match.
    if (event.key === "Enter" && event.target.classList.contains("env-search")) {
      event.preventDefault();
      menu.querySelector("[data-pick]")?.click();
    }
  });

  menu.addEventListener("change", (event) => {
    if (event.target.name !== "kind" || !st.form) return;
    const form = event.target.form;
    st.form = { ...Object.fromEntries(new FormData(form)), kind: event.target.value, focus: event.target.value === "ssh" ? "host" : "path" };
    st.error = "";
    render();
    place();
  });

  menu.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.target));
    try {
      st.data = await send("/api/envs", "POST", body);
      st.form = null;
      renderBar();
      close();
      say(`Picked ${current()?.name}. New session starts Pi there.`, "ok");
    } catch (error) {
      st.form = { ...body, focus: null };
      st.error = error.message;
      render();
      place();
    }
  });

  menu.addEventListener("click", async (event) => {
    const t = event.target;
    if (t.closest("[data-new]")) {
      st.form = { kind: "local" };
      st.error = "";
      render();
      place();
      return;
    }
    if (t.closest("[data-cancel]")) {
      st.form = null;
      render();
      place();
      return;
    }
    const pick = t.closest("[data-pick]");
    if (pick) {
      try {
        st.data = await send("/api/envs/current", "PUT", { id: pick.dataset.pick });
        renderBar();
        close();
      } catch (error) {
        say(error.message, "error");
      }
      return;
    }
    const remove = t.closest("[data-remove]");
    if (remove) {
      try {
        st.data = await send(`/api/envs?id=${encodeURIComponent(remove.dataset.remove)}`, "DELETE");
        renderBar();
        render();
        place();
      } catch (error) {
        say(error.message, "error");
      }
    }
  });

  document.addEventListener(
    "click",
    (event) => {
      if (menu.hidden) return;
      if (menu.contains(event.target) || pickBtn.contains(event.target) || topBtn?.contains(event.target)) return;
      close();
    },
    true,
  );
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      if (st.form) {
        st.form = null;
        render();
        place();
      } else close();
    }
  });
  window.addEventListener("resize", close);
  // Changed here or in another window (app.js forwards the server's "envs" message).
  window.addEventListener("companion-envs", () => void load());

  load();
})();

// Search page (#/search): find words in every session of every CLI, what you typed and what the
// assistant replied. Click a match to open the session at that message. The server keeps the
// text in memory only.
(function () {
  const esc = window.escapeHtml;
  const root = document.getElementById("page-search");
  const state = { query: "", data: null, loading: false, timer: undefined, seq: 0 };

  function remembered() {
    try {
      return localStorage.getItem("pi-companion.searchQuery") ?? "";
    } catch {
      return "";
    }
  }
  function remember(q) {
    try {
      localStorage.setItem("pi-companion.searchQuery", q);
    } catch {
      // Private window: fine.
    }
  }

  /** Mark the query terms in already-escaped text. */
  function mark(text, terms) {
    let html = esc(text);
    const sorted = [...terms].sort((a, b) => b.length - a.length).map((t) => esc(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (!sorted.length) return html;
    return html.replace(new RegExp(`(${sorted.join("|")})`, "gi"), "<mark>$1</mark>");
  }

  function when(at) {
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return "";
    const today = new Date().toDateString() === d.toDateString();
    return today ? window.fmtTime(d, { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  }

  const base = (p) => String(p ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";

  async function run() {
    const q = state.query.trim();
    const seq = ++state.seq;
    clearTimeout(state.timer);
    if (!q) {
      state.data = null;
      state.loading = false;
      renderResults();
      return;
    }
    state.loading = true;
    renderResults();
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { cache: "no-store" });
      const data = res.ok ? await res.json() : { error: `HTTP ${res.status}` };
      if (seq !== state.seq) return;
      state.data = data;
    } catch {
      if (seq !== state.seq) return;
      state.data = { error: "Couldn't reach the companion server." };
    }
    state.loading = false;
    renderResults();
    // Still reading session files: ask again shortly for the rest.
    if (state.data?.indexing && !root.hidden) state.timer = setTimeout(run, 1500);
  }

  function renderResults() {
    const box = root.querySelector("#search-results");
    if (!box) return;
    const d = state.data;
    const status = root.querySelector("#search-status");
    if (!state.query.trim()) {
      status.textContent = "";
      box.innerHTML = `<p class="page-lead">Type words to find in any session. All words must be in the same message;
        use "quotes" for an exact phrase. Searches what you typed and the replies, not tool output.</p>`;
      return;
    }
    if (!d) {
      status.textContent = state.loading ? "Searching…" : "";
      return;
    }
    if (d.error) {
      status.textContent = "";
      box.innerHTML = `<p class="page-lead">${esc(d.error)}</p>`;
      return;
    }
    const reading = d.indexing ? ` Reading session files… ${d.indexing.done} of ${d.indexing.total} (the first search takes a few seconds).` : "";
    status.textContent = `${d.total ?? 0} session${d.total === 1 ? "" : "s"}${d.total > d.results.length ? `, showing ${d.results.length}` : ""}.${reading}`;
    if (!d.results.length) {
      box.innerHTML = d.indexing ? "" : `<p class="page-lead">No matches.</p>`;
      return;
    }
    box.innerHTML = d.results
      .map((r) => {
        const src = cliSources.get(r.source);
        return `<section class="sr">
          <div class="sr-head">
            <i class="sw ${esc(r.source)}" aria-hidden="true"></i>
            <button class="sr-title" type="button" data-open="${esc(r.id)}" data-nth="-1">${esc(r.name || "(untitled)")}</button>
            <span class="sr-meta">${esc(src.label)} · ${esc(base(r.cwd))} · ${r.count} match${r.count === 1 ? "" : "es"} · ${esc(when(r.last))}</span>
          </div>
          ${r.hits
            .map(
              (h, i) => `<button class="sr-hit" type="button" data-open="${esc(r.id)}" data-nth="${i}">
              <span class="sr-who">${h.role === "user" ? "You" : esc(src.assistant)} · ${esc(when(h.at))}</span>
              <span class="sr-text">${mark(h.text, d.terms)}</span>
            </button>`,
            )
            .join("")}
        </section>`;
      })
      .join("");
    for (const b of box.querySelectorAll("[data-open]")) {
      b.addEventListener("click", () => {
        const nth = Number(b.dataset.nth);
        window.openSession?.(b.dataset.open, { find: d.terms, nth: nth < 0 ? 0 : nth });
      });
    }
  }

  function render() {
    root.className = "page";
    root.innerHTML = `<div class="page-inner">
      <h1>Search</h1>
      <form class="search-form" role="search">
        <input id="search-input" type="search" placeholder='e.g. ollama timeout, or "exact phrase"' aria-label="Search all sessions" autocomplete="off" spellcheck="false" value="${esc(state.query)}">
      </form>
      <p class="search-status" id="search-status" role="status"></p>
      <div id="search-results"></div>
    </div>`;
    const input = root.querySelector("#search-input");
    root.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      void run();
    });
    input.addEventListener("input", () => {
      state.query = input.value;
      remember(state.query);
      clearTimeout(state.timer);
      state.timer = setTimeout(run, 250);
    });
    renderResults();
  }

  window.searchPage = {
    show(visible) {
      if (!visible) {
        clearTimeout(state.timer);
        return;
      }
      if (!root.querySelector("#search-input")) {
        state.query = state.query || remembered();
        render();
      }
      const input = root.querySelector("#search-input");
      input.focus();
      input.select();
      void run();
    },
  };

  // Ctrl+Shift+F from anywhere opens Search.
  document.addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.shiftKey && !event.altKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      if (location.hash !== "#/search") location.hash = "#/search";
      else root.querySelector("#search-input")?.focus();
    }
  });
})();

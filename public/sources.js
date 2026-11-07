// The CLIs the server reads (from /api/sources), and which one a session belongs to.
// Loaded before the other scripts; it starts with built-in defaults so nothing waits on the
// request, then swaps in the server's list and fires "sources-ready".
(function () {
  let list = [
    { id: "pi", label: "Pi", tag: "", assistant: "Pi", live: true, canType: true, enabled: true },
    { id: "claude", label: "Claude Code", tag: "CC", assistant: "Claude", live: false, canType: false, enabled: true },
  ];
  const find = (id) => list.find((s) => s.id === id);
  const pi = () => find("pi") ?? list[0];

  window.cliSources = {
    list: () => list,
    get: (id) => find(id) ?? pi(),
    /** By session id: a known "<source>:" prefix, else Pi (Pi ids have no prefix). */
    forId(sessionId) {
      const text = String(sessionId ?? "");
      const colon = text.indexOf(":");
      if (colon > 0) {
        const found = find(text.slice(0, colon));
        if (found && found.id !== "pi") return found;
      }
      return pi();
    },
    /** By sidebar row (its `source` field), falling back to the id. */
    forRow(row) {
      return row?.source ? this.get(row.source) : this.forId(row?.id);
    },
    ready: fetch("/api/sources", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : undefined))
      .then((data) => {
        if (Array.isArray(data?.sources) && data.sources.length) list = data.sources;
        window.dispatchEvent(new Event("sources-ready"));
        return list;
      })
      .catch(() => list),
  };
})();

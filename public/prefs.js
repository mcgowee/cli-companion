// Appearance settings (Settings page → ~/.cli-companion/settings.json): theme, whether cost
// estimates and git info show, and 12- or 24-hour times (window.fmtTime). Loaded first; the theme is also remembered in this browser so the
// page doesn't flash the wrong colours before the server answers. Others read
// window.companionPrefs and listen for "prefs-changed".
(function () {
  const DEFAULTS = { theme: "system", showCost: true, showGit: true, clock: "auto" };
  const KEY = "pi-companion.theme";

  function applyTheme(theme) {
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }

  try {
    applyTheme(localStorage.getItem(KEY));
  } catch {
    // Storage blocked: the server's answer below sets it.
  }

  window.companionPrefs = { ...DEFAULTS };

  /**
   * Format a date with the chosen clock: fmtTime(date, { hour: "numeric", minute: "2-digit" }).
   * "auto" leaves 12/24 hours to this computer's locale. Options without an hour are passed through.
   */
  window.fmtTime = (date, opts = {}) => {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return "";
    const clock = window.companionPrefs.clock;
    const cycle = clock === "12" ? { hour12: true } : clock === "24" ? { hourCycle: "h23" } : {};
    return d.toLocaleString([], opts.hour ? { ...opts, ...cycle } : opts);
  };

  window.applyPrefs = (appearance) => {
    window.companionPrefs = { ...DEFAULTS, ...(appearance ?? {}) };
    applyTheme(window.companionPrefs.theme);
    try {
      localStorage.setItem(KEY, window.companionPrefs.theme);
    } catch {
      // ignore
    }
    window.dispatchEvent(new Event("prefs-changed"));
  };

  fetch("/api/settings", { cache: "no-store" })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => data && window.applyPrefs(data.settings?.appearance))
    .catch(() => {});
})();

// Appearance settings (Settings page → ~/.cli-companion/settings.json): theme, and whether cost
// estimates and git info show. Loaded first; the theme is also remembered in this browser so the
// page doesn't flash the wrong colours before the server answers. Others read
// window.companionPrefs and listen for "prefs-changed".
(function () {
  const DEFAULTS = { theme: "system", showCost: true, showGit: true };
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

'use strict';

(() => {
  const storageKey = 'relay-theme';
  const modes = new Set(['light', 'dark', 'system']);
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  const root = document.documentElement;
  let preference = readPreference();

  function readPreference() {
    try {
      const saved = localStorage.getItem(storageKey);
      return modes.has(saved) ? saved : 'system';
    } catch { return 'system'; }
  }

  function apply() {
    const resolved = preference === 'system' ? (systemTheme.matches ? 'dark' : 'light') : preference;
    root.dataset.theme = resolved;
    root.dataset.themePreference = preference;
    root.style.colorScheme = resolved;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#101312' : '#f5f7f3');
    document.querySelectorAll('[data-theme-select]').forEach(select => {
      select.value = preference;
      window.RelaySelect?.sync(select);
    });
  }

  // Resolve the saved preference before styles and page content are painted.
  apply();
  systemTheme.addEventListener('change', () => { if (preference === 'system') apply(); });
  window.addEventListener('storage', event => {
    if (event.key === storageKey || event.key === null) { preference = readPreference(); apply(); }
  });
  document.addEventListener('change', event => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement) || !select.matches('[data-theme-select]') || !modes.has(select.value)) return;
    preference = select.value;
    try { localStorage.setItem(storageKey, preference); } catch { /* The current page still honors the selection when storage is unavailable. */ }
    apply();
  });
  document.addEventListener('DOMContentLoaded', apply, { once: true });
})();

/* SchReader — theme bootstrap for the non-reader pages.
   The palette lives in `reader.css` (presets) and in the reader's colour mixer (custom). The
   library / search / settings pages need three things from it:

     1. paint the stored theme before the first content renders,
     2. when the theme is "custom" (the reader's mixer), apply the tokens the reader computed —
        a bare `data-theme="custom"` matches no `:root[data-theme=…]` block and silently fell back
        to the light palette,
     3. tell the Android shell which colours the chrome should wear (bars, address field, tab sheet).

   The custom tokens are cached by `reader.js` (`sr-custom-resolved`) instead of being derived
   here as well: one implementation of the mixing rules, several consumers. */
(() => {
  'use strict';

  const THEME_KEY = 'sr-theme';
  const RESOLVED_KEY = 'sr-custom-resolved';
  /* keep in sync with CUSTOM_PROPS in reader.js */
  const VARS = ['--bg', '--bg-soft', '--bg-sunk', '--fg', '--fg-soft', '--fg-faint',
    '--line', '--line-strong', '--link', '--accent', '--accent-soft', '--chip-bg', '--chip-fg',
    '--mark', '--shadow', '--danger'];

  const read = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch (e) { return fallback; } };

  function isDark(hex) {
    const m = String(hex || '').replace('#', '').match(/^([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!m) return true;
    const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
    const [r, g, b] = [0, 2, 4].map((i) => {
      const s = parseInt(h.slice(i, i + 2), 16) / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.35;
  }

  function apply() {
    const root = document.documentElement;
    for (const v of VARS) root.style.removeProperty(v);
    const theme = read(THEME_KEY, 'light');
    root.dataset.theme = theme;
    if (theme === 'custom') {
      try {
        const cached = JSON.parse(read(RESOLVED_KEY, 'null'));
        if (cached && cached.props) {
          for (const [k, v] of Object.entries(cached.props)) if (v) root.style.setProperty(k, v);
        }
      } catch (e) { /* fall back to the light palette */ }
    }
    report();
  }

  /* Hand the parsed colours to the Android shell. No-op in a browser. */
  function report() {
    if (typeof SchReader === 'undefined' || !SchReader || typeof SchReader.setTheme !== 'function') return;
    try {
      const cs = getComputedStyle(document.documentElement);
      const v = (p) => cs.getPropertyValue(p).trim();
      const bg = v('--bg');
      SchReader.setTheme(JSON.stringify({
        theme: document.documentElement.dataset.theme || 'light',
        bg,
        soft: v('--bg-soft'),
        sunk: v('--bg-sunk'),
        fg: v('--fg'),
        fgSoft: v('--fg-soft'),
        faint: v('--fg-faint'),
        line: v('--line'),
        lineStrong: v('--line-strong'),
        accent: v('--accent'),
        accentSoft: v('--accent-soft'),
        dark: isDark(bg),
      }));
    } catch (e) { /* a shell that cannot take it is not an error */ }
  }

  /**
   * Run `fn(root)` while `id` is the live theme, then put everything back.
   *
   * A custom palette lives as inline custom properties on :root, and inline wins over every
   * `:root[data-theme=…]` block — so anything that samples the palettes by switching data-theme
   * (the settings grid) read the custom colours seventeen times and drew seventeen identical
   * swatches. Stash the inline tokens, read, restore.
   */
  function withTheme(id, fn) {
    const root = document.documentElement;
    const prev = root.getAttribute('data-theme');
    const saved = VARS
      .map((p) => [p, root.style.getPropertyValue(p), root.style.getPropertyPriority(p)])
      .filter(([, v]) => v !== '');
    for (const [p] of saved) root.style.removeProperty(p);
    if (id != null) root.setAttribute('data-theme', id);
    try {
      return fn(root);
    } finally {
      for (const [p, v, prio] of saved) root.style.setProperty(p, v, prio);
      if (prev == null) root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', prev);
    }
  }

  globalThis.NVTheme = { apply, report, withTheme };
  apply();

  /* The custom palette is cached by the reader, which may only be opened *after* this page was
     loaded — so re-read it whenever the shell brings the page back, and when it becomes visible. */
  window.addEventListener('sr-refresh', apply);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) apply(); });

  /* the Android shell floats a bottom bar over the page: the reader uses this to keep its panels
     clear of it */
  if (typeof SchReader !== 'undefined' && SchReader) document.documentElement.classList.add('app');
})();

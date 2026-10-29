/* SchReader — the settings panel.
   ONE implementation for three hosts:
     • Chrome extension — opened as a modal from the library's gear button (and by Chrome's
       "Extension options", which redirects to library.html?settings=1).
     • Android app      — the Settings tab of the home screen (settings.html).
     • dev harness      — whatever is being tested; sections degrade to what exists.
   Sections: appearance (theme / typeface / reading size), reading history, allowed sites
   (extension only — the app never gates on a whitelist) and about (version / shortcuts).
*/
(() => {
  'use strict';

  const LIB = window.SR_LIB;
  const APP = (typeof SchReader !== 'undefined' && SchReader && typeof SchReader.libLoad === 'function');

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  /* Theme ids must line up with the `:root[data-theme="…"]` blocks in reader.css AND its verbatim
     copy in library.css, plus THEMES in reader.js. Add a skin there first, then here. */
  const LIGHT_THEMES = ['light', 'paper', 'sepia', 'solarized-light', 'gruvbox-light', 'rose-dawn', 'catppuccin-latte'];
  const DARK_THEMES = ['dark', 'dusk', 'solarized-dark', 'gruvbox-dark', 'nord', 'rose-pine', 'catppuccin-mocha', 'midnight', 'black', 'moss'];
  const THEME_LABEL = {
    light: 'Light', paper: 'Paper', sepia: 'Sepia', 'solarized-light': 'Solarized',
    'gruvbox-light': 'Gruvbox', 'rose-dawn': 'Rosé Pine Dawn', 'catppuccin-latte': 'Catppuccin Latte',
    dark: 'Graphite', dusk: 'Dusk', 'solarized-dark': 'Solarized Dark', 'gruvbox-dark': 'Gruvbox Dark',
    nord: 'Nord', 'rose-pine': 'Rosé Pine', 'catppuccin-mocha': 'Catppuccin Mocha',
    midnight: 'Midnight', black: 'OLED black', moss: 'Moss',
  };

  /* same families as FONTS in reader.js — the reader is what actually draws your text */
  const FONTS = [
    { id: 'palatino', label: 'Palatino' },
    { id: 'georgia', label: 'Georgia' },
    { id: 'times', label: 'Times New Roman' },
    { id: 'cambria', label: 'Cambria' },
    { id: 'inter', label: 'Inter' },
    { id: 'plex', label: 'IBM Plex Sans' },
    { id: 'arial', label: 'Arial' },
  ];

  const readLS = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch (e) { return fallback; } };
  const writeLS = (key, value) => { try { localStorage.setItem(key, value); } catch (e) { /* ignore */ } };

  const storedTheme = () => readLS('sr-theme', 'light');
  const storedFont = () => (FONTS.some((f) => f.id === readLS('sr-font', 'palatino')) ? readLS('sr-font', 'palatino') : 'palatino');
  const storedScale = () => {
    const v = Number(readLS('sr-scale', '1'));
    return Number.isFinite(v) ? Math.min(1.32, Math.max(0.88, v)) : 1;
  };

  /* ------------------------------------------------------------ theme swatches */

  /* Read the real palette instead of keeping a second copy of every hex value: put the theme id
     on :root, read the custom properties back, restore. The reads happen in one task, so nothing
     paints in between and the page never flickers through 17 skins. */
  function paletteOf(id) {
    const read = (root) => {
      const cs = getComputedStyle(root);
      const v = (p) => cs.getPropertyValue(p).trim();
      return { bg: v('--bg'), fg: v('--fg'), soft: v('--bg-soft'), accent: v('--accent'), line: v('--line') };
    };
    /* theme.js clears a custom palette's inline tokens for the duration of the read; without
       that every swatch showed the custom colours and the grid looked like 17 copies */
    if (window.NVTheme && window.NVTheme.withTheme) return window.NVTheme.withTheme(id, read);
    const root = document.documentElement;
    const prev = root.getAttribute('data-theme');
    root.setAttribute('data-theme', id);
    const out = read(root);
    if (prev == null) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', prev);
    return out;
  }

  function swatch(id) {
    const c = paletteOf(id);
    // three bars on a card: body text (fg), a quieter line (soft) and the accent
    return `<button type="button" class="swatch" data-theme="${esc(id)}" title="${esc(THEME_LABEL[id] || id)}">
      <span class="pv" style="background:${esc(c.bg)};border-color:${esc(c.line)}">
        <i style="background:${esc(c.fg)};width:70%"></i>
        <i style="background:${esc(c.soft)};width:88%"></i>
        <i style="background:${esc(c.soft)};width:52%"></i>
        <i style="background:${esc(c.accent)};width:34%;height:3px"></i>
      </span>
      <span class="lb">${esc(THEME_LABEL[id] || id)}</span>
    </button>`;
  }

  /* The reader's Aa panel mixes a palette from two colours and caches the result; that skin is a
     theme like any other and belongs here, or the only way back to it is finding the article you
     made it in. */
  function customPalette() {
    try {
      const c = JSON.parse(readLS('sr-custom-resolved', 'null'));
      if (c && c.props) return c.props;
    } catch (e) { /* not configured yet */ }
    return null;
  }

  function customSwatch() {
    const p = customPalette();
    const on = storedTheme() === 'custom';
    if (!p) {
      return `<button type="button" class="swatch swatch-empty${on ? ' on' : ''}" data-theme="custom"
        title="Custom colours — make one in the reader's Aa panel">
        <span class="pv pv-empty">Aa</span>
        <span class="lb">Custom</span></button>`;
    }
    const v = (k, fb) => esc(p[k] || fb);
    return `<button type="button" class="swatch${on ? ' on' : ''}" data-theme="custom"
      title="Custom colours (set in the reader's Aa panel)">
      <span class="pv" style="background:${v('--bg', '#fff')};border-color:${v('--line', '#ccc')}">
        <i style="background:${v('--fg', '#000')};width:70%"></i>
        <i style="background:${v('--bg-soft', '#eee')};width:88%"></i>
        <i style="background:${v('--bg-soft', '#eee')};width:52%"></i>
        <i style="background:${v('--accent', '#08f')};width:34%;height:3px"></i>
      </span>
      <span class="lb">Custom</span>
    </button>`;
  }

  function themeGridHtml() {
    const group = (title, ids) => `<div class="sw-group"><h5>${title}</h5>
      <div class="sw-grid">${ids.map(swatch).join('')}</div></div>`;
    /* "Yours" first: it is the only tile that cannot be found anywhere else */
    return `<div class="sw-group"><h5>Yours</h5>
        <div class="sw-grid">${customSwatch()}</div>
        <p class="hint" id="setCustomHint">${customPalette()
          ? 'Your own colours, mixed in the reader&rsquo;s Aa panel.'
          : 'Open an article, tap Aa &rarr; Custom colours to mix one &mdash; it shows up here.'}</p>
      </div>`
      + group('Light', LIGHT_THEMES) + group('Dark', DARK_THEMES);
  }

  /* ------------------------------------------------------------ extension-only bits */

  const SITES = (() => {
    if (typeof chrome === 'undefined' || !chrome.permissions || !chrome.storage || !chrome.storage.local) return null;
    return window.SR_SITES || null;
  })();

  const patternsFor = (d) => [`*://${d}/*`, `*://*.${d}/*`];

  const chromeGet = (key, fallback) => new Promise((res) => {
    try { chrome.storage.local.get({ [key]: fallback }, (v) => res(v && v[key] !== undefined ? v[key] : fallback)); }
    catch (e) { res(fallback); }
  });
  const chromeSet = (key, value) => new Promise((res) => {
    try { chrome.storage.local.set({ [key]: value }, () => res()); } catch (e) { res(); }
  });

  function version() {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
        return chrome.runtime.getManifest().version;
      }
    } catch (e) { /* ignore */ }
    return new URLSearchParams(location.search).get('v') || '';
  }

  const SHORTCUTS = [
    ['j / k', 'next / previous section'],
    ['s · f · r', 'Sections · Figures · References rail'],
    ['z', 'show or hide the rail'],
    ['t', 'next theme'],
    ['Esc', 'close a card, lightbox or drawer'],
  ];

  const KEY = SITES ? SITES.STORAGE_KEY : 'sr-sites';

  /* ------------------------------------------------------------ the panel */

  /* Every innerHTML below interpolates only static markup or values passed through esc();
     nothing on this page comes from a publisher's DOM or an untrusted store. */
  function bodyHtml() {
    const ver = version();
    return `
  <section class="set-sec">
    <h4>Theme</h4>
    <div class="sw-wrap" id="setThemes">${themeGridHtml()}</div>
    ${storedTheme() === 'custom' ? '<p class="hint">Using your own colours (Aa panel in the reader). Pick any tile here to replace them — Custom brings them back.</p>' : ''}
    <div class="set-row">
      <span>Reading typeface</span>
      <select id="setFont">
        ${FONTS.map((f) => `<option value="${esc(f.id)}">${esc(f.label)}</option>`).join('')}
      </select>
    </div>
    <div class="set-row">
      <span>Reading size</span>
      <input type="range" id="setScale" min="88" max="132" step="2" value="100" aria-label="Reading size">
      <b id="setScaleVal">100%</b>
    </div>
    <p class="hint">Typeface and size are used by the reading view; the theme also paints this page.</p>
  </section>

  <section class="set-sec">
    <h4>Reading history</h4>
    <label class="set-row check">
      <input type="checkbox" id="setHistory">
      <span>Record every paper I open</span>
    </label>
    <p class="hint">History keeps the title and the link only — never the article text. Turn it off
      and nothing new is recorded; existing entries stay until you clear them.</p>
  </section>

  <section class="set-sec">
    <h4>Sync <span class="n" id="setSyncState">not connected</span></h4>
    <p class="hint">Your library, reading positions and highlights, the same on every device. It
      travels through a private GitHub gist: titles, links and notes only — never the article text.</p>
    <div id="setSyncOff">
      <div class="add">
        <input type="password" id="setSyncToken" placeholder="GitHub token with the gist scope"
          aria-label="GitHub token" autocomplete="off" spellcheck="false">
        <button type="button" class="primary" id="setSyncConnect">Connect</button>
      </div>
      <p class="hint">Make one in <a href="https://github.com/settings/tokens/new?scopes=gist&amp;description=SchReader%20sync"
        target="_blank" rel="noreferrer">GitHub &rsaquo; Settings &rsaquo; Developer settings &rsaquo; Tokens</a>
        and tick only <b>gist</b>. Enter the same token on every device: the second one finds the same
        gist by itself. The token stays on the device; the gist is secret.</p>
    </div>
    <div id="setSyncOn" hidden>
      <div class="set-row">
        <span id="setSyncWho">connected</span>
        <button type="button" id="setSyncNow">Sync now</button>
        <button type="button" id="setSyncOffBtn">Disconnect</button>
      </div>
      <p class="hint" id="setSyncMeta"></p>
    </div>
    <div class="msg" id="setSyncMsg" role="status"></div>
  </section>

  ${SITES ? `
  <section class="set-sec">
    <h4>Allowed sites <span class="n">${SITES.DEFAULT_DOMAINS.length} built in</span></h4>
    <p class="hint">The reading view only ever appears on these sites. Everything else is left alone.</p>
    <div class="chips" id="setBuiltin"></div>
    <div class="rows" id="setCustom"></div>
    <form class="add" id="setAddForm" autocomplete="off">
      <input type="text" id="setAddInput" placeholder="journal.example.org" aria-label="Domain to allow">
      <button type="submit" class="primary">Allow site</button>
    </form>
    <div class="msg" id="setMsg" role="status"></div>
  </section>` : ''}

  <section class="set-sec">
    <h4>About</h4>
    <p class="about">SchReader${ver ? ` <b>v${esc(ver)}</b>` : ''} — the reading view, your library
      and a shelf of journal shortcuts, in the browser and on the phone.</p>
    ${SITES ? `<dl class="keys">${SHORTCUTS.map(([k, what]) => `<dt><kbd>${esc(k)}</kbd></dt><dd>${esc(what)}</dd>`).join('')}</dl>` : ''}
    ${APP ? '<p class="hint">On the phone the reading view is the floating button on a publisher page; the bottom bar switches between library, search and settings.</p>' : ''}
  </section>`;
  }

  /* ------------------------------------------------------------ wiring */

  let custom = [];
  let renderSeq = 0;
  let here = null;          /* the current panel root */

  function say(text, kind) {
    const el = here && here.querySelector('#setMsg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'msg' + (kind ? ' ' + kind : '');
  }

  /* the settings panel is also the phone's Settings tab, which has no #setMsg: nudge the hint
     under the tile instead so the tap never feels dead */
  function flashCustomHint() {
    const el = here && here.querySelector('#setCustomHint');
    if (!el) return;
    el.textContent = 'Nothing saved yet — open an article and use Aa → Custom colours first.';
    el.classList.add('warn');
    clearTimeout(flashCustomHint.t);
    flashCustomHint.t = setTimeout(() => el.classList.remove('warn'), 2600);
  }

  function paintTheme(id) {
    document.documentElement.dataset.theme = id;
    for (const b of here.querySelectorAll('.swatch')) b.classList.toggle('on', b.dataset.theme === id);
  }

  async function renderCustom() {
    const seq = ++renderSeq;
    const box = here.querySelector('#setCustom');
    if (!box) return;
    custom = await chromeGet(KEY, []);
    if (!Array.isArray(custom)) custom = [];

    /* rows built detached and swapped in one go: saving a domain fires storage.onChanged, which
       calls this again, and appending into the live box is what once produced a doubled row */
    const frag = document.createDocumentFragment();
    if (!custom.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'No extra sites yet.';
      frag.appendChild(p);
    }
    for (const domain of custom) {
      const row = document.createElement('div');
      row.className = 'site-row';

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = domain;

      let ok = false;
      try { ok = await chrome.permissions.contains({ origins: patternsFor(domain) }); } catch (e) { ok = false; }
      if (seq !== renderSeq) return;

      row.appendChild(name);
      if (!ok) {
        const state = document.createElement('span');
        state.className = 'state';
        state.textContent = 'permission withdrawn — re-add the site';
        row.appendChild(state);
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => drop(domain));
      row.appendChild(remove);
      frag.appendChild(row);
    }
    if (seq !== renderSeq) return;
    box.textContent = '';
    box.appendChild(frag);
  }

  async function addSite(raw) {
    const domain = SITES.norm(raw);
    if (!domain) return say('Type a domain first, e.g. journal.example.org', 'err');
    if (!SITES.isValid(domain)) return say(`“${String(raw).trim()}” does not look like a domain.`, 'err');
    if (SITES.matches(domain, SITES.DEFAULT_DOMAINS)) return say(`${domain} is already covered by a built-in publisher site.`, 'err');
    if (SITES.matches(domain, custom)) return say(`${domain} is already on your list.`, 'err');

    /* the user gesture ends at the first await — keep the permission request first */
    let ok = false;
    let why = '';
    try { ok = await chrome.permissions.request({ origins: patternsFor(domain) }); }
    catch (e) { ok = false; why = String((e && e.message) || e); }
    /* Chrome's own wording is the only clue when manifest and request disagree ("Only
       permissions specified in the manifest may be requested.") — never hide it. */
    if (!ok) {
      return say(why
        ? `Chrome refused the request: ${why}`
        : 'Chrome needs permission to run on that site — nothing was added.', 'err');
    }

    await chromeSet(KEY, custom.concat(domain).sort());
    await renderCustom();
    here.querySelector('#setAddInput').value = '';
    say(`${domain} allowed. Open a paper there and the pill appears.`, 'ok');
  }

  async function drop(domain) {
    await chromeSet(KEY, custom.filter((d) => d !== domain));
    try { await chrome.permissions.remove({ origins: patternsFor(domain) }); } catch (e) { /* ignore */ }
    await renderCustom();
    say(`${domain} removed.`, 'ok');
  }

  async function mount(host) {
    if (!host) return;
    here = host;
    host.innerHTML = bodyHtml();

    /* ---- appearance */
    paintTheme(storedTheme());
    host.addEventListener('click', (e) => {
      const sw = e.target.closest('.swatch');
      if (!sw) return;
      const id = sw.dataset.theme;
      if (id === 'custom' && !customPalette()) {
        flashCustomHint();
        return;
      }
      writeLS('sr-theme', id);
      paintTheme(id);
      /* NVTheme.apply() is what puts the custom tokens back / clears them for a preset */
      if (window.NVTheme) window.NVTheme.apply();
      window.dispatchEvent(new CustomEvent('sr-theme', { detail: id }));
      say('Theme: ' + (THEME_LABEL[id] || id), 'ok');
    });

    const fontSel = host.querySelector('#setFont');
    fontSel.value = storedFont();
    fontSel.addEventListener('change', () => {
      writeLS('sr-font', fontSel.value);
      window.dispatchEvent(new CustomEvent('sr-typography', { detail: { font: fontSel.value } }));
    });

    const scale = host.querySelector('#setScale');
    const scaleVal = host.querySelector('#setScaleVal');
    scale.value = String(Math.round(storedScale() * 100));
    scaleVal.textContent = scale.value + '%';
    scale.addEventListener('input', () => {
      const pct = Number(scale.value);
      scaleVal.textContent = pct + '%';
      writeLS('sr-scale', String(pct / 100));
      window.dispatchEvent(new CustomEvent('sr-typography', { detail: { scale: pct / 100 } }));
    });

    /* ---- history */
    if (LIB) {
      const settings = await LIB.getSettings();
      const box = host.querySelector('#setHistory');
      box.checked = settings.history !== false;
      box.addEventListener('change', async () => {
        await LIB.saveSettings({ history: box.checked });
        window.dispatchEvent(new CustomEvent('sr-settings', { detail: { history: box.checked } }));
        say(box.checked ? 'History on' : 'History off', 'ok');
      });
    }

    /* ---- sync */
    if (LIB && LIB.sync) {
      const state = host.querySelector('#setSyncState');
      const off = host.querySelector('#setSyncOff');
      const on = host.querySelector('#setSyncOn');
      const who = host.querySelector('#setSyncWho');
      const meta = host.querySelector('#setSyncMeta');
      const msg = host.querySelector('#setSyncMsg');
      const say2 = (text, kind) => { msg.textContent = text || ''; msg.className = 'msg' + (kind ? ' ' + kind : ''); };
      const ago = (ts) => {
        const s = Math.round((Date.now() - ts) / 1000);
        if (s < 90) return 'just now';
        if (s < 5400) return Math.round(s / 60) + ' min ago';
        if (s < 172800) return Math.round(s / 3600) + ' h ago';
        return new Date(ts).toLocaleDateString();
      };

      const paint = async () => {
        const st = await LIB.sync.state();
        state.textContent = st.connected ? (st.busy ? 'syncing…' : 'on') : 'not connected';
        off.hidden = st.connected;
        on.hidden = !st.connected;
        if (st.connected) {
          who.textContent = st.login ? '@' + st.login : 'connected';
          meta.textContent = st.lastSync ? 'Last sync ' + ago(st.lastSync) : 'Not synced yet.';
          if (st.lastError) say2(st.lastError, 'err');
        }
      };

      host.querySelector('#setSyncConnect').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const token = host.querySelector('#setSyncToken');
        btn.disabled = true;
        say2('Checking the token…');
        try {
          const r = await LIB.sync.connect(token.value);
          if (r && r.ok) {
            token.value = '';
            say2(`Connected. ${r.counts.lib} entries, ${r.counts.history} history items.`, 'ok');
          } else {
            say2((r && r.error) || 'Could not sync.', 'err');
          }
        } catch (err) {
          say2(String((err && err.message) || err), 'err');
        } finally {
          btn.disabled = false;
          paint();
        }
      });

      host.querySelector('#setSyncNow').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        say2('Syncing…');
        const r = await LIB.sync.sync();
        btn.disabled = false;
        if (r && r.ok) say2(`Up to date — ${r.counts.lib} entries, ${r.counts.history} history items.`, 'ok');
        else say2((r && r.error) || 'Not connected.', 'err');
        paint();
        /* the library behind this panel is stale now */
        window.dispatchEvent(new CustomEvent('sr-refresh'));
      });

      host.querySelector('#setSyncOffBtn').addEventListener('click', async () => {
        await LIB.sync.disconnect();
        say2('Disconnected on this device. The gist is untouched.', 'ok');
        paint();
      });

      await paint();
    }

    /* ---- allowed sites (extension only) */
    if (SITES) {
      const builtin = host.querySelector('#setBuiltin');
      const frag = document.createDocumentFragment();
      for (const d of SITES.DEFAULT_DOMAINS) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = d;
        frag.appendChild(chip);
      }
      builtin.appendChild(frag);

      host.querySelector('#setAddForm').addEventListener('submit', (e) => {
        e.preventDefault();
        addSite(host.querySelector('#setAddInput').value);
      });
      await renderCustom();
      /* the panel outlives several renders; drop the listener with it (page unload does that) */
      try {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === 'local' && changes[KEY]) renderCustom();
        });
      } catch (e) { /* ignore */ }
    }
  }

  globalThis.SR_SETTINGS = { mount, THEME_LABEL, LIGHT_THEMES, DARK_THEMES };

  /* The Android app mounts this panel as a page of its own (settings.html carries
     data-boot="settings"); the extension mounts it lazily from the library's gear button. */
  if ((document.body.dataset.boot || document.documentElement.dataset.boot) === 'settings') {
    document.documentElement.dataset.theme = readLS('sr-theme', 'light');
    if (APP) document.documentElement.classList.add('app');
    mount(document.getElementById('settingsBody'));
  }
})();

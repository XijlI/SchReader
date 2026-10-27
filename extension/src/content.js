/* SchReader — content script.
   Detects article pages, shows a small pill, and hands the parsed article to the
   service worker which opens the reader tab. Nothing is fetched or stored. */
(() => {
  'use strict';
  const SR = window.SR;
  if (!SR || typeof SR.extract !== 'function') return;

  /* site whitelist: built-in publisher domains plus whatever the user added on the
     options page. Nothing runs anywhere else — see src/whitelist.js. */
  const SITES = window.SR_SITES;
  if (!SITES) return;

  const isTop = window === window.top;
  const host = location.hostname;

  /* journals that already look like this, plus search engines / social sites */
  const SKIP = /(^|\.)(nature\.com|science\.org\/search|scholar\.google\.[a-z.]+|google\.[a-z.]+|bing\.com|baidu\.com|duckduckgo\.com|sogou\.com|yandex\.[a-z.]+|wikipedia\.org|youtube\.com|twitter\.com|x\.com|facebook\.com|linkedin\.com|reddit\.com|amazon\.[a-z.]+)$/i;

  const S = { state: 'idle', frameModel: null, autoDone: false };

  function looksLikeArticle() {
    const meta = document.querySelector('meta[name="citation_title"], meta[name="citation_doi"], meta[name="citation_journal_title"], meta[property="citation_title"]');
    const paras = document.querySelectorAll('article p, main p, p').length;
    const len = (document.body && document.body.innerText || '').length;
    return Boolean(meta) || (paras >= 12 && len > 3500);
  }

  /* ------------------------------------------------------------ pill UI */
  let ui = null;

  function buildUi() {
    /* a page saved with Ctrl+S (or an extension reload) can leave a dead host behind;
       the first match wins in querySelector, so clear them before adding ours */
    document.querySelectorAll('#sr-pill-host').forEach((old) => old.remove());
    const hostEl = document.createElement('div');
    hostEl.id = 'sr-pill-host';
    hostEl.style.cssText = 'all:initial;position:fixed;right:18px;bottom:18px;z-index:2147483647;';
    const root = hostEl.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif; }
        .bar {
          display: flex; align-items: stretch; gap: 0;
          background: #14171c; color: #eef2f7;
          border-radius: 999px; overflow: hidden;
          box-shadow: 0 8px 24px rgba(10,15,25,.28), 0 1px 3px rgba(10,15,25,.2);
          transition: transform .14s ease, opacity .14s ease;
        }
        .bar:hover { transform: translateY(-1px); }
        .main {
          display: flex; align-items: center; gap: .5rem;
          background: none; border: 0; color: inherit; cursor: pointer;
          font: inherit; font-size: 12.5px; font-weight: 600; letter-spacing: .01em;
          padding: 8px 4px 8px 10px;
        }
        .main:disabled { opacity: .6; cursor: progress; }
        .mark {
          width: 18px; height: 18px; border-radius: 4px;
          background: #14130f;
          color: #f7b705;
          display: grid; place-items: center;
          font-family: Georgia, "Times New Roman", serif; font-size: 13px; font-weight: 700;
        }
        .caret {
          background: none; border: 0; border-left: 1px solid rgba(255,255,255,.16);
          color: #aab3c0; cursor: pointer; font: inherit; font-size: 10px; padding: 0 9px;
        }
        .caret:hover { color: #fff; background: rgba(255,255,255,.06); }
        .panel {
          position: absolute; right: 0; bottom: 46px;
          width: 214px; background: #fff; color: #1b1f24;
          border: 1px solid #e2e6ea; border-radius: 10px;
          box-shadow: 0 14px 34px rgba(10,15,25,.22);
          padding: 10px 11px; font-size: 12px; line-height: 1.45;
        }
        .panel h4 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: #6b7480; font-weight: 700; }
        .row { display: flex; align-items: flex-start; gap: 7px; margin: 5px 0; cursor: pointer; }
        .row input { margin: 2px 0 0; }
        .hint { color: #7b8490; font-size: 11px; margin-top: 7px; }
        .err { color: #b42318; }
        .spin { width: 11px; height: 11px; border-radius: 50%; border: 2px solid rgba(255,255,255,.35); border-top-color: #fff; animation: sp .7s linear infinite; }
        @keyframes sp { to { transform: rotate(360deg); } }
        .hidden { display: none !important; }
        .link {
          background: none; border: 0; padding: 5px 0 0 22px; width: 100%;
          font: inherit; font-size: 11.5px; color: #0b63c4; cursor: pointer; text-align: left;
        }
        .link:hover { text-decoration: underline; }
      </style>
      <div class="wrap" style="position:relative">
        <div class="panel hidden" id="panel">
          <h4>SchReader</h4>
          <label class="row"><input type="checkbox" id="auto"><span>This site: convert automatically</span></label>
          <label class="row"><input type="checkbox" id="hide"><span>Hide the button here</span></label>
          <button class="link" id="sites">Allowed sites…</button>
          <div class="hint" id="hint">Reads this tab as-is — no network, no login, nothing saved.</div>
        </div>
        <div class="bar">
          <button class="main" id="main" title="Read this article in Nature style — Ctrl-click to keep this page (opens a new tab)">
            <span class="mark">R</span><span id="label">SchReader</span>
          </button>
          <button class="caret" id="caret" title="Options">▾</button>
        </div>
      </div>`;
    document.documentElement.appendChild(hostEl);
    ui = {
      host: hostEl,
      root,
      main: root.getElementById('main'),
      label: root.getElementById('label'),
      caret: root.getElementById('caret'),
      panel: root.getElementById('panel'),
      auto: root.getElementById('auto'),
      hide: root.getElementById('hide'),
      sites: root.getElementById('sites'),
      hint: root.getElementById('hint'),
    };
    return ui;
  }

  function setState(state, msg) {
    S.state = state;
    if (!ui) return;
    const { label, main, hint } = ui;
    main.disabled = state === 'working';
    if (state === 'working') label.textContent = 'Reading…';
    else if (state === 'ok') label.textContent = 'Open again';
    else if (state === 'error') label.textContent = 'Retry';
    else label.textContent = 'SchReader';
    if (msg) { hint.textContent = msg; hint.className = 'hint err'; }
  }

  function prefGet() {
    const fallback = { 'sr-auto': {}, 'sr-hidden': {}, [SITES.STORAGE_KEY]: [] };
    return new Promise((res) => {
      try {
        chrome.storage.local.get(fallback, (v) => res(v));
      } catch (e) { res(fallback); }
    });
  }
  /* on the whitelist = a built-in publisher domain, or a domain added on the options page */
  function siteAllowed(pref) {
    const custom = (pref && pref[SITES.STORAGE_KEY]) || [];
    return SITES.matches(host, SITES.DEFAULT_DOMAINS.concat(Array.isArray(custom) ? custom : []));
  }
  function prefSet(obj) {
    try { chrome.storage.local.set(obj); } catch (e) {}
  }

  /* ------------------------------------------------------------ convert */
  async function convert(ev) {
    if (S.state === 'working') return;
    /* the reader normally replaces this page; Ctrl/Cmd/Shift-click (or the middle
       button) asks for a separate tab, which is also what the old build did */
    const newTab = Boolean(ev && (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button === 1));
    setState('working');
    await new Promise((r) => setTimeout(r, 30));
    let model = null;
    try {
      model = SR.extract();
    } catch (err) {
      console.error('[SchReader] extract failed', err);
      setState('error', 'This page could not be read.');
      return;
    }
    if (S.frameModel && richness(S.frameModel) > richness(model)) model = S.frameModel;

    const refCount = (model.references || []).length;
    const secCount = (model.sections || []).length;
    if (!secCount && !model.abstractHtml) {
      setState('error', 'No article text found — the full text may be in a viewer or PDF.');
      return;
    }
    try {
      const res = await chrome.runtime.sendMessage({ type: 'SR_OPEN', article: model, newTab });
      if (!res || !res.ok) throw new Error((res && res.error) || 'failed');
      setState('ok');
      if (refCount === 0) setState('ok', 'Opened, but no reference list was found.');
    } catch (err) {
      console.error('[SchReader] open failed', err);
      setState('error', 'Could not open the reader (try reloading the extension).');
    }
  }

  const richness = (m) => (m ? (m.sections || []).length * 3 + (m.references || []).length + (m.figures || []).length : -1);

  /* ------------------------------------------------------------ iframes (e.g. IEEE Xplore) */
  if (!isTop) {
    (async () => {
      if (!siteAllowed(await prefGet())) return;
      if (!looksLikeArticle()) return;
      try {
        const m = SR.extract();
        if (m && (m.sections || []).length >= 2) {
          window.top.postMessage({ __lwrFrameArticle: true, model: m }, '*');
        }
      } catch (e) { /* ignore */ }
    })();
    return;
  }

  window.addEventListener('message', (e) => {
    if (!e.data || e.data.__lwrFrameArticle !== true) return;
    if (!e.data.model) return;
    if (!S.frameModel || richness(e.data.model) > richness(S.frameModel)) S.frameModel = e.data.model;
  });

  /* ------------------------------------------------------------ boot */
  if (SKIP.test(host)) return;

  (async () => {
    if (!looksLikeArticle()) return;
    const pref = await prefGet();
    if (!siteAllowed(pref)) return;
    if (pref['sr-hidden'] && pref['sr-hidden'][host]) return;

    buildUi();
    ui.auto.checked = Boolean(pref['sr-auto'] && pref['sr-auto'][host]);

    ui.main.addEventListener('click', convert);
    /* middle-click = the same "open in its own tab" escape hatch as Ctrl-click */
    ui.main.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        convert(e);
      }
    });
    ui.sites.addEventListener('click', () => {
      ui.panel.classList.add('hidden');
      /* hand the host over so the settings panel opens with it already typed in */
      try { chrome.runtime.sendMessage({ type: 'SR_OPTIONS', host }); } catch (e) {}
    });
    ui.caret.addEventListener('click', (e) => {
      e.stopPropagation();
      ui.panel.classList.toggle('hidden');
    });
    ui.auto.addEventListener('change', () => {
      const m = (pref['sr-auto'] = pref['sr-auto'] || {});
      if (ui.auto.checked) m[host] = true; else delete m[host];
      prefSet({ 'sr-auto': m });
    });
    ui.hide.addEventListener('change', () => {
      const m = (pref['sr-hidden'] = pref['sr-hidden'] || {});
      if (ui.hide.checked) m[host] = true; else delete m[host];
      prefSet({ 'sr-hidden': m });
      if (ui.hide.checked) ui.host.style.display = 'none';
    });
    document.addEventListener('click', (e) => {
      if (!e.composedPath().includes(ui.host)) ui.panel.classList.add('hidden');
    }, true);

    /* the library page asks for a specific page to be converted ("Open" on a saved paper);
       only a page that passed the whitelist + article gates ever registers this listener */
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.type !== 'SR_CONVERT') return;
      if (S.state === 'working') { sendResponse({ ok: true, busy: true }); return; }
      /* convert() owns the state machine — setting "working" here made it return on its own
         guard and left the page stuck (the tab then never navigated) */
      convert();
      sendResponse({ ok: true });
    });

    if (ui.auto.checked && !S.autoDone) {
      S.autoDone = true;
      if (!sessionStorage.getItem('sr-auto-' + location.href)) {
        sessionStorage.setItem('sr-auto-' + location.href, '1');
        setTimeout(convert, 900);
      }
    }
  })();
})();

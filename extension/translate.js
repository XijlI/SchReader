/* ============================================================
   SchReader — selection translation (划词翻译).

   Select text in the reader, a small 「译」 button appears next to the
   highlight pen; click it (or press `y`) and the translation floats
   beside the selection. The popup shows the translation only — the
   source sentence is kept for "Save to note", which files
   original + translation into the article's library note.

   Engine: Google's public translate endpoint. No key, no account, and
   it answers with `Access-Control-Allow-Origin: *`, so both hosts (the
   extension page and the Android WebView) can call it with a plain
   fetch — no host permission, which matters because
   `sync_whitelist.py` owns `host_permissions` and would wipe one.

   Target language lives in localStorage `sr-tr-lang` (default zh-CN).
   ============================================================ */
(() => {
  'use strict';

  const API = 'https://translate.googleapis.com/translate_a/single';
  /* the text travels in the query string, so a long paragraph is split
     at a space and stitched back together */
  const MAX_Q = 1200;
  const CJK = /^(zh|ja|ko|th)/i;

  const S = {
    paper: null,
    target: 'zh-CN',
    on: true,
    onSaveNote: null,
    range: null,
    text: '',
    result: '',
    source: '',
    busy: false,
    error: '',
    seq: 0,
  };
  const cache = new Map();
  let btn = null;
  let pop = null;
  let body = null;
  let foot = null;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  /* ---------------------------------------------------------
     Engine
     --------------------------------------------------------- */
  function split(text, max) {
    const out = [];
    let rest = text;
    while (rest.length > max) {
      let cut = rest.lastIndexOf(' ', max);
      if (cut < max * 0.4) cut = max;         /* CJK has no spaces to cut on */
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^\s+/, '');
    }
    if (rest) out.push(rest);
    return out;
  }

  async function request(text, target) {
    const url = `${API}?client=gtx&sl=auto&tl=${encodeURIComponent(target)}`
      + `&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const segs = Array.isArray(data && data[0]) ? data[0] : [];
    const out = segs.map((seg) => (seg && seg[0]) || '').join('').trim();
    if (!out) throw new Error('empty');
    return { text: out, from: String((data && data[2]) || '').toLowerCase() };
  }

  function describe(e) {
    const msg = String((e && e.message) || e || '');
    if ((e && e.status) === 429) return 'Too many requests — wait a minute and retry.';
    if (/^HTTP 4\d\d/.test(msg)) return 'The translation service refused the request (' + msg + ').';
    if (/^HTTP 5\d\d/.test(msg)) return 'The translation service is having trouble — retry shortly.';
    if (/empty/i.test(msg)) return 'Nothing came back for that selection.';
    if (/fetch|network|Failed/i.test(msg)) return 'Cannot reach the translation service — check your connection.';
    return 'Translation failed.';
  }

  async function translate(text, target) {
    const key = target + '|' + text;
    if (cache.has(key)) return cache.get(key);
    const parts = split(text, MAX_Q);
    const glue = CJK.test(target) ? '' : ' ';
    let out = '';
    let from = '';
    for (const part of parts) {
      const r = await request(part, target);
      out += (out ? glue : '') + r.text;
      if (r.from) from = r.from;
    }
    const got = { text: out.trim(), from };
    cache.set(key, got);
    return got;
  }

  /* ---------------------------------------------------------
     DOM
     --------------------------------------------------------- */
  function ensureDom() {
    if (btn) return;

    btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'trBtn';
    btn.className = 'trbtn';
    btn.hidden = true;
    btn.title = 'Translate this selection (y)';
    btn.textContent = '译';
    document.body.appendChild(btn);

    pop = document.createElement('div');
    pop.id = 'trPop';
    pop.className = 'trpop';
    pop.hidden = true;
    pop.innerHTML = '<div class="trpop-body" id="trBody"></div>'
      + '<div class="trpop-foot">'
      + '<span class="trpop-src" id="trSrc">Google</span>'
      + '<button type="button" data-act="copy">Copy</button>'
      + '<button type="button" data-act="note">Save to note</button>'
      + '<button type="button" class="x" data-act="close" aria-label="Close">✕</button>'
      + '</div>';
    document.body.appendChild(pop);
    body = document.getElementById('trBody');
    foot = pop.querySelector('.trpop-foot');

    /* keep the selection alive while a button in the card is pressed */
    pop.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
    pop.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const b = e.target.closest('button');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'close') hidePop();
      else if (act === 'retry') run();
      else if (act === 'copy') copyResult();
      else if (act === 'note') saveNote(b);
    });

    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      run();
    });
  }

  function placeBtn() {
    if (!btn || btn.hidden) return;
    const pen = document.getElementById('hlBar');
    const ref = (pen && !pen.hidden) ? pen.getBoundingClientRect() : anchor();
    if (!ref) { hideBtn(); return; }
    const size = btn.offsetWidth || 30;
    let x = ref.right + 6;
    let y = ref.top;
    if (x + size > window.innerWidth - 8) x = ref.left - size - 6;
    if (y < 56) y = ref.bottom + 6;
    btn.style.left = `${Math.round(Math.max(8, x))}px`;
    btn.style.top = `${Math.round(Math.max(8, y))}px`;
  }

  function anchor() {
    if (!S.range) return null;
    /* the bounding rect of the whole range, not the last line: a paragraph-long selection
       reaches past the fold, and a "last rect" anchor puts the card a screen below it */
    let r = null;
    try { r = S.range.getBoundingClientRect(); } catch (e) { return null; }
    return (r && (r.width || r.height)) ? r : null;
  }

  function placePop() {
    const r = anchor();
    if (!r) return;
    const w = pop.offsetWidth || 320;
    const h = pop.offsetHeight || 120;
    let y = r.bottom + 10;
    if (y + h > window.innerHeight - 10) y = r.top - h - 10;
    const top = Math.max(56, window.innerHeight - h - 10);
    y = Math.max(56, Math.min(y, top));
    let x = r.left;
    x = Math.max(10, Math.min(x, window.innerWidth - w - 10));
    pop.style.left = `${Math.round(x)}px`;
    pop.style.top = `${Math.round(y)}px`;
  }

  function showBtn() {
    if (!btn) return;
    btn.hidden = false;
    placeBtn();
  }
  function hideBtn() { if (btn) btn.hidden = true; }

  function showPop() {
    if (!pop) return;
    pop.hidden = false;
    render();
    placePop();
  }
  function hidePop() {
    if (!pop) return;
    pop.hidden = true;
    S.busy = false;
    S.error = '';
    const retry = pop.querySelector('[data-act="retry"]');
    if (retry) retry.remove();
  }

  /* ---------------------------------------------------------
     Render
     --------------------------------------------------------- */
  function render() {
    if (!body) return;
    if (S.busy) {
      body.innerHTML = '<span class="trwait">Translating…</span>';
      foot.classList.add('quiet');
      return;
    }
    if (S.error) {
      /* static markup plus an escaped message — nothing from the page or the engine lands here raw */
      body.innerHTML = `<span class="trerr">${esc(S.error)}</span>`
        + '<button type="button" class="tract" data-act="retry">Retry</button>';
      foot.classList.add('quiet');
      return;
    }
    /* the engine's answer is plain text; never innerHTML it back */
    body.textContent = S.result;
    foot.classList.remove('quiet');
    const src = document.getElementById('trSrc');
    if (src) src.textContent = 'Google' + (S.source ? ' · ' + S.source : '');
  }

  function flash(act, label) {
    const b = pop && pop.querySelector(`[data-act="${act}"]`);
    if (!b) return;
    const was = b.textContent;
    b.textContent = label;
    b.classList.add('flash');
    setTimeout(() => { b.textContent = was; b.classList.remove('flash'); }, 1500);
  }

  /* ---------------------------------------------------------
     Actions
     --------------------------------------------------------- */
  async function run() {
    if (!S.text || S.busy || !S.on) return;
    hideBtn();
    S.busy = true;
    S.error = '';
    S.result = '';
    S.source = '';
    showPop();
    const seq = ++S.seq;
    try {
      const got = await translate(S.text, S.target);
      if (seq !== S.seq) return;
      S.result = got.text;
      S.source = got.from;
    } catch (e) {
      if (seq !== S.seq) return;
      S.error = describe(e);
    }
    if (seq !== S.seq) return;
    S.busy = false;
    render();
    placePop();
  }

  async function copyResult() {
    if (!S.result) return;
    /* navigator.clipboard is the right API but it rejects when the page is not focused
       (headless runs, a WebView that lost focus) — fall back to the old execCommand path
       instead of telling the user "Copy failed" while the text is right there. */
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(S.result);
        ok = true;
      }
    } catch (e) { ok = false; }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = S.result;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch (e) { ok = false; }
    }
    flash('copy', ok ? 'Copied ✓' : 'Copy failed');
  }

  async function saveNote(b) {
    if (!S.result || !S.onSaveNote) return;
    const was = b.textContent;
    b.disabled = true;
    try {
      const res = await S.onSaveNote(S.text, S.result);
      b.textContent = res && res.ok ? 'Saved ✓' : 'Not saved';
    } catch (e) {
      b.textContent = 'Not saved';
    }
    setTimeout(() => { b.textContent = was; b.disabled = false; }, 1700);
  }

  /* ---------------------------------------------------------
     Selection plumbing
     --------------------------------------------------------- */
  function readSelection() {
    if (!S.paper) return null;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (!S.paper.contains(range.commonAncestorContainer)) return null;
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return { range: range.cloneRange(), text };
  }

  function syncSelection() {
    if (!S.on) { hideBtn(); return; }
    const got = readSelection();
    if (!got) { hideBtn(); return; }
    S.range = got.range;
    S.text = got.text;
    showBtn();
  }

  function onScroll() {
    if (!pop || !pop.hidden) {
      const r = anchor();
      if (r && r.bottom > 0 && r.top < window.innerHeight) placePop();
      else hidePop();
    }
    if (btn && !btn.hidden) {
      const r = anchor();
      if (!r || r.bottom < 0 || r.top > window.innerHeight) hideBtn();
      else placeBtn();
    }
  }

  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && typeof t.matches === 'function'
      && (t.matches('input, textarea, select') || t.isContentEditable)) return;
    const lb = document.getElementById('lb');
    const lbOpen = lb && !lb.hidden;

    if (e.key === 'Escape') {
      if (pop && !pop.hidden) { hidePop(); hideBtn(); }
      return;
    }
    if (lbOpen) return;
    if (!S.on) return;
    if (e.key.toLowerCase() !== 'y' || S.busy) return;
    const got = readSelection();
    if (!got) return;
    S.range = got.range;
    S.text = got.text;
    e.preventDefault();
    run();
  }

  /* ---------------------------------------------------------
     Public
     --------------------------------------------------------- */
  function init(o) {
    const opts = o || {};
    S.paper = opts.paper || document.getElementById('paper');
    S.onSaveNote = opts.onSaveNote || null;
    let lang = '';
    try { lang = localStorage.getItem('sr-tr-lang') || ''; } catch (e) { /* ignore */ }
    S.target = opts.target || lang || 'zh-CN';
    let on = '';
    try { on = localStorage.getItem('sr-tr-on') || ''; } catch (e) { /* ignore */ }
    S.on = on !== '0';
    ensureDom();

    document.addEventListener('pointerup', (e) => {
      if (e.target.closest && e.target.closest('#trBtn, #trPop, #hlBar, #hlPal')) return;
      setTimeout(syncSelection, 10);
    });
    document.addEventListener('keyup', (e) => {
      if (e.shiftKey || e.key === 'Shift' || e.key.indexOf('Arrow') === 0) syncSelection();
    });
    document.addEventListener('selectionchange', () => {
      const sel = window.getSelection();
      if ((!sel || sel.isCollapsed) && !S.busy) hideBtn();
    });
    document.addEventListener('mousedown', (e) => {
      if (!pop || pop.hidden) return;
      if (e.target.closest && e.target.closest('#trPop')) return;
      hidePop();
    });
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', () => {
      if (pop && !pop.hidden) placePop();
      placeBtn();
    });

    /* the settings panel is another document, so it reaches us through `storage` (and only that
       way — this page never sees its own writes): switch off, or switch the target language, and
       the reader follows without a reload */
    window.addEventListener('storage', (e) => {
      if (!e.key || e.key.indexOf('sr-tr-') !== 0) return;
      let raw = '';
      let lng = '';
      try {
        raw = localStorage.getItem('sr-tr-on') || '1';
        lng = localStorage.getItem('sr-tr-lang') || '';
      } catch (err) { /* ignore */ }
      S.on = raw !== '0';
      if (lng) S.target = lng;
      cache.clear();
      if (!S.on) { hideBtn(); hidePop(); }
    });

    /* the paper keeps a fixed size — anything that reflows it moves the anchor */
    if ('ResizeObserver' in window && S.paper) {
      new ResizeObserver(() => { if (pop && !pop.hidden) placePop(); }).observe(S.paper);
    }
  }

  globalThis.SR_TRANSLATE = { init, run, hidePop, hideBtn, translate };
})();

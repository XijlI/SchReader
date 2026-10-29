/* SchReader — library page: list, search, tags, notes, export/import, history. */
(() => {
  'use strict';

  const LIB = window.SR_LIB;
  if (!LIB) return;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  /* entries can be imported from a .bib/.json file, so never trust a stored URL with a
     javascript:/data: scheme — only http(s) is ever rendered as a link or handed to Open. */
  const safeUrl = (u) => /^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim() : '';

  /* Every innerHTML below interpolates only values passed through esc()/safeUrl(); the item
     markup is ours, not publisher HTML (that never reaches this page). */

  const S = {
    view: 'library',
    items: [],
    history: [],
    q: '',
    sort: 'added',
    tag: null,
    editing: null,
  };

  /* ------------------------------------------------------------ theme (shared with the reader) */
  /* settings.js owns the picker and the list of skins; this page only has to paint the stored
     choice before the list renders, then repaint when the panel changes it. An unknown id (e.g.
     the reader's "custom" colour mixer) matches no palette block and falls back to light. */
  const APP = (typeof SchReader !== 'undefined' && SchReader && typeof SchReader.libLoad === 'function');

  function storedTheme() {
    try { return localStorage.getItem('sr-theme') || 'light'; } catch (e) { return 'light'; }
  }

  document.documentElement.dataset.theme = storedTheme();
  if (APP) document.documentElement.classList.add('app');
  /* theme.js owns the paint: it also clears a custom palette's inline tokens and tells the
     Android shell about the new colours */
  window.addEventListener('sr-theme', () => {
    if (window.NVTheme) window.NVTheme.apply();
  });

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('on'), 2200);
  }

  /* ------------------------------------------------------------ platform glue */
  function openArticle(item) {
    const url = safeUrl(item && item.url);
    if (!url) { toast('This entry has no link to open'); return; }
    item = Object.assign({}, item, { url });
    if (typeof SchReader !== 'undefined' && SchReader && typeof SchReader.openArticle === 'function') {
      try { SchReader.openArticle(item.url); return; } catch (e) { /* fall through */ }
    }
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: 'SR_OPEN_ITEM', url: item.url, id: item.id }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) toast('Could not open that page');
      });
      return;
    }
    /* dev harness: the publisher page is served from the same origin */
    location.href = item.url;
  }

  function closePage() {
    if (typeof SchReader !== 'undefined' && SchReader && typeof SchReader.closeLibrary === 'function') {
      try { SchReader.closeLibrary(); return; } catch (e) { /* fall through */ }
    }
    if (window.history.length > 1) window.history.back();
    else window.close();
  }

  /* ------------------------------------------------------------ rendering */
  const fmtDate = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    const now = Date.now();
    const days = Math.round((now - ts) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return days + ' days ago';
    return d.toISOString().slice(0, 10);
  };

  const tagCounts = (items) => {
    const map = new Map();
    for (const it of items) for (const t of (it.tags || [])) map.set(t, (map.get(t) || 0) + 1);
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };

  function matches(item) {
    if (S.tag && !(item.tags || []).includes(S.tag)) return false;
    if (!S.q) return true;
    const hay = [
      item.title, (item.authors || []).join(' '), item.journal, item.year, item.doi,
      (item.tags || []).join(' '), item.note,
    ].join(' ').toLowerCase();
    return S.q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }

  function sortItems(items) {
    const copy = items.slice();
    if (S.sort === 'title') copy.sort((a, b) => String(a.title).localeCompare(String(b.title)));
    else if (S.sort === 'year') copy.sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0));
    else if (S.sort === 'read') copy.sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0));
    else copy.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    return copy;
  }

  function itemHtml(item) {
    const authors = (item.authors || []).join(', ');
    const meta = [
      item.journal ? `<b>${esc(item.journal)}</b>` : '',
      item.year ? esc(item.year) : '',
      item.doi ? `<span title="${esc(item.doi)}">doi:${esc(item.doi)}</span>` : '',
    ].filter(Boolean).join('<span class="dot">·</span>');
    const tags = (item.tags || []).length
      ? `<div class="tags">${item.tags.map((t) => `<button class="tagbtn" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div>`
      : '';
    const pct = item.progress && item.progress.pct ? Math.round(item.progress.pct) : 0;
    const progress = pct >= 3
      ? `<div class="progress"><div class="track"><i style="width:${Math.min(pct, 100)}%"></i></div><span>read ${Math.min(pct, 100)}%</span></div>`
      : '';
    return `
      <article class="item" data-id="${esc(item.id)}">
        <div>
          <h3><a href="${esc(safeUrl(item.url) || '#')}" data-open="${esc(item.id)}">${esc(item.title || 'Untitled article')}</a></h3>
          <div class="meta">${meta}</div>
          ${authors ? `<div class="authors" title="${esc(authors)}">${esc(authors)}</div>` : ''}
          ${item.note ? `<div class="note">${esc(item.note)}</div>` : ''}
          ${tags}
          ${progress}
        </div>
        <div class="acts">
          <button class="open" data-open="${esc(item.id)}">Open ↗</button>
          ${item.doi ? `<button data-copy="${esc(item.doi)}">Copy DOI</button>` : ''}
          <button data-edit="${esc(item.id)}">Tags · note</button>
          <button class="del" data-del="${esc(item.id)}">Delete</button>
        </div>
      </article>`;
  }

  function historyHtml(entry) {
    const safe = safeUrl(entry.url);
    const host = (() => { try { return new URL(safe).host; } catch (e) { return entry.journal || ''; } })();
    return `
      <article class="item" data-url="${esc(safe)}">
        <div>
          <h3><a href="${esc(safe || '#')}" data-open-url="${esc(safe)}">${esc(entry.title || entry.url)}</a></h3>
          <div class="meta"><b>${esc(entry.journal || host)}</b><span class="dot">·</span>${esc(fmtDate(entry.ts))}</div>
        </div>
        <div class="acts">
          <button class="open" data-open-url="${esc(entry.url)}">Open ↗</button>
        </div>
      </article>`;
  }

  function render() {
    const isHist = S.view === 'history';
    const source = isHist ? S.history : S.items;
    const shown = isHist
      ? source.filter((e) => !S.q || String(e.title || '').toLowerCase().includes(S.q.toLowerCase()))
      : sortItems(source.filter(matches));

    $('#countLib').textContent = S.items.length ? String(S.items.length) : '';
    $('#countHist').textContent = S.history.length ? String(S.history.length) : '';
    $('#list').innerHTML = shown.map(isHist ? historyHtml : itemHtml).join('');
    $('#empty').hidden = shown.length > 0;
    $('#empty').querySelector('h2').textContent = isHist
      ? (S.history.length ? 'No match' : 'No history yet')
      : (S.items.length ? 'Nothing matches' : 'Nothing saved yet');

    const tags = tagCounts(S.items);
    $('#tagList').innerHTML = tags.length
      ? `<button class="tagbtn ${S.tag ? '' : 'on'}" data-tag="">All<span class="n">${S.items.length}</span></button>` +
        tags.map(([t, n]) => `<button class="tagbtn ${S.tag === t ? 'on' : ''}" data-tag="${esc(t)}">${esc(t)}<span class="n">${n}</span></button>`).join('')
      : '<p class="hint">No tags yet — open “Tags · note” on an entry.</p>';
  }

  async function reload() {
    S.items = await LIB.list();
    S.history = (await LIB.history()).slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
    render();
  }

  /* ------------------------------------------------------------ actions */
  async function editItem(id) {
    const item = S.items.find((i) => i.id === id);
    if (!item) return;
    S.editing = id;
    $('#mTitle').textContent = item.title || 'Edit entry';
    $('#mTags').value = (item.tags || []).join(', ');
    $('#mNote').value = item.note || '';
    $('#modal').hidden = false;
    $('#mTags').focus();
  }

  async function saveEdit() {
    if (!S.editing) return;
    const tags = $('#mTags').value.split(',').map((t) => t.trim()).filter(Boolean)
      .filter((t, i, arr) => arr.indexOf(t) === i);
    await LIB.patch(S.editing, { tags, note: $('#mNote').value.trim() });
    $('#modal').hidden = true;
    S.editing = null;
    await reload();
    toast('Saved');
  }

  function exportAs(fmt) {
    const items = sortItems(S.items.filter(matches));
    if (!items.length) { toast('Nothing to export'); return; }
    const stamp = new Date().toISOString().slice(0, 10);
    const jobs = {
      bibtex: () => ['schreader-' + stamp + '.bib', LIB.bibtex(items), 'application/x-bibtex'],
      ris: () => ['schreader-' + stamp + '.ris', LIB.ris(items), 'application/x-research-info-systems'],
      csv: () => ['schreader-' + stamp + '.csv', LIB.csv(items), 'text/csv'],
      json: () => ['schreader-' + stamp + '.json', LIB.json(items), 'application/json'],
    };
    const job = jobs[fmt];
    if (!job) return;
    const [name, text, mime] = job();
    LIB.download(name, text, mime).then((ok) => toast(ok ? `Exported ${items.length} entries → ${name}` : 'Export failed'));
  }

  /* ------------------------------------------------------------ wiring */
  /* The settings panel is mounted on first open. Mounting rebuilds its DOM and attaches one
     chrome.storage listener, so mounting per open would stack duplicate listeners. */
  let settingsMounted = false;
  function openSettings() {
    if (!settingsMounted && window.SR_SETTINGS) {
      settingsMounted = true;
      window.SR_SETTINGS.mount($('#settingsBody'));
    }
    $('#settingsModal').hidden = false;
  }

  function closeSettings() {
    $('#settingsModal').hidden = true;
  }

  function wire() {
    $$('.tab').forEach((b) => b.addEventListener('click', () => {
      $$('.tab').forEach((x) => x.classList.toggle('on', x === b));
      S.view = b.dataset.view;
      render();
    }));

    $('#q').addEventListener('input', (e) => { S.q = e.target.value.trim(); render(); });
    $('#sort').addEventListener('change', (e) => { S.sort = e.target.value; render(); });
    $('#btnBack').addEventListener('click', closePage);
    /* the app has no tab to close — the bottom bar is the way back */
    if (APP) $('#btnBack').hidden = true;

    $('#btnSettings').addEventListener('click', openSettings);
    $('#setDone').addEventListener('click', closeSettings);
    $('#settingsModal').addEventListener('click', (e) => {
      if (e.target === $('#settingsModal')) closeSettings();
    });
    /* the panel wrote the history flag: keep the side panel's checkbox in step */
    window.addEventListener('sr-settings', (e) => {
      if (e && e.detail && typeof e.detail.history === 'boolean') $('#optHistory').checked = e.detail.history;
    });

    $('#list').addEventListener('click', async (e) => {
      const open = e.target.closest('[data-open]');
      if (open) {
        e.preventDefault();
        const item = S.items.find((i) => i.id === open.dataset.open);
        if (item) openArticle(item);
        return;
      }
      const openUrl = e.target.closest('[data-open-url]');
      if (openUrl) {
        e.preventDefault();
        openArticle({ url: openUrl.dataset.openUrl, id: '' });
        return;
      }
      const tag = e.target.closest('.tagbtn[data-tag]');
      if (tag) { e.preventDefault(); S.tag = tag.dataset.tag || null; render(); return; }
      const edit = e.target.closest('[data-edit]');
      if (edit) { editItem(edit.dataset.edit); return; }
      const copy = e.target.closest('[data-copy]');
      if (copy) {
        try { await navigator.clipboard.writeText(copy.dataset.copy); toast('DOI copied'); }
        catch (err) { toast('Copy failed: ' + (err && err.message || err)); }
        return;
      }
      const del = e.target.closest('[data-del]');
      if (del) {
        await LIB.remove(del.dataset.del);
        await reload();
        toast('Removed');
      }
    });

    $('#tagList').addEventListener('click', (e) => {
      const t = e.target.closest('.tagbtn');
      if (!t) return;
      S.tag = t.dataset.tag || null;
      render();
    });

    $('#modal').addEventListener('click', (e) => {
      if (e.target === $('#modal') || e.target.closest('#mCancel')) {
        $('#modal').hidden = true;
        S.editing = null;
      }
    });
    $('#mSave').addEventListener('click', saveEdit);

    $('#btnExport').addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = $('#exportMenu');
      const r = e.currentTarget.getBoundingClientRect();
      menu.style.top = (r.bottom + 6) + 'px';
      menu.style.left = Math.max(8, r.right - menu.offsetWidth) + 'px';
      menu.hidden = !menu.hidden;
    });
    $('#exportMenu').addEventListener('click', (e) => {
      const b = e.target.closest('[data-fmt]');
      if (!b) return;
      $('#exportMenu').hidden = true;
      exportAs(b.dataset.fmt);
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#exportMenu') && !e.target.closest('#btnExport')) $('#exportMenu').hidden = true;
    });

    $('#btnImport').addEventListener('click', () => $('#file').click());
    $('#file').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const res = await LIB.importItems(text);
        await reload();
        toast(`Imported ${res.added} new entries (${res.total} total)`);
      } catch (err) {
        toast('Import failed: ' + (err && err.message || err));
      }
      e.target.value = '';
    });

    $('#optHistory').addEventListener('change', async (e) => {
      await LIB.saveSettings({ history: e.target.checked });
      toast(e.target.checked ? 'History on' : 'History off');
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!$('#settingsModal').hidden) { closeSettings(); return; }
        if (!$('#modal').hidden) { $('#modal').hidden = true; S.editing = null; return; }
        if (!$('#exportMenu').hidden) { $('#exportMenu').hidden = true; return; }
      }
      if ((e.key === '/' || (e.key === 'f' && (e.metaKey || e.ctrlKey))) && document.activeElement !== $('#q')) {
        e.preventDefault();
        $('#q').focus();
      }
    });
  }

  async function boot() {
    /* tell the worker which tab this is, so "My library" focuses it instead of opening another */
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'SR_LIBRARY_HELLO' }, () => void chrome.runtime.lastError);
      }
    } catch (e) { /* ignore */ }
    const settings = await LIB.getSettings();
    $('#optHistory').checked = settings.history !== false;
    /* the app re-reads the store when you come back to this tab (it stays loaded while you read) */
    window.addEventListener('sr-refresh', () => { reload(); });
    wire();
    /* options.html redirects here with ?settings=1 ("Extension options" in Chrome), and the pill's
       "allowed sites…" adds &add=<host> so the domain is already typed in */
    try {
      const params = new URLSearchParams(location.search);
      if (params.get('settings')) {
        openSettings();
        const want = params.get('add');
        const input = $('#setAddInput');
        if (want && input) {
          input.value = want;
          input.focus();
          input.select();
        }
      }
    } catch (e) { /* ignore */ }
    await reload();
    /* the library is the page a device lands on, so it is where a pull happens: once on boot,
       and again whenever the tab comes back to the front without a reload */
    if (LIB.sync) {
      LIB.sync.sync().then((r) => { if (r && r.ok) reload(); });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          LIB.sync.sync().then((r) => { if (r && r.ok) reload(); });
        }
      });
    }
    /* no auto-focus in the app: it pops the keyboard and nudges the page on load */
    if (!APP) $('#q').focus();
  }

  boot();
})();

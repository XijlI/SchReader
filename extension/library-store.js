/* SchReader — the library store.

   One shape for all three hosts:
     Chrome extension  → chrome.storage.local  (keys sr-lib, sr-history, sr-lib-settings)
     Android app       → the SchReader bridge when the native store is present, else localStorage
     dev harness       → localStorage

   An entry is metadata + the publisher URL only — no article text, no PDFs. The full text is
   re-parsed from the page when you open it, which is why the extension could drop `unlimitedStorage`.
*/
(() => {
  'use strict';

  const LIB_KEY = 'sr-lib';
  const HIST_KEY = 'sr-history';
  const SET_KEY = 'sr-lib-settings';
  /* the Search tab's "my sites" list: one shape for both hosts, so a shortcut added on the
     phone is not a second, drifting list next to a browser-only one */
  const SITES_KEY = 'sr-search-sites';
  const HISTORY_MAX = 500;

  const chromeStore = () =>
    (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) ? chrome.storage.local : null;
  const native = () =>
    (typeof SchReader !== 'undefined' && SchReader && typeof SchReader.libLoad === 'function') ? SchReader : null;

  async function readRaw(key, fallback) {
    const bridge = native();
    if (bridge) {
      try {
        const txt = bridge.libLoad(key);
        if (txt) return JSON.parse(txt);
      } catch (e) { /* fall through */ }
      return fallback;
    }
    const store = chromeStore();
    if (store) {
      try {
        const got = await store.get(key);
        if (got && got[key] !== undefined) return got[key];
      } catch (e) { /* fall through to localStorage */ }
    }
    try {
      const txt = localStorage.getItem(key);
      if (txt) return JSON.parse(txt);
    } catch (e) { /* ignore */ }
    return fallback;
  }

  async function writeRaw(key, value) {
    const bridge = native();
    if (bridge) {
      try { bridge.libSave(key, JSON.stringify(value)); return true; } catch (e) { return false; }
    }
    const store = chromeStore();
    if (store) {
      try { await store.set({ [key]: value }); return true; } catch (e) { /* fall through */ }
    }
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }

  /* ------------------------------------------------------------ identity */

  /* DOI beats URL beats title: the same paper is reached from the publisher, a DOI link and
     Google Scholar, and only the DOI is stable across those. */
  function keyFor(article) {
    const meta = (article && article.meta) || {};
    const src = (article && article.source) || {};
    const doi = String(meta.doi || '').toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').trim();
    if (doi) return 'doi:' + doi;
    if (src.url) return 'url:' + String(src.url).split('#')[0];
    if (meta.title) return 'title:' + String(meta.title).toLowerCase().slice(0, 200);
    return '';
  }

  const authorsOf = (article) => {
    const meta = (article && article.meta) || {};
    const list = Array.isArray(meta.authors) ? meta.authors : [];
    return list.map((a) => (typeof a === 'string' ? a : a && (a.name || a.text) || '')).filter(Boolean);
  };

  function entryFrom(article) {
    const meta = (article && article.meta) || {};
    const src = (article && article.source) || {};
    const year = String(meta.date || meta.year || '').match(/\d{4}/);
    return {
      id: keyFor(article),
      url: src.url || '',
      doi: String(meta.doi || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim(),
      title: String(meta.title || 'Untitled article').trim(),
      authors: authorsOf(article),
      journal: String(meta.journal || src.journal || src.host || '').trim(),
      year: year ? year[0] : '',
      addedAt: Date.now(),
      lastReadAt: Date.now(),
      tags: [],
      note: '',
      progress: null,
    };
  }

  /* ------------------------------------------------------------ library */

  const byAdded = (a, b) => (b.addedAt || 0) - (a.addedAt || 0);

  async function list() {
    const items = await readRaw(LIB_KEY, []);
    return Array.isArray(items) ? items.filter((i) => i && i.id).sort(byAdded) : [];
  }

  async function saveAll(items) {
    return writeRaw(LIB_KEY, (items || []).slice().sort(byAdded));
  }

  async function get(id) {
    return (await list()).find((i) => i.id === id) || null;
  }

  async function upsert(entry) {
    const items = await list();
    const i = items.findIndex((x) => x.id === entry.id);
    if (i >= 0) items[i] = Object.assign({}, items[i], entry, { addedAt: items[i].addedAt || entry.addedAt });
    else items.unshift(entry);
    await saveAll(items);
    return entry;
  }

  async function patch(id, fields) {
    const items = await list();
    const i = items.findIndex((x) => x.id === id);
    if (i < 0) return null;
    items[i] = Object.assign({}, items[i], fields);
    await saveAll(items);
    return items[i];
  }

  async function remove(id) {
    const items = (await list()).filter((x) => x.id !== id);
    await saveAll(items);
    return true;
  }

  /* ------------------------------------------------------------ history */

  async function history() {
    const list_ = await readRaw(HIST_KEY, []);
    return Array.isArray(list_) ? list_ : [];
  }

  async function pushHistory(entry) {
    const settings = await getSettings();
    if (settings.history === false || !entry || !entry.id) return;
    const items = await history();
    const rest = items.filter((x) => x.id !== entry.id);
    rest.unshift(entry);
    await writeRaw(HIST_KEY, rest.slice(0, HISTORY_MAX));
  }

  async function clearHistory() {
    return writeRaw(HIST_KEY, []);
  }

  async function getSettings() {
    const s = await readRaw(SET_KEY, {});
    return Object.assign({ history: true }, s || {});
  }

  async function saveSettings(patch_) {
    const next = Object.assign(await getSettings(), patch_ || {});
    await writeRaw(SET_KEY, next);
    return next;
  }

  /* ------------------------------------------------------------ search shortcuts */

  /* [{name, url}] — the Search tab's own list, on top of the fixed built-ins in search.js.
     Entries are validated on the way in AND on the way out: an imported/edited store must not
     be able to hand a javascript: URL to a browser. */
  const cleanSite = (raw) => {
    const name = String((raw && raw.name) || '').trim().slice(0, 60);
    const url = String((raw && raw.url) || '').trim();
    if (!name || !/^https?:\/\/[^\s]+$/i.test(url)) return null;
    return { name, url };
  };

  async function searchSites() {
    const list = await readRaw(SITES_KEY, []);
    return (Array.isArray(list) ? list : []).map(cleanSite).filter(Boolean);
  }

  async function saveSearchSites(list) {
    const clean = (Array.isArray(list) ? list : []).map(cleanSite).filter(Boolean);
    await writeRaw(SITES_KEY, clean);
    return clean;
  }

  /* ------------------------------------------------------------ export */

  const pad = (n) => String(n || '').replace(/\s+/g, ' ').trim();

  function bibKey(item) {
    const fam = pad((item.authors && item.authors[0]) || '').split(/[,\s]/)[0] || 'ref';
    const word = pad(item.title).split(/\s+/).find((w) => w.length > 3) || '';
    return (fam + (item.year || '') + word).replace(/[^A-Za-z0-9]/g, '') || 'ref';
  }

  function bibtex(items) {
    const seen = new Map();
    return items.map((it) => {
      let key = bibKey(it);
      if (seen.has(key)) { seen.set(key, seen.get(key) + 1); key += String.fromCharCode(96 + seen.get(key)); }
      else seen.set(key, 0);
      const fields = [
        ['title', pad(it.title)],
        ['author', (it.authors || []).join(' and ')],
        ['journal', pad(it.journal)],
        ['year', it.year],
        ['doi', it.doi],
        ['url', it.url],
        ['keywords', (it.tags || []).join(', ')],
        ['note', pad(it.note)],
      ].filter(([, v]) => v);
      return `@article{${key},\n${fields.map(([k, v]) => `  ${k} = {${v}}`).join(',\n')}\n}`;
    }).join('\n\n');
  }

  function ris(items) {
    return items.map((it) => [
      'TY  - JOUR',
      `TI  - ${pad(it.title)}`,
      ...(it.authors || []).map((a) => `AU  - ${pad(a)}`),
      it.journal ? `JO  - ${pad(it.journal)}` : '',
      it.year ? `PY  - ${it.year}` : '',
      it.doi ? `DO  - ${it.doi}` : '',
      it.url ? `UR  - ${it.url}` : '',
      (it.tags || []).length ? `KW  - ${it.tags.join(', ')}` : '',
      it.note ? `N1  - ${pad(it.note)}` : '',
      'ER  - ',
    ].filter(Boolean).join('\n')).join('\n\n');
  }

  function csv(items) {
    const cell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const head = ['Title', 'Authors', 'Journal', 'Year', 'DOI', 'URL', 'Tags', 'Note', 'Added'];
    const rows = items.map((it) => [
      it.title, (it.authors || []).join('; '), it.journal, it.year, it.doi, it.url,
      (it.tags || []).join('; '), it.note, it.addedAt ? new Date(it.addedAt).toISOString() : '',
    ].map(cell).join(','));
    return [head.map(cell).join(','), ...rows].join('\n');
  }

  const json = (items) => JSON.stringify(items, null, 2);

  /* ------------------------------------------------------------ import */

  function parseBibtex(text) {
    const out = [];
    const re = /@(\w+)\s*\{([^,]*),([\s\S]*?)\n\}/g;
    let m;
    while ((m = re.exec(text))) {
      const body = m[3];
      const field = (name) => {
        const f = new RegExp(name + '\\s*=\\s*(?:\\{([\\s\\S]*?)\\}|"([\\s\\S]*?)")', 'i').exec(body);
        return f ? pad(f[1] !== undefined ? f[1] : f[2]) : '';
      };
      const title = field('title').replace(/[{}]/g, '');
      if (!title) continue;
      const doi = field('doi');
      out.push({
        id: doi ? 'doi:' + doi.toLowerCase() : 'title:' + title.toLowerCase().slice(0, 200),
        title,
        authors: field('author').replace(/[{}]/g, '').split(/\s+and\s+/).map(pad).filter(Boolean),
        journal: field('journal') || field('journaltitle'),
        year: (field('year') || '').match(/\d{4}/) ? field('year').match(/\d{4}/)[0] : '',
        doi,
        url: field('url'),
        addedAt: Date.now(),
        lastReadAt: 0,
        tags: field('keywords') ? field('keywords').split(/[,;]/).map(pad).filter(Boolean) : [],
        note: '',
        progress: null,
      });
    }
    return out;
  }

  async function importItems(text) {
    const trimmed = String(text || '').trim();
    let incoming = [];
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      const data = JSON.parse(trimmed);
      incoming = Array.isArray(data) ? data : [data];
    } else {
      incoming = parseBibtex(trimmed);
    }
    const items = await list();
    const index = new Map(items.map((i) => [i.id, i]));
    let added = 0;
    for (const raw of incoming) {
      const item = Object.assign({
        id: '', url: '', doi: '', title: '', authors: [], journal: '', year: '',
        addedAt: Date.now(), lastReadAt: 0, tags: [], note: '', progress: null,
      }, raw || {});
      if (!item.id) {
        item.id = item.doi ? 'doi:' + String(item.doi).toLowerCase()
          : item.url ? 'url:' + String(item.url).split('#')[0]
            : item.title ? 'title:' + String(item.title).toLowerCase().slice(0, 200) : '';
      }
      if (!item.id) continue;
      if (index.has(item.id)) {
        const prev = index.get(item.id);
        index.set(item.id, Object.assign({}, item, {
          addedAt: prev.addedAt || item.addedAt,
          tags: Array.from(new Set([...(prev.tags || []), ...(item.tags || [])])),
          note: prev.note || item.note,
        }));
      } else {
        index.set(item.id, item);
        added += 1;
      }
    }
    await saveAll(Array.from(index.values()));
    return { added, total: index.size };
  }

  /* ------------------------------------------------------------ delivery */

  /* Chrome: a real download. Android: the WebView cannot download a blob, so hand the text to
     the native side (share sheet / file). Dev harness: download, same as Chrome. */
  async function download(filename, text, mime) {
    const bridge = native();
    if (bridge && typeof bridge.shareText === 'function') {
      try { bridge.shareText(filename, text); return true; } catch (e) { /* fall through */ }
    }
    try {
      const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      return true;
    } catch (e) {
      return false;
    }
  }

  globalThis.SR_LIB = {
    keyFor, entryFrom, list, saveAll, get, upsert, patch, remove,
    history, pushHistory, clearHistory, getSettings, saveSettings,
    searchSites, saveSearchSites,
    bibtex, ris, csv, json, importItems, download,
  };
})();

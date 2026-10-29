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

  /* Everything that lands in the library or the history is worth pushing to the other devices;
     the sync key itself is not (it would restart the loop on its own bookkeeping writes). */
  const SYNCED = (key) => key === LIB_KEY || key === HIST_KEY;

  async function writeRaw(key, value) {
    const touch = () => { if (SYNCED(key)) SYNC.auto(); };
    const bridge = native();
    if (bridge) {
      try { bridge.libSave(key, JSON.stringify(value)); touch(); return true; } catch (e) { return false; }
    }
    const store = chromeStore();
    if (store) {
      try { await store.set({ [key]: value }); touch(); return true; } catch (e) { /* fall through */ }
    }
    try { localStorage.setItem(key, JSON.stringify(value)); touch(); return true; } catch (e) { return false; }
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
      updatedAt: Date.now(),
      tags: [],
      note: '',
      progress: null,
    };
  }

  /* ------------------------------------------------------------ library */

  /* Ties break on the id: without it two devices can hold the same entries in a different order
     after a sync, and every later sync would think the list had changed. */
  const byAdded = (a, b) => (b.addedAt || 0) - (a.addedAt || 0)
    || String(a.id).localeCompare(String(b.id));

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
    const stamped = Object.assign({}, entry, { updatedAt: Date.now() });
    if (i >= 0) items[i] = Object.assign({}, items[i], stamped, { addedAt: items[i].addedAt || entry.addedAt });
    else items.unshift(stamped);
    await saveAll(items);
    return stamped;
  }

  async function patch(id, fields) {
    const items = await list();
    const i = items.findIndex((x) => x.id === id);
    if (i < 0) return null;
    items[i] = Object.assign({}, items[i], fields, { updatedAt: Date.now() });
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
    /* the timestamp is what carries a "clear" to the other device: an empty list alone is
       indistinguishable from a device that has simply read nothing yet */
    await saveSettings({ historyClearedAt: Date.now() });
    return writeRaw(HIST_KEY, []);
  }

  async function getSettings() {
    const s = await readRaw(SET_KEY, {});
    return Object.assign({ history: true, historyClearedAt: 0 }, s || {});
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

  /* ------------------------------------------------------------ sync: local view */

  /* Library, history, progress (a field on a library entry) and highlights, merged through a
     private gist. Highlights are the one thing that does not live in this store: reader.js keeps
     them under `sr-hl:<articleKey>` (chrome.storage.local in the extension, localStorage on the
     phone). The helpers below resolve the backend in exactly that order, so sync reads and writes
     the same copy the reader does instead of inventing a second one. */

  const SYNC_KEY = 'sr-sync';
  const HL_PREFIX = 'sr-hl:';

  function chromeGetAll() {
    return new Promise((resolve) => {
      const store = chromeStore();
      if (!store) return resolve(null);
      try {
        const maybe = store.get(null, (v) => resolve(v || {}));
        if (maybe && typeof maybe.then === 'function') maybe.then((v) => resolve(v || {}), () => resolve(null));
      } catch (e) { resolve(null); }
    });
  }

  async function hlAll() {
    const out = {};
    const all = await chromeGetAll();
    if (all) {
      for (const k of Object.keys(all)) {
        if (k.startsWith(HL_PREFIX) && Array.isArray(all[k])) out[k] = all[k];
      }
      return out;
    }
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(HL_PREFIX)) continue;
        try {
          const v = JSON.parse(localStorage.getItem(k));
          if (Array.isArray(v)) out[k] = v;
        } catch (e) { /* skip a corrupt key */ }
      }
    } catch (e) { /* no storage at all */ }
    return out;
  }

  async function hlPut(key, list) {
    const store = chromeStore();
    if (store) {
      try { await store.set({ [key]: list }); return true; } catch (e) { /* fall through */ }
    }
    try { localStorage.setItem(key, JSON.stringify(list)); return true; } catch (e) { return false; }
  }

  const stampOf = (item, fallback) => Number(
    (item && (item.updatedAt || item.ts || item.lastReadAt || item.addedAt)) || fallback || 0);

  const canonical = (value) => {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') {
      return '{' + Object.keys(value).sort()
        .filter((k) => value[k] !== undefined)
        .map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    }
    return JSON.stringify(value === undefined ? null : value);
  };

  /* `at` moves on every merge, so the snapshot as a whole can never be compared; only its
     content decides whether the gist needs another write. */
  const sameState = (a, b) => canonical({
    lib: (a && a.lib) || [], history: (a && a.history) || [],
    hl: (a && a.hl) || {}, clearedAt: (a && a.clearedAt) || 0,
  }) === canonical({
    lib: (b && b.lib) || [], history: (b && b.history) || [],
    hl: (b && b.hl) || {}, clearedAt: (b && b.clearedAt) || 0,
  });

  /* ------------------------------------------------------------ sync: merge */

  /* A three-way merge against the last state both sides agreed on (`base`), not just local vs
     remote: without it a delete on one device is indistinguishable from an entry the other device
     simply never had. `base` is a digest ({id: timestamp}) — small enough to keep next to the
     token, precise enough to say which side changed since. */
  function mergeMap(local, remote, base, mergePair) {
    const out = [];
    const ids = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base)]);
    for (const id of ids) {
      const L = local[id];
      const R = remote[id];
      const B = base[id];
      if (L && R) { out.push(mergePair(L, R)); continue; }
      if (L && !R) {
        /* gone from the remote copy: a delete, unless this device edited it after the last sync */
        if (B !== undefined && stampOf(L) <= B) continue;
        out.push(L);
        continue;
      }
      if (!L && R) {
        if (B !== undefined && stampOf(R) <= B) continue;
        out.push(R);
      }
    }
    return out;
  }

  function mergeEntry(a, b) {
    const newer = stampOf(a) >= stampOf(b) ? a : b;
    const older = newer === a ? b : a;
    const tags = Array.from(new Set([...(older.tags || []), ...(newer.tags || [])]));
    return Object.assign({}, older, newer, {
      tags,
      addedAt: Math.min(a.addedAt || Infinity, b.addedAt || Infinity) === Infinity
        ? newer.addedAt : Math.min(a.addedAt || Infinity, b.addedAt || Infinity),
      updatedAt: Math.max(stampOf(a), stampOf(b)),
    });
  }

  const mergeHistory = (a, b) => (stampOf(a) >= stampOf(b) ? a : b);

  const mergeHighlight = (a, b) => (Number(a.ts || 0) >= Number(b.ts || 0) ? a : b);

  function mergeSnapshots(local, remote, base) {
    const toMap = (list, keyOf) => {
      const m = {};
      for (const item of list || []) if (item && keyOf(item)) m[keyOf(item)] = item;
      return m;
    };
    const byId = (item) => item && item.id;

    const clearedAt = Math.max(local.clearedAt || 0, remote.clearedAt || 0);
    const baseLib = (base && base.lib) || {};
    const baseHist = (base && base.history) || {};
    const baseHl = (base && base.hl) || {};

    const lib = mergeMap(toMap(local.lib, byId), toMap(remote.lib, byId), baseLib, mergeEntry);

    const history = mergeMap(toMap(local.history, byId), toMap(remote.history, byId), baseHist, mergeHistory)
      .filter((h) => stampOf(h) >= clearedAt)
      .sort((a, b) => stampOf(b) - stampOf(a) || String(a.id).localeCompare(String(b.id)))
      .slice(0, HISTORY_MAX);

    const hl = {};
    const keys = new Set([...Object.keys(local.hl || {}), ...Object.keys(remote.hl || {}), ...Object.keys(baseHl)]);
    for (const key of keys) {
      const l = toMap((local.hl || {})[key], byId);
      const r = toMap((remote.hl || {})[key], byId);
      const b = baseHl[key] || {};
      const merged = mergeMap(l, r, b, mergeHighlight);
      if (merged.length) {
        hl[key] = merged.sort((x, y) => Number(x.ts || 0) - Number(y.ts || 0)
          || String(x.id).localeCompare(String(y.id)));
      }
    }
    return { v: 1, at: Date.now(), clearedAt, lib: lib.sort(byAdded), history, hl };
  }

  function digest(snap) {
    const index = (list) => {
      const m = {};
      for (const item of list || []) if (item && item.id) m[item.id] = stampOf(item);
      return m;
    };
    const hl = {};
    for (const key of Object.keys((snap && snap.hl) || {})) hl[key] = index(snap.hl[key]);
    return { lib: index(snap.lib), history: index(snap.history), hl };
  }

  /* ------------------------------------------------------------ sync: transport */

  const API = 'https://api.github.com';
  const FILE = 'schreader-sync.json';

  async function gh(path, init) {
    const cfg = await config();
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 20000) : 0;
    let res;
    try {
      /* cache: 'no-store' is not a nicety — GitHub answers gist reads with a short max-age, and a
         cached 60-second-old copy makes a device merge against its own reflection and never see
         the other phone's edit. */
      res = await fetch(API + path, Object.assign({ cache: 'no-store' }, init, {
        signal: ctrl ? ctrl.signal : undefined,
        headers: Object.assign({
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer ' + cfg.token,
          'Content-Type': 'application/json',
        }, (init && init.headers) || {}),
      }));
    } catch (e) {
      clearTimeout(timer);
      throw new Error(e && e.name === 'AbortError' ? 'GitHub did not answer in 20s' : 'Network error: ' + ((e && e.message) || e));
    }
    clearTimeout(timer);
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
    if (!res.ok) {
      const why = (body && body.message) || text.slice(0, 200) || ('HTTP ' + res.status);
      const err = new Error(res.status === 401
        ? 'GitHub rejected the token (401). Create a new one with the gist scope.'
        : res.status === 403 ? 'GitHub refused: ' + why : why);
      err.status = res.status;
      err.scopes = res.headers.get('X-OAuth-Scopes') || '';
      throw err;
    }
    return { body, scopes: res.headers.get('X-OAuth-Scopes') || '' };
  }

  const gistFiles = (body) => (body && body.files) || {};

  async function findGist() {
    for (let page = 1; page <= 3; page += 1) {
      const { body } = await gh(`/gists?per_page=100&page=${page}`);
      const list = Array.isArray(body) ? body : [];
      const hit = list.find((g) => g && g.files && g.files[FILE]);
      if (hit) return hit.id;
      if (list.length < 100) break;
    }
    return '';
  }

  async function pullSnapshot(id) {
    const { body } = await gh('/gists/' + id);
    const file = gistFiles(body)[FILE];
    const text = file && (file.content || (file.truncated && file.raw_url) || '');
    if (!text) return null;
    try {
      const snap = JSON.parse(text);
      return snap && typeof snap === 'object' ? snap : null;
    } catch (e) {
      throw new Error('The sync file in that gist is not valid JSON — not overwriting it.');
    }
  }

  async function pushSnapshot(id, snap) {
    const content = JSON.stringify(snap);
    if (!id) {
      const { body } = await gh('/gists', {
        method: 'POST',
        body: JSON.stringify({
          description: 'SchReader sync',
          public: false,
          files: { [FILE]: { content } },
        }),
      });
      return (body && body.id) || '';
    }
    await gh('/gists/' + id, {
      method: 'PATCH',
      body: JSON.stringify({ files: { [FILE]: { content } } }),
    });
    return id;
  }

  /* ------------------------------------------------------------ sync: state */

  const DEFAULTS = { token: '', login: '', gistId: '', lastSync: 0, lastError: '', base: null };

  async function config() {
    const raw = await readRaw(SYNC_KEY, null);
    return Object.assign({}, DEFAULTS, raw && typeof raw === 'object' ? raw : {});
  }

  async function saveConfig(patch_) {
    const next = Object.assign(await config(), patch_ || {});
    await writeRaw(SYNC_KEY, next);
    return next;
  }

  async function snapshot() {
    const [items, hist, hl, settings] = await Promise.all([list(), history(), hlAll(), getSettings()]);
    return {
      v: 1,
      at: Date.now(),
      clearedAt: settings.historyClearedAt || 0,
      lib: items,
      history: hist,
      hl,
    };
  }

  /* Write the merged state back. Only sections that actually moved are written: every write
     fires storage.onChanged (and on the phone a prefs commit), and a no-op sync must be free. */
  async function applySnapshot(merged) {
    const now = await snapshot();
    if (canonical(now.lib) !== canonical(merged.lib)) await saveAll(merged.lib);
    if (canonical(now.history) !== canonical(merged.history)) await writeRaw(HIST_KEY, merged.history);
    if ((now.clearedAt || 0) !== (merged.clearedAt || 0)) {
      await saveSettings({ historyClearedAt: merged.clearedAt || 0 });
    }
    const keys = new Set([...Object.keys(now.hl), ...Object.keys(merged.hl)]);
    const jobs = [];
    for (const key of keys) {
      if (canonical((now.hl || {})[key] || []) === canonical((merged.hl || {})[key] || [])) continue;
      jobs.push(hlPut(key, (merged.hl || {})[key] || []));
    }
    await Promise.all(jobs);
  }

  let quiet = false;          // set while sync itself writes, so those writes do not re-trigger it
  let pending = 0;
  let chain = Promise.resolve();   // round trips run one after another, never merged
  let running = 0;

  async function connect(token) {
    const clean = String(token || '').trim();
    if (!clean) throw new Error('Paste a GitHub token first.');
    await saveConfig({ token: clean, lastError: '' });
    try {
      const { body, scopes } = await gh('/user');
      if (scopes && !/\bgist\b/i.test(scopes)) {
        throw new Error('That token has no gist scope (it allows: ' + (scopes || 'none') + ').');
      }
      const login = (body && body.login) || '';
      const gistId = await findGist();
      await saveConfig({ login, gistId });
    } catch (e) {
      /* a rejected or unscoped token must not leave the device looking connected */
      await disconnect();
      throw e;
    }
    return sync();
  }

  async function disconnect() {
    await saveConfig({ token: '', login: '', gistId: '', lastSync: 0, lastError: '', base: null });
  }

  /* One round trip: pull, merge, write locally, push if the merged state is new.
     Calls queue instead of sharing: a "sync now" that arrives mid-flight must see the state the
     in-flight one pushed, not hand back its stale answer. */
  function sync() {
    const run = async () => {
      running += 1;
      try {
        return await roundTrip();
      } finally { running -= 1; }
    };
    const roundTrip = async () => {
      const cfg = await config();
      if (!cfg.token) return { ok: false, reason: 'not-connected' };
      try {
        let gistId = cfg.gistId;
        const remote = gistId ? await pullSnapshot(gistId) : null;
        const local = await snapshot();
        const merged = mergeSnapshots(local, remote || { v: 1, lib: [], history: [], hl: {} }, cfg.base);
        quiet = true;
        try { await applySnapshot(merged); } finally { quiet = false; }
        if (!remote || !sameState(remote, merged)) {
          gistId = await pushSnapshot(gistId, merged);
        }
        await saveConfig({ gistId, lastSync: Date.now(), lastError: '', base: digest(merged) });
        return { ok: true, at: Date.now(), counts: { lib: merged.lib.length, history: merged.history.length } };
      } catch (e) {
        const msg = (e && e.message) || String(e);
        await saveConfig({ lastError: msg });
        return { ok: false, error: msg };
      }
    };
    const next = chain.then(run, run);
    chain = next.then(() => {}, () => {});
    return next;
  }

  /* Debounced background push after a local change. A write that sync itself made (quiet) must
     not schedule another round trip, or the merge would feed itself forever. */
  function auto(delay) {
    if (quiet) return;
    clearTimeout(pending);
    pending = setTimeout(() => {
      if (quiet) return;
      config().then((cfg) => { if (cfg.token) sync(); });
    }, delay == null ? 4000 : delay);
  }

  async function state() {
    const cfg = await config();
    return {
      connected: !!cfg.token,
      login: cfg.login,
      gistId: cfg.gistId,
      lastSync: cfg.lastSync,
      lastError: cfg.lastError,
      busy: running > 0,
    };
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

  const SYNC = { sync, auto, connect, disconnect, state, config };

  globalThis.SR_LIB = {
    keyFor, entryFrom, list, saveAll, get, upsert, patch, remove,
    history, pushHistory, clearHistory, getSettings, saveSettings,
    searchSites, saveSearchSites,
    bibtex, ris, csv, json, importItems, download,
    sync: SYNC, hlAll, hlPut,
  };
})();

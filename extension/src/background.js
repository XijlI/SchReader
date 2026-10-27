/* SchReader — service worker. Parks the parsed article in session storage and
   opens the reader tab. session storage is memory-backed: nothing hits the disk,
   and everything disappears when the browser closes.

   It also owns the site whitelist: the built-in publisher domains are matched by the
   static content script in manifest.json, while every domain the user adds on the
   options page gets a dynamically registered content script — registered only after
   Chrome has actually granted the host permission for it. */
'use strict';

importScripts('/src/whitelist.js');

const SITES = self.SR_SITES;
const CUSTOM_SCRIPT_ID = 'sr-custom';

/* the manifest is the one place that lists the content-script files */
const CONTENT_FILES = Array.from(new Set(
  (chrome.runtime.getManifest().content_scripts || [])
    .reduce((all, entry) => all.concat(entry.js || []), []),
));

const patternsFor = (domain) => ['*://' + domain + '/*', '*://*.' + domain + '/*'];

async function storedCustomSites() {
  try {
    const got = await chrome.storage.local.get({ [SITES.STORAGE_KEY]: [] });
    const list = got[SITES.STORAGE_KEY];
    return Array.isArray(list) ? list.filter((d) => typeof d === 'string' && d) : [];
  } catch (err) {
    return [];
  }
}

async function grantedPatterns(domain) {
  const origins = patternsFor(domain);
  try {
    return (await chrome.permissions.contains({ origins })) ? origins : [];
  } catch (err) {
    return [];
  }
}

/* Rebuild the dynamic content script from the stored whitelist. Runs on install, on
   browser start and whenever the list changes. */
async function syncCustomSites() {
  const custom = await storedCustomSites();
  /* built-in domains are already covered by the static content script */
  const extra = custom.filter((d) => !SITES.matches(d, SITES.DEFAULT_DOMAINS));

  const matches = [];
  for (const domain of extra) matches.push(...await grantedPatterns(domain));

  try {
    await chrome.scripting.unregisterContentScripts({ ids: [CUSTOM_SCRIPT_ID] });
  } catch (err) {
    /* nothing registered yet — expected on a fresh install */
  }
  if (!matches.length || !CONTENT_FILES.length) return;

  try {
    await chrome.scripting.registerContentScripts([{
      id: CUSTOM_SCRIPT_ID,
      matches,
      js: CONTENT_FILES,
      allFrames: true,
      runAt: 'document_idle',
      persistAcrossSessions: true,
    }]);
  } catch (err) {
    console.warn('[SchReader] could not register the content script for custom sites', err);
  }
}

/* ------------------------------------------------------------ library */
const LIB_PAGE = () => chrome.runtime.getURL('library.html');
const LIB_TAB_KEY = 'sr-lib-tab';
/* The tab id is remembered instead of searching `chrome.tabs.query({url})`: filtering by URL
   needs the "tabs" permission, and without it the query silently matches nothing (which made
   every click open yet another library tab). The id also survives a service-worker restart
   through session storage, and the page itself re-announces on load. */
let libraryTabId = null;

async function rememberLibraryTab(id) {
  libraryTabId = id;
  try { await chrome.storage.session.set({ [LIB_TAB_KEY]: id }); } catch (e) { /* ignore */ }
}

async function openLibraryTab(query) {
  const url = LIB_PAGE() + (query ? '?' + query : '');
  if (libraryTabId == null) {
    try {
      const got = await chrome.storage.session.get(LIB_TAB_KEY);
      if (got && got[LIB_TAB_KEY]) libraryTabId = got[LIB_TAB_KEY];
    } catch (e) { /* ignore */ }
  }
  if (libraryTabId != null) {
    try {
      await chrome.tabs.get(libraryTabId);
      /* an open library tab is only re-navigated when there is something to show there
         (the settings modal, a domain to pre-fill); otherwise just focus it */
      await chrome.tabs.update(libraryTabId, query ? { url, active: true } : { active: true });
      return libraryTabId;
    } catch (e) {
      libraryTabId = null;
    }
  }
  const tab = await chrome.tabs.create({ url, active: true });
  rememberLibraryTab(tab.id);
  return tab.id;
}

chrome.tabs.onRemoved.addListener((id) => {
  if (id !== libraryTabId) return;
  libraryTabId = null;
  try { chrome.storage.session.remove(LIB_TAB_KEY); } catch (e) { /* ignore */ }
});

/* Open a saved paper: load the publisher page, then let the content script convert it in
   place. The content script only answers once it is past its own whitelist/article gate, so
   an off-list URL simply stays a normal page instead of erroring. */
async function openLibraryItem(url, libraryId) {
  const tab = await chrome.tabs.create({ url, active: true });
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 600));
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'SR_CONVERT', libraryId });
      if (res && res.ok) return true;
      if (res && res.reason) return false;
    } catch (err) { /* page not parsed yet, or the site is not whitelisted */ }
  }
  return false;
}

/* ------------------------------------------------------------ messages */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'SR_OPEN' && msg.article) {
    const id = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    /* quote-safe payload; session storage avoids leaving article text on disk */
    const payload = {};
    payload[id] = msg.article;
    const url = chrome.runtime.getURL('reader.html') + '?id=' + id;
    const fromTab = sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;

    chrome.storage.session.set(payload)
      .then(async () => {
        /* Default: the reader takes over the article's own tab, so the reading
           flow never spawns a second tab. Ctrl/Cmd/Shift/middle-click asks for a
           new tab instead; a refused tabs.update falls back to one. */
        if (!msg.newTab && fromTab !== null) {
          try {
            await chrome.tabs.update(fromTab, { url });
            return 'replace';
          } catch (err) {
            /* no host access to that tab, or it was closed — use a new one */
          }
        }
        await chrome.tabs.create({ url, active: true });
        return 'tab';
      })
      .then((mode) => sendResponse({ ok: true, id, mode }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }

  if (msg.type === 'SR_GET' && msg.id) {
    chrome.storage.session.get(msg.id).then((got) => {
      sendResponse({ ok: true, article: got[msg.id] || null });
    }).catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg.type === 'SR_OPTIONS') {
    /* the pill's "allowed sites…" carries the host so the domain is pre-typed in the panel */
    const q = msg.host ? 'settings=1&add=' + encodeURIComponent(msg.host) : 'settings=1';
    openLibraryTab(q)
      .then((id) => sendResponse({ ok: true, tabId: id }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }

  if (msg.type === 'SR_LIBRARY') {
    openLibraryTab()
      .then((id) => sendResponse({ ok: true, tabId: id }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }

  /* the library page announces itself so the worker reuses it instead of opening a second one */
  if (msg.type === 'SR_LIBRARY_HELLO' && sender.tab && typeof sender.tab.id === 'number') {
    rememberLibraryTab(sender.tab.id);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'SR_OPEN_ITEM' && msg.url) {
    openLibraryItem(msg.url, msg.id)
      .then((converted) => sendResponse({ ok: true, converted }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
});

/* ------------------------------------------------------------ lifecycle */
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
  syncCustomSites();
});

chrome.runtime.onStartup.addListener(syncCustomSites);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SITES.STORAGE_KEY]) syncCustomSites();
});

/* ------------------------------------------------------------ toolbar button */
/* The toolbar button opens My library — the reading view is reached from the pill that the
   content script puts on a publisher page, which is the thing that has to see the article. */
chrome.action.onClicked.addListener(() => {
  openLibraryTab().catch((err) => {
    console.warn('[SchReader] could not open the library', err);
  });
});


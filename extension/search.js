/* SchReader — the Search tab.
   A shelf, not a search engine of our own: the box hands the query to Google Scholar, and the
   list below opens a publisher's own front page in the app's browser (real cookies, so an
   institutional login and paywalls behave exactly as they do in Chrome).

   Built-ins are fixed; "my sites" live in the shared store (library-store.js) so the same list
   shows up on the phone and in any other host that mounts this page.
*/
(() => {
  'use strict';

  const LIB = window.SR_LIB;
  const $ = (sel, root) => (root || document).querySelector(sel);
  /* the jump-to-card scroll below honours the OS "reduce motion" setting */
  const MOTION = (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    ? 'auto' : 'smooth';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const safeUrl = (u) => (/^https?:\/\/[^\s]+$/i.test(String(u || '').trim()) ? String(u).trim() : '');

  const SCHOLAR = 'https://scholar.google.com/';

  /* the default shelf. `key` is only for the letter tile, so no image request is needed and the
     page still looks right offline. */
  const DEFAULT_SITES = [
    {
      group: 'Frequently used',
      items: [
        { name: 'Google Scholar', url: 'https://scholar.google.com/', note: 'all publishers, one index' },
      ],
    },
    {
      group: 'Publishers',
      items: [
        { name: 'Nature', url: 'https://www.nature.com/', note: 'nature.com' },
        { name: 'Science', url: 'https://www.science.org/', note: 'science.org · AAAS' },
        { name: 'Cell', url: 'https://www.cell.com/', note: 'cell.com · Cell Press' },
      ],
    },
  ];

  const hostOf = (url) => { try { return new URL(url).host.replace(/^www\./, ''); } catch (e) { return ''; } };

  function openUrl(url) {
    const target = safeUrl(url);
    if (!target) return;
    /* openLink tells the app this page came from the search shelf, so the Search tab returns to
       it instead of the shelf; openArticle is the library's path (and the fallback) */
    if (typeof SchReader !== 'undefined' && SchReader) {
      try {
        if (typeof SchReader.openLink === 'function') { SchReader.openLink(target); return; }
        if (typeof SchReader.openArticle === 'function') { SchReader.openArticle(target); return; }
      } catch (e) { /* fall through */ }
    }
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: 'SR_OPEN_ITEM', url: target }, () => void chrome.runtime.lastError);
      return;
    }
    location.href = target;
  }

  function card(item, opts) {
    const url = safeUrl(item.url);
    const letter = (item.name || '?').trim().charAt(0).toUpperCase();
    const note = item.note || hostOf(url);
    return `
      <button class="site" type="button" data-url="${esc(url)}">
        <span class="tile">${esc(letter)}</span>
        <span class="txt">
          <b>${esc(item.name)}</b>
          <em>${esc(note)}</em>
        </span>
        ${opts && opts.remove ? `<span class="x" role="button" aria-label="Remove ${esc(item.name)}" data-remove="${esc(url)}">✕</span>` : ''}
      </button>`;
  }

  /* Every innerHTML below interpolates only static markup or values passed through esc()/safeUrl();
     site names come from the user's own store and are escaped, never handed raw to the DOM. */
  function renderMine(sites) {
    const box = $('#mine');
    box.innerHTML = sites.length
      ? sites.map((s) => card(s, { remove: true })).join('')
      : '<p class="hint">Nothing added yet. Any journal or database you use often can go here.</p>';
  }

  async function boot() {
    /* the shared theme has to be on <html> before the first paint of this page too */
    try { document.documentElement.dataset.theme = localStorage.getItem('sr-theme') || 'light'; } catch (e) {}
    if (typeof SchReader !== 'undefined' && SchReader) document.documentElement.classList.add('app');

    $('#shelf').innerHTML = DEFAULT_SITES.map((g) => `
      <section class="shelf-group">
        <h4>${esc(g.group)}</h4>
        <div class="shelf">${g.items.map((i) => card(i)).join('')}</div>
      </section>`).join('');

    let mine = [];
    if (LIB) {
      mine = await LIB.searchSites();
      renderMine(mine);
    }

    /* the search box: Scholar takes the query; a bare domain typed into it is opened directly */
    $('#find').addEventListener('submit', (e) => {
      e.preventDefault();
      const q = $('#q').value.trim();
      if (!q) return;
      if (/^https?:\/\//i.test(q)) return openUrl(q);
      if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(q)) return openUrl('https://' + q);
      openUrl(SCHOLAR + 'scholar?q=' + encodeURIComponent(q));
    });

    $('#shelf').addEventListener('click', (e) => {
      const b = e.target.closest('.site');
      if (b) openUrl(b.dataset.url);
    });

    /* tapping the ✕ on one of my sites removes it; the card itself must not fire */
    $('#mine').addEventListener('click', async (e) => {
      const x = e.target.closest('[data-remove]');
      if (x) {
        e.stopPropagation();
        mine = mine.filter((s) => s.url !== x.dataset.remove);
        if (LIB) await LIB.saveSearchSites(mine);
        renderMine(mine);
        return;
      }
      const b = e.target.closest('.site');
      if (b) openUrl(b.dataset.url);
    });

    $('#addForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('#addName').value.trim();
      let url = $('#addUrl').value.trim();
      if (!name) return say('Give the site a name first.', 'err');
      if (!url) return say('Add the address, e.g. https://www.nejm.org/', 'err');
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      if (!safeUrl(url)) return say('That does not look like a web address.', 'err');
      if (mine.some((s) => s.url === url)) return say('That site is already on the list.', 'err');

      mine = mine.concat({ name, url });
      if (LIB) await LIB.saveSearchSites(mine);
      renderMine(mine);
      $('#addName').value = '';
      $('#addUrl').value = '';
      say(`${name} added.`, 'ok');
      $('#addForm').classList.remove('open');
    });

    $('#btnAdd').addEventListener('click', () => {
      const f = $('#addForm');
      f.classList.toggle('open');
      if (f.classList.contains('open')) {
        f.scrollIntoView({ block: 'center', behavior: MOTION });
        $('#addName').focus({ preventScroll: true });
      }
    });
  }

  let timer = 0;
  function say(text, kind) {
    const el = $('#msg');
    el.textContent = text || '';
    el.className = 'msg' + (kind ? ' ' + kind : '');
    clearTimeout(timer);
    if (text) timer = setTimeout(() => { el.textContent = ''; el.className = 'msg'; }, 6000);
  }

  boot();
})();

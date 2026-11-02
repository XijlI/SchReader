/* ============================================================
   SchReader — reader page.
   Receives an article model (from the content script via the
   service worker) and renders the Nature-like reading view.
   ============================================================ */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const S = {
    article: null,
    figs: [], refs: [], byRef: new Map(), byFig: new Map(),
    tab: 'sections',
    scale: 1,
    theme: 'light',
    font: 'palatino',
    leading: 1.72,
    read: 41,
    lb: { index: 0, zoom: 1, tx: 0, ty: 0, dragging: false },
    popFor: null,
    hlColor: 'yellow',
    pendingRange: null,
  };

  /* ---------------------------------------------------------
     Sanitizer — publisher HTML goes through a strict whitelist.
     Nothing from the source page is trusted: tags are whitelisted,
     attributes are whitelisted, and class/style are dropped entirely
     (our own styling keys off data-ref / data-fig attributes).
     --------------------------------------------------------- */
  const ALLOW_TAGS = new Set([
    'A', 'ABBR', 'B', 'BR', 'CITE', 'CODE', 'DEL', 'EM', 'I', 'IMG', 'INS', 'MARK',
    'P', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'U', 'VAR', 'WBR',
    'UL', 'OL', 'LI', 'DL', 'DT', 'DD', 'BLOCKQUOTE', 'PRE', 'HR', 'DIV',
    'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION', 'COL', 'COLGROUP',
    'FIGURE', 'FIGCAPTION', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  ]);
  const KILL_TAGS = new Set([
    'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON',
    'SELECT', 'TEXTAREA', 'LINK', 'META', 'NOSCRIPT', 'VIDEO', 'AUDIO', 'CANVAS', 'SVG',
    'TEMPLATE', 'BASE', 'MAP', 'AREA',
  ]);
  const ALLOW_ATTR = new Set(['href', 'src', 'alt', 'title', 'width', 'height',
    'colspan', 'rowspan', 'data-ref', 'data-fig', 'data-ny', 'lang', 'dir', 'loading']);

  function sanitize(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html || '');
    const clean = (parent) => {
      let child = parent.firstChild;
      while (child) {
        const next = child.nextSibling;
        if (child.nodeType === 1) {
          if (KILL_TAGS.has(child.tagName)) {
            child.remove();
          } else if (!ALLOW_TAGS.has(child.tagName)) {
            clean(child);
            while (child.firstChild) parent.insertBefore(child.firstChild, child);
            child.remove();
          } else {
            for (const attr of Array.from(child.attributes)) {
              const n = attr.name.toLowerCase();
              if (!ALLOW_ATTR.has(n)) { child.removeAttribute(attr.name); continue; }
              if ((n === 'href' || n === 'src') && /^\s*(javascript|vbscript|data:text\/html)/i.test(attr.value)) {
                child.removeAttribute(attr.name);
              }
            }
            if (child.tagName === 'A' && child.getAttribute('href')) {
              child.setAttribute('target', '_blank');
              child.setAttribute('rel', 'noopener noreferrer');
            }
            clean(child);
          }
        }
        child = next;
      }
    };
    clean(tpl.content);
    return tpl.innerHTML;
  }

  /* ---------------------------------------------------------
     Load
     --------------------------------------------------------- */
  async function loadArticle() {
    if (window.__ARTICLE__) return window.__ARTICLE__;
    const id = new URLSearchParams(location.search).get('id');
    if (id && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
      const got = await chrome.storage.session.get(id);
      if (got && got[id]) return got[id];
    }
    /* dev harness only: never in production (extension pages are chrome-extension://) */
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return null;
    const params = new URLSearchParams(location.search);
    const dev = params.get('dev');
    if (dev) {
      try {
        const r = await fetch('../dev/' + dev, { cache: 'no-store' });
        if (r.ok) return r.json();
      } catch (e) { /* fall through */ }
    }
    /* dev fallback: extension/../dev/article.json served locally */
    try {
      const r = await fetch('../dev/article.json', { cache: 'no-store' });
      if (r.ok) return r.json();
    } catch (e) { /* ignore */ }
    return null;
  }

  /* ---------------------------------------------------------
     Build
     --------------------------------------------------------- */
  const labelOf = (f) => f.label || 'Figure';

  function figureBlock(f) {
    if (!f) return '';
    const cap = f.captionHtml ? sanitize(f.captionHtml) : '';
    return `
      <figure class="fig" id="${esc(f.id)}" data-figbox="${esc(f.id)}">
        <div class="fig-head">
          <span class="num">${esc(labelOf(f))}</span>
          <span class="spacer"></span>
          <button type="button" data-zoom="${esc(f.id)}">Expand</button>
        </div>
        <img src="${esc(f.src)}" alt="${esc(f.alt || labelOf(f))}" loading="lazy" referrerpolicy="no-referrer">
        <figcaption><span class="lab">${esc(labelOf(f))}</span>${cap ? " " + cap : ""}</figcaption>
      </figure>`;
  }

  function blockHtml(b) {
    switch (b.t) {
      case 'figure': return figureBlock(S.byFig.get(b.fid));
      case 'image': return `<figure class="fig"><img src="${esc(b.src)}" alt="${esc(b.alt || '')}" loading="lazy" referrerpolicy="no-referrer"></figure>`;
      case 'table': {
        /* extractors hand back the <table>'s innerHTML (thead/tbody/tr), and a browser parsing
           those outside a <table> drops the row structure — the whole table then renders as one
           run-on paragraph. Keep both shapes working: some sources pass a complete <table>. */
        const raw = String(b.html || '');
        return `<div class="table-wrap">${sanitize(/<table\b/i.test(raw) ? raw : `<table>${raw}</table>`)}</div>`;
      }
      case 'list': return sanitize(b.html);
      case 'quote': return `<blockquote>${sanitize(b.html)}</blockquote>`;
      case 'pre': return `<pre>${sanitize(b.html)}</pre>`;
      default: return `<p>${sanitize(b.html)}</p>`;
    }
  }

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  function fmtDate(raw) {
    const s = String(raw || '').trim();
    const m = s.match(/^([0-9]{4})[-/]([0-9]{1,2})[-/]([0-9]{1,2})/);
    if (!m) return s;
    const day = parseInt(m[3], 10), mon = parseInt(m[2], 10) - 1;
    if (!MONTHS[mon]) return s;
    return `${day} ${MONTHS[mon]} ${m[1]}`;
  }

  function renderHeader(a) {
    const m = a.meta || {};
    const s = a.source || {};
    const kicker = [m.journal, m.articleType].filter(Boolean);
    const dateBits = [];
    if (m.date) dateBits.push(esc(fmtDate(m.date)));
    if (m.volume) dateBits.push(`Vol. ${esc(m.volume)}`);
    if (m.pages) dateBits.push(`pp. ${esc(m.pages)}`);
    if (m.doi) dateBits.push(`<a href="https://doi.org/${esc(m.doi)}" target="_blank" rel="noopener noreferrer">doi:${esc(m.doi)}</a>`);
    if (m.pdfUrl) dateBits.push(`<a href="${esc(m.pdfUrl)}" target="_blank" rel="noopener noreferrer">PDF ↗</a>`);

    const authors = (m.authors || []).length
      ? `<p class="authors">${m.authors.map((x) => `<b>${esc(x)}</b>`).join(', ')}</p>`
      : '';

    const aff = (m.affiliations || []).length ? `
      <button class="affil-toggle" id="affilToggle" type="button">Affiliations (${m.affiliations.length})</button>
      <ul class="affil-list" id="affilList" hidden>${m.affiliations.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '';

    return `
      <div class="kicker">${kicker.map(esc).join('<span class="dot"></span>')}</div>
      <h1 class="title">${esc(m.title || 'Untitled')}</h1>
      ${m.subtitle ? `<p class="standfirst">${esc(m.subtitle)}</p>` : ''}
      ${authors}
      ${aff}
      <p class="dateline">${dateBits.join('<span class="sep">·</span>')}</p>
      ${a.abstractHtml ? `<section class="abstract" id="abstract"><h2>Abstract</h2>${sanitize(a.abstractHtml)}</section>` : ''}`;
  }

  function renderBody(a) {
    const secs = a.sections || [];
    if (!secs.length) {
      return `<p class="empty" style="font-family:var(--sans);font-size:.85rem">
        No article body could be read on this page — it may be abstract-only, or the full text
        sits inside a viewer this extension cannot see. Open the diagnostics (⋯) to check.</p>`;
    }
    return secs.map((sec, i) => {
      const id = sec.id || `sec-${i}`;
      const lvl = sec.level || 1;
      const head = sec.title ? `<h2>${esc(sec.title)}</h2>` : '';
      return `<section class="sec ${lvl > 1 ? 'sub' : ''}" id="${esc(id)}" data-sec="${i}">
        ${head}${sec.blocks.map(blockHtml).join('\n')}
      </section>`;
    }).join('\n');
  }

  function renderSupplementary(a) {
    const items = a.supplementary || [];
    if (!items.length) return '';
    return `<section class="sec" id="supplementary"><h2>Supplementary information</h2>
      <ul class="supp-list">${items.map((x) => `<li><a href="${esc(x.href)}" target="_blank" rel="noopener noreferrer">${esc(x.label)}</a></li>`).join('')}</ul>
    </section>`;
  }

  function renderReferenceList(a) {
    const refs = S.refs;
    if (!refs.length) {
      return `<section class="refs-sec" id="references"><h2>References</h2>
        <p class="empty" style="font-family:var(--sans);font-size:.85rem">No reference list found on this page.</p></section>`;
    }
    const items = refs.map((r) => {
      const doi = r.doi ? `<a class="doi" href="https://doi.org/${esc(r.doi)}" target="_blank" rel="noopener noreferrer">doi ↗</a>` : '';
      const back = r.citedAt && r.citedAt.length
        ? `<button class="backref" type="button" data-backref="${r.n}" title="Jump to where this is cited">↑ cited ${r.citedAt.length}×</button>` : '';
      return `<li id="ref-${r.n}" data-refitem="${r.n}"><span class="n">${r.n}</span>${sanitize(r.html)}${doi}${back}</li>`;
    }).join('');
    return `<section class="refs-sec" id="references"><h2>References</h2><ol class="reflist">${items}</ol></section>`;
  }

  /* ---------------------------------------------------------
     Rail
     --------------------------------------------------------- */
  const stripTags = (html) => {
    const t = document.createElement('template');
    t.innerHTML = String(html || '');
    return (t.content.textContent || '').replace(/\s+/g, ' ').trim();
  };

  function railSections() {
    const secs = (S.article.sections || []).slice();
    if (S.article.abstractHtml) secs.unshift({ id: 'abstract', title: 'Abstract', level: 1 });
    if ((S.article.supplementary || []).length) secs.push({ id: 'supplementary', title: 'Supplementary information', level: 1 });
    if (!secs.length) return `<p class="empty">No sections on this page.</p>`;
    const items = secs.map((s, i) => `
      <li class="lv${Math.min(s.level || 1, 3)}">
        <button type="button" data-gosec="${esc(s.id || 'sec-' + i)}">${esc(s.title || 'Main text')}</button>
      </li>`).join('');
    return `<ul class="sec-list" id="secList">${items}</ul>`;
  }

  function railFigures() {
    if (!S.figs.length) return `<p class="empty">No figures found on this page.</p>`;
    const items = S.figs.map((f) => {
      const cap = stripTags(f.captionHtml).slice(0, 160);
      return `<li>
        <div class="fig-item">
          <button type="button" data-gofig="${esc(f.id)}" title="View large">
            <span class="thumb"><img src="${esc(f.thumb || f.src)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>
            <span><span class="lab">${esc(labelOf(f))}</span><span class="cap">${esc(cap)}</span></span>
          </button>
          <button type="button" class="fig-jump" data-jumpfig="${esc(f.id)}" title="Show this figure in the text">↓</button>
        </div></li>`;
    }).join('');
    return `<ul class="fig-list">${items}</ul>`;
  }

  /* ---------- Google Scholar links ---------- */
  /* A DOI resolves exactly; otherwise the reference title is the next best query, and the
     title is normally the longest block in the entry that carries no year of its own. */
  function scholarQuery(r) {
    if (r.doi) return r.doi;
    const tpl = document.createElement('template');
    tpl.innerHTML = sanitize(r.html || '');
    const cand = $$('div, p, li, section', tpl.content)
      .map((x) => (x.textContent || '').replace(/\s+/g, ' ').trim())
      .filter((x) => x.length > 24 && x.length < 320 && !/\b(?:19|20)\d{2}\b/.test(x) && !/^(doi|https?:)/i.test(x));
    if (cand.length) return cand.sort((a, b) => b.length - a.length)[0];
    /* flat entry: "Abbot PA, Moran NA (2002) Title…" — keep what follows the year,
       or what precedes it when the year sits at the end ("… Proc. Biol. Sci., 276 (2009)") */
    let t = String(r.text || '').replace(/^\s*\[?\d{1,3}[.)\]]?\s*/, '');
    const y = t.match(/\b(?:19|20)\d{2}\b/);
    if (y) {
      t = y.index < t.length * 0.4 ? t.slice(y.index + 4) : t.slice(0, y.index);
      t = t.replace(/^[\s).,;:–—-]+/, '');
    }
    return t.slice(0, 180);
  }
  const scholarHref = (r) => 'https://scholar.google.com/scholar?q='
    + encodeURIComponent(scholarQuery(r) || String(r.text || '').slice(0, 160));

  function railRefs() {
    if (!S.refs.length) return `<p class="empty">No references found on this page.</p>`;
    const items = S.refs.map((r) => {
      const doi = r.doi ? `<a href="https://doi.org/${esc(r.doi)}" target="_blank" rel="noopener noreferrer">doi ↗</a>` : '';
      const sch = `<a class="sch" href="${esc(scholarHref(r))}" target="_blank" rel="noopener noreferrer" title="Find this reference on Google Scholar">Scholar ↗</a>`;
      const back = r.citedAt && r.citedAt.length
        ? `<button class="back" type="button" data-backref="${r.n}">↑ ${r.citedAt.length}×</button>` : '';
      return `<li data-railitem="${r.n}">
        <button class="ref-item" type="button" data-pin="${r.n}">
          <span class="txt"><span class="n">${r.n}</span>${esc(stripTags(r.html))}</span>
          <span class="meta">${doi}${sch}${back}</span>
        </button></li>`;
    }).join('');
    return `<ul class="ref-list">${items}</ul>`;
  }

  function renderRail() {
    const body = $('#railBody');
    const map = { sections: railSections, figures: railFigures, references: railRefs };
    body.innerHTML = (map[S.tab] || railSections)();
    body.scrollTop = 0;
    $$('.rail-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
    $('#figCount').textContent = S.figs.length ? ` ${S.figs.length}` : '';
    $('#refCount').textContent = S.refs.length ? ` ${S.refs.length}` : '';
    if (S.tab === 'sections') syncSpy();
  }

  function switchTab(tab) {
    if (!tab || tab === S.tab) return;
    S.tab = tab;
    renderRail();
  }

  /* highlight a figure in the rail without moving the article */
  function focusFigureInRail(id) {
    if (!id) return;
    if (window.innerWidth <= 1088) openRail();
    if (S.tab !== 'figures') switchTab('figures');
    const btn = document.querySelector(`[data-gofig="${CSS.escape(id)}"]`);
    const li = btn && btn.closest('li');
    if (!li) return;
    $$('.fig-list li.on').forEach((x) => x.classList.remove('on'));
    li.classList.add('on');
    const body = $('#railBody');
    const top = li.offsetTop - body.offsetTop;
    if (top < body.scrollTop || top > body.scrollTop + body.clientHeight - li.offsetHeight - 8) {
      body.scrollTo({ top: Math.max(0, top - 10), behavior: 'smooth' });
    }
    btn.classList.add('pulse');
    setTimeout(() => btn.classList.remove('pulse'), 1000);
  }

  /* ---------------------------------------------------------
     Citation pinning (the core interaction: you never lose your place)
     --------------------------------------------------------- */
  function pinRef(n, { showPop = null } = {}) {
    const ref = S.byRef.get(Number(n));
    if (!ref) return;
    if (S.tab !== 'references') switchTab('references');
    const li = $(`[data-railitem="${n}"]`);
    if (li) {
      $$('.ref-list li.on').forEach((x) => x.classList.remove('on'));
      li.classList.add('on');
      const body = $('#railBody');
      const top = li.offsetTop - body.offsetTop;
      if (top < body.scrollTop || top > body.scrollTop + body.clientHeight - li.offsetHeight - 8) {
        body.scrollTo({ top: Math.max(0, top - 12), behavior: 'smooth' });
      }
    }
    const artLi = $(`#ref-${n}`);
    if (artLi) {
      artLi.classList.add('flash');
      setTimeout(() => artLi.classList.remove('flash'), 1400);
    }
    if (showPop) showPopover(showPop, ref);
  }

  function jumpToCitation(n) {
    const chips = $$(`a[data-ref="${n}"]`);
    if (!chips.length) { toast('No in-text citation found'); return; }
    const chip = chips[0];
    chip.scrollIntoView({ block: 'center', behavior: 'smooth' });
    chips.forEach((c) => {
      c.classList.add('flash');
      setTimeout(() => c.classList.remove('flash'), 1600);
    });
  }

  /* ---------------------------------------------------------
     Popover
     --------------------------------------------------------- */
  function positionPopover(anchor) {
    const pop = $('#pop');
    if (!anchor || !pop || pop.hidden) return;
    const r = anchor.getBoundingClientRect();
    /* hide only when the anchor has actually left the viewport (the topbar sits at top) */
    if (r.bottom < 2 || r.top > window.innerHeight - 2) { hidePopover(); return; }
    const pw = pop.offsetWidth || 360;
    const ph = pop.offsetHeight || 160;
    /* keep the card inside the article column so it never covers the sidebar */
    const paperEl = document.querySelector('.paper');
    const paperRight = paperEl ? Math.min(window.innerWidth - 10, paperEl.getBoundingClientRect().right) : window.innerWidth - 10;
    const maxLeft = Math.max(8, Math.min(window.innerWidth - pw - 10, paperRight - pw));
    const left = Math.max(8, Math.min(r.left - 10, maxLeft));
    let top = r.bottom + 8;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 8);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  function showPopover(anchor, ref) {
    const pop = $('#pop');
    const cited = ref.citedAt && ref.citedAt.length ? `${ref.citedAt.length} in-text citation${ref.citedAt.length > 1 ? 's' : ''}` : 'not cited in text';
    pop.innerHTML = `
      <div class="pop-head">Reference ${ref.n}<span class="cited">${esc(cited)}</span></div>
      <div class="pop-txt">${sanitize(ref.html)}</div>
      <div class="pop-actions">
        ${ref.doi ? `<a href="https://doi.org/${esc(ref.doi)}" target="_blank" rel="noopener noreferrer">Open DOI ↗</a>` : (ref.url ? `<a href="${esc(ref.url)}" target="_blank" rel="noopener noreferrer">Open source ↗</a>` : '')}
        <button type="button" data-pin-btn="${ref.n}">Keep in sidebar</button>
        ${ref.citedAt && ref.citedAt.length ? `<button type="button" data-backref="${ref.n}">Jump to text ↑</button>` : ''}
      </div>`;
    pop.hidden = false;
    pop.classList.add('show');
    S.popFor = anchor;
    positionPopover(anchor);
  }

  function hidePopover() {
    const pop = $('#pop');
    pop.classList.remove('show');
    pop.hidden = true;
    S.popFor = null;
  }

  /* ---------------------------------------------------------
     Lightbox
     --------------------------------------------------------- */
  function lbApply() {
    const { zoom, tx, ty } = S.lb;
    const img = $('#lbImg');
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${zoom})`;
    img.style.cursor = zoom > 1 ? 'grab' : 'default';
    $('#lbStage').style.cursor = zoom > 1 ? 'grab' : 'default';
    $('#lbReset').textContent = `${Math.round(zoom * 100)}%`;
    /* at or below 100% the whole plate fits, so the zoom-out button has nowhere to go */
    $('#lbZoomOut').disabled = zoom <= LB_MIN_ZOOM;
  }

  function lbOpen(figId) {
    const idx = S.figs.findIndex((f) => f.id === figId);
    if (idx < 0) return;
    S.lb.index = idx;
    S.lb.zoom = 1; S.lb.tx = 0; S.lb.ty = 0;
    const f = S.figs[idx];
    $('#lbImg').src = f.src;
    $('#lbImg').alt = f.alt || labelOf(f);
    $('#lbCap').textContent = `${labelOf(f)} — ${stripTags(f.captionHtml).slice(0, 220)}`;
    $('#lbOpen').href = f.src;
    $('#lb').hidden = false;
    lbApply();
    document.body.style.overflow = 'hidden';
  }

  function lbClose() {
    $('#lb').hidden = true;
    document.body.style.overflow = '';
  }

  function lbStep(d) {
    if (!S.figs.length) return;
    S.lb.index = (S.lb.index + d + S.figs.length) % S.figs.length;
    lbOpen(S.figs[S.lb.index].id);
  }

  /* zoom range spans below 100%: a 3000 px plate needs to be pulled back to be read whole */
  const LB_MIN_ZOOM = 0.25;
  const LB_MAX_ZOOM = 6;

  function lbZoom(factor) {
    S.lb.zoom = Math.min(LB_MAX_ZOOM, Math.max(LB_MIN_ZOOM, S.lb.zoom * factor));
    /* nothing to pan while the image is smaller than the stage */
    if (S.lb.zoom <= 1) { S.lb.tx = 0; S.lb.ty = 0; }
    lbApply();
  }

  /* ---------------------------------------------------------
     Toast + misc
     --------------------------------------------------------- */
  let toastTimer = 0;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1900);
  }

  function flashAndScroll(el) {
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1500);
  }

  /* citation counts per reference, derived from the rendered DOM */
  function computeCitations() {
    const perRef = new Map();
    for (const sec of $$('.sec')) {
      for (const chip of $$('a[data-ref]', sec)) {
        const n = Number(chip.dataset.ref);
        if (!perRef.has(n)) perRef.set(n, []);
        const list = perRef.get(n);
        if (!list.includes(sec.id)) list.push(sec.id);
      }
    }
    for (const r of S.refs) r.citedAt = perRef.get(r.n) || [];
  }

  /* scroll spy */
  let spyObserver = null;
  function setupSpy() {
    if (spyObserver) spyObserver.disconnect();
    const secs = $$('.sec, .abstract, .refs-sec');
    if (!secs.length || !('IntersectionObserver' in window)) return;
    const visible = new Map();
    spyObserver = new IntersectionObserver((entries) => {
      for (const e of entries) visible.set(e.target, e.isIntersecting ? e.intersectionRatio : 0);
      let best = null, bestRatio = 0;
      for (const [el, ratio] of visible) if (ratio > bestRatio) { best = el; bestRatio = ratio; }
      if (!best) {
        /* nothing in the strip yet (page top shows title/authors) — mark the first item */
        if (window.scrollY < 160) {
          const first = $('.sec-list button');
          if (first && !first.classList.contains('on')) {
            $$('.sec-list button.on').forEach((b) => b.classList.remove('on'));
            first.classList.add('on');
          }
        }
        return;
      }
      const id = best.id;
      const btn = $(`.sec-list button[data-gosec="${CSS.escape(id)}"]`);
      if (!btn) return;
      $$('.sec-list button.on').forEach((b) => b.classList.remove('on'));
      btn.classList.add('on');
      const body = $('#railBody');
      const top = btn.offsetTop - body.offsetTop;
      if (top < body.scrollTop + 4 || top > body.scrollTop + body.clientHeight - 40) {
        body.scrollTo({ top: Math.max(0, top - body.clientHeight / 2), behavior: 'smooth' });
      }
    }, { rootMargin: '-72px 0px -62% 0px', threshold: [0, 0.1, 0.5, 1] });
    secs.forEach((s) => spyObserver.observe(s));
  }

  function syncSpy() {
    /* re-observe after a tab switch */
    setupSpy();
  }

  /* progress bar */
  function onScroll() {
    const h = document.documentElement.scrollHeight - window.innerHeight;
    const p = h > 0 ? Math.min(1, Math.max(0, window.scrollY / h)) : 0;
    $('#progress > i').style.width = `${p * 100}%`;
    if (S.popFor) positionPopover(S.popFor);   // follow the text instead of vanishing
    noteProgress(p);                            // remember where a saved article was left
  }

  /* ---------------------------------------------------------
     Theme / scale
     --------------------------------------------------------- */
  const THEMES = ['light', 'paper', 'sepia', 'solarized-light', 'gruvbox-light', 'rose-dawn',
    'catppuccin-latte', 'dark', 'dusk', 'solarized-dark', 'gruvbox-dark', 'nord', 'rose-pine',
    'catppuccin-mocha', 'midnight', 'black', 'moss', 'custom'];
  const THEME_LABEL = {
    light: 'Light', paper: 'Paper', sepia: 'Sepia',
    'solarized-light': 'Solarized', 'gruvbox-light': 'Gruvbox', 'rose-dawn': 'Rosé Pine Dawn',
    'catppuccin-latte': 'Catppuccin Latte', dark: 'Graphite', dusk: 'Dusk (low contrast)',
    'solarized-dark': 'Solarized Dark', 'gruvbox-dark': 'Gruvbox Dark', nord: 'Nord',
    'rose-pine': 'Rosé Pine', 'catppuccin-mocha': 'Catppuccin Mocha',
    midnight: 'Midnight', black: 'OLED black', moss: 'Moss', custom: 'Custom colours',
  };
  const THEME_SWATCH = {
    light: '#ffffff', paper: '#fbfaf7', sepia: '#f8f4ea',
    'solarized-light': '#fdf6e3', 'gruvbox-light': '#fbf1c7', 'rose-dawn': '#faf4ed',
    'catppuccin-latte': '#eff1f5', dark: '#0e1116', dusk: '#1a1b1d',
    'solarized-dark': '#002b36', 'gruvbox-dark': '#282828', nord: '#2e3440',
    'rose-pine': '#191724', 'catppuccin-mocha': '#1e1e2e',
    midnight: '#0b1220', black: '#000000', moss: '#0f1512',
  };

  /* ---------- custom palette ---------- */
  const CUSTOM_KEY = 'sr-custom';
  const CUSTOM_PROPS = ['--bg', '--bg-soft', '--bg-sunk', '--fg', '--fg-soft', '--fg-faint',
    '--line', '--line-strong', '--link', '--accent', '--accent-soft', '--chip-bg', '--chip-fg',
    '--mark', '--shadow', '--danger'];
  const RESOLVED_KEY = 'sr-custom-resolved';
  const rgbOf = (color) => {
    const rgb = String(color || '').trim().match(/^rgba?\(([^)]+)\)$/i);
    if (rgb) {
      const p = rgb[1].split(',').map((x) => parseFloat(x));
      return [p[0] || 0, p[1] || 0, p[2] || 0];
    }
    const m = String(color || '').replace('#', '').match(/^([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!m) return [255, 255, 255];
    const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  };
  const hexOf = (rgb) => '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v)))
    .toString(16).padStart(2, '0')).join('');
  const mixColor = (a, b, t) => {
    const A = rgbOf(a), B = rgbOf(b);
    return hexOf(A.map((v, i) => v + (B[i] - v) * t));
  };
  const luminance = (hex) => {
    const [r, g, b] = rgbOf(hex).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrastRatio = (a, b) => {
    const l1 = luminance(a), l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const isDarkColor = (hex) => luminance(hex) < 0.35;
  const defaultAccent = (bg) => (isDarkColor(bg) ? '#7db4ff' : '#0b5ab3');

  function customCfg() {
    try {
      const raw = JSON.parse(localStorage.getItem(CUSTOM_KEY) || 'null');
      if (raw && raw.bg && raw.fg) return raw;
    } catch (e) { /* ignore */ }
    return { bg: '#f6f1e7', fg: '#20242b', accent: '' };
  }
  /* every other shade is derived, so two colours are enough to build a coherent skin */
  function applyCustom(cfg) {
    const bg = cfg.bg || '#ffffff';
    const fg = cfg.fg || '#17191c';
    const dark = isDarkColor(bg);
    const accent = cfg.accent || defaultAccent(bg);
    const st = document.documentElement.style;
    st.setProperty('--bg', bg);
    st.setProperty('--bg-soft', mixColor(bg, fg, 0.05));
    st.setProperty('--bg-sunk', mixColor(bg, fg, 0.09));
    st.setProperty('--fg', fg);
    st.setProperty('--fg-soft', mixColor(fg, bg, 0.28));
    st.setProperty('--fg-faint', mixColor(fg, bg, 0.48));
    st.setProperty('--line', mixColor(bg, fg, 0.13));
    st.setProperty('--line-strong', mixColor(bg, fg, 0.22));
    st.setProperty('--link', accent);
    st.setProperty('--accent', accent);
    st.setProperty('--accent-soft', mixColor(bg, accent, dark ? 0.16 : 0.10));
    st.setProperty('--chip-bg', mixColor(bg, accent, dark ? 0.18 : 0.10));
    st.setProperty('--chip-fg', dark ? mixColor(accent, '#ffffff', 0.30) : mixColor(accent, '#000000', 0.12));
    st.setProperty('--mark', mixColor(bg, accent, dark ? 0.30 : 0.18));
    st.setProperty('--danger', dark ? '#f27d72' : '#b42318');
    st.setProperty('--shadow', dark
      ? '0 12px 34px rgba(0, 0, 0, .55)'
      : '0 10px 30px rgba(16, 24, 40, .13), 0 2px 6px rgba(16, 24, 40, .06)');
    /* The library / search / settings pages cannot mix these colours themselves, and a bare
       data-theme="custom" matches no palette block — cache the resolved tokens for them. */
    try {
      const props = {};
      for (const p of CUSTOM_PROPS) props[p] = st.getPropertyValue(p).trim();
      localStorage.setItem(RESOLVED_KEY, JSON.stringify({ props }));
    } catch (e) { /* ignore */ }
    reportTheme();
  }

  /* tell the shell (Android) which skin the chrome should wear */
  function reportTheme() {
    try { if (window.NVTheme) NVTheme.report(); } catch (e) { /* ignore */ }
  }
  function clearCustom() {
    for (const prop of CUSTOM_PROPS) document.documentElement.style.removeProperty(prop);
  }
  function setCustom(patch) {
    const cfg = Object.assign(customCfg(), patch);
    try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
    S.theme = 'custom';
    document.documentElement.setAttribute('data-theme', 'custom');
    try { localStorage.setItem('sr-theme', 'custom'); } catch (e) { /* ignore */ }
    applyCustom(cfg);
    syncHlMode();
    syncTypePanel();
  }
  const FONTS = [
    { id: 'arial', label: 'Arial', stack: 'Arial, Helvetica, sans-serif' },
    { id: 'inter', label: 'Inter', stack: '"Inter", "Segoe UI", system-ui, sans-serif' },
    { id: 'plex', label: 'IBM Plex Sans', stack: '"IBM Plex Sans", "Segoe UI", system-ui, sans-serif' },
    { id: 'palatino', label: 'Palatino', stack: '"Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif' },
    { id: 'times', label: 'Times New Roman', stack: '"Times New Roman", Times, serif' },
    { id: 'georgia', label: 'Georgia', stack: 'Georgia, "Times New Roman", serif' },
    { id: 'cambria', label: 'Cambria', stack: 'Cambria, Georgia, serif' },
  ];

  function applyScale(v) {
    S.scale = Math.min(1.32, Math.max(0.88, v));
    document.documentElement.style.setProperty('--scale', String(S.scale));
    try { localStorage.setItem('sr-scale', String(S.scale)); } catch (e) {}
    syncTypePanel();
  }
  function applyTheme(t) {
    S.theme = THEMES.includes(t) ? t : 'light';
    if (S.theme === 'custom') applyCustom(customCfg());
    else clearCustom();
    document.documentElement.setAttribute('data-theme', S.theme);
    syncHlMode();   /* multiply on light paper, screen on dark */
    try { localStorage.setItem('sr-theme', S.theme); } catch (e) {}
    syncTypePanel();
    reportTheme();
  }
  function applyFont(id) {
    S.font = FONTS.some((f) => f.id === id) ? id : 'palatino';
    document.documentElement.setAttribute('data-font', S.font);
    try { localStorage.setItem('sr-font', S.font); } catch (e) {}
    syncTypePanel();
  }
  function applyLeading(v) {
    S.leading = Math.min(2.15, Math.max(1.4, v));
    document.documentElement.style.setProperty('--leading', String(S.leading));
    try { localStorage.setItem('sr-leading', String(S.leading)); } catch (e) {}
    syncTypePanel();
  }
  /* reading measure — the one setting that decides how many words sit on a line */
  function applyRead(rem) {
    S.read = Math.min(60, Math.max(30, Number(rem) || 41));
    document.documentElement.style.setProperty('--read', `${S.read}rem`);
    try { localStorage.setItem('sr-read', String(S.read)); } catch (e) {}
    syncTypePanel();
  }
  /* characters per line. Exact when possible: lay a Range over one long text node and count
     its line boxes — that is the real measure, chips and all. Falls back to a font probe. */
  function measureChars() {
    const ps = $$('.paper .sec p').filter((p) => (p.textContent || '').length > 300).slice(0, 8);
    let chars = 0, lines = 0;
    for (const p of ps) {
      const node = Array.from(p.childNodes)
        .find((n) => n.nodeType === 3 && (n.nodeValue || '').trim().length > 200);
      if (!node) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const boxes = Array.from(range.getClientRects()).filter((r) => r.height > 1).length;
      /* short paragraphs are mostly last-line and would drag the average down */
      if (boxes < 5) continue;
      chars += node.nodeValue.trim().length;
      lines += boxes;
    }
    if (lines) return Math.round(chars / lines);
    return probeChars();
  }
  /* font-based estimate, used only when no long paragraph is available */
  function probeChars() {
    const ps = $$('.paper .sec p').filter((x) => (x.textContent || '').length > 200);
    const p = ps[0] || $('.paper p');
    const paper = $('.paper');
    if (!p || !paper) return 0;
    const cs = getComputedStyle(p);
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre';
    probe.style.fontFamily = cs.fontFamily;
    probe.style.fontSize = cs.fontSize;
    probe.style.fontWeight = cs.fontWeight;
    probe.style.letterSpacing = cs.letterSpacing;
    probe.textContent = 'The quick brown fox jumps over the lazy dog, and then rests. '
      + 'Reading measures settle near seventy characters per line. ';
    const n = probe.textContent.length;
    document.body.appendChild(probe);
    const avg = probe.getBoundingClientRect().width / n;
    probe.remove();
    return avg > 0 ? Math.round(paper.getBoundingClientRect().width / avg) : 0;
  }
  /* is the window too narrow to deliver the requested measure? */
  function readIsClamped() {
    const paper = $('.paper');
    if (!paper) return false;
    const want = (S.read || 41) * parseFloat(getComputedStyle(document.documentElement).fontSize);
    return paper.getBoundingClientRect().width < want - 6;
  }
  function syncTypePanel() {
    const tr = $('#themeRow');
    if (!tr) return;
    $$('#themeRow button').forEach((b) => b.classList.toggle('on', b.dataset.theme === S.theme));
    $$('#fontRow button').forEach((b) => b.classList.toggle('on', b.dataset.font === S.font));
    const size = Math.round(S.scale * 100);
    $('#sizeRange').value = String(Math.min(128, Math.max(88, size)));
    $('#sizeOut').textContent = `${size}%`;
    const to = $('#themeOut');
    if (to) to.textContent = S.theme === 'custom' ? 'Custom' : (THEME_LABEL[S.theme] || S.theme);
    const lead = Math.round((S.leading || 1.72) * 100);
    $('#leadRange').value = String(Math.min(215, Math.max(140, lead)));
    $('#leadOut').textContent = (S.leading || 1.72).toFixed(2);
    const read = Math.round(S.read || 41);
    $('#readRange').value = String(Math.min(60, Math.max(30, read)));
    if (!$('#typeset').hasAttribute('hidden')) {
      const chars = measureChars();
      const tail = readIsClamped() ? ' · window-limited' : '';
      $('#readOut').textContent = chars ? `${read}rem · ≈${chars} chars${tail}` : `${read}rem`;
    } else {
      $('#readOut').textContent = `${read}rem`;
    }
    /* custom palette + its contrast readout */
    const cfg = customCfg();
    $('#colBg').value = cfg.bg;
    $('#colFg').value = cfg.fg;
    $('#colAccent').value = cfg.accent || defaultAccent(cfg.bg);
    const cr = contrastRatio(cfg.bg, cfg.fg);
    $('#contrastOut').textContent = `${cr.toFixed(1)}:1${cr < 4.5 ? ' low' : ''}`;
    $('#contrastOut').classList.toggle('low', cr < 4.5);
  }
  function buildTypePanel() {
    /* markup is built from the static constants above, no article data involved.
       the custom swatch value comes from localStorage, so validate it as a hex colour first */
    const cf = customCfg();
    const safeBg = /^#[0-9a-f]{6}$/i.test(String(cf.bg)) ? cf.bg : '#ffffff';
    $('#themeRow').innerHTML = THEMES.map((t) => {
      const swatch = t === 'custom' ? safeBg : (THEME_SWATCH[t] || '#fff');
      const ring = t === 'custom' ? 'box-shadow:inset 0 0 0 1px var(--accent);' : '';
      return `<button type="button" data-theme="${t}" title="${esc(THEME_LABEL[t] || t)}"
              style="background:${swatch};${ring}"></button>`;
    }).join('');
    $('#fontRow').innerHTML = FONTS.map((f) => `
      <button type="button" data-font="${f.id}" style="font-family:${f.stack.replace(/"/g, '&quot;')}">${esc(f.label)}</button>`).join('');
    syncTypePanel();
  }
  function toggleTypePanel(force) {
    const p = $('#typeset');
    const next = force === undefined ? p.hasAttribute('hidden') : force;
    if (next) {
      p.removeAttribute('hidden');
      syncTypePanel();
      placeTypePanel(p);
    } else {
      p.setAttribute('hidden', '');
    }
    $('#btnType').setAttribute('aria-pressed', String(next));
  }

  /* under the Aa button, right edges aligned — a fixed 10.5rem guess landed under the wrong
     button as soon as the toolbar changed */
  function placeTypePanel(p) {
    if (window.innerWidth <= 720) return;   /* narrow screens use the full-width sheet */
    const b = $('#btnType').getBoundingClientRect();
    const w = p.offsetWidth || 336;
    const left = Math.min(Math.max(8, b.right - w), window.innerWidth - w - 8);
    p.style.left = `${left}px`;
    p.style.right = 'auto';
    p.style.top = `${Math.round(b.bottom + 6)}px`;
  }

  /* ---------------------------------------------------------
     Events
     --------------------------------------------------------- */
  function wire() {
    /* rail tabs */
    $$('.rail-tabs button').forEach((b) => b.addEventListener('click', () => {
      S.tab = b.dataset.tab;
      if (S.tab === 'figures' && !S.figs.length) toast('No figures detected');
      if (S.tab === 'references' && !S.refs.length) toast('No references detected');
      renderRail();
    }));

    /* delegated clicks inside the page */
    document.addEventListener('click', (e) => {
      const chip = e.target.closest('a[data-ref]');
      if (chip) {
        e.preventDefault();
        pinRef(chip.dataset.ref, { showPop: chip });
        return;
      }
      const figLink = e.target.closest('a[data-fig]');
      if (figLink) {
        /* in-text "Fig. 3" -> highlight it in the rail, leave the reading position alone */
        e.preventDefault();
        focusFigureInRail(figLink.dataset.fig);
        return;
      }
      const railFig = e.target.closest('[data-gofig]');
      if (railFig) { e.preventDefault(); lbOpen(railFig.dataset.gofig); return; }
      const jumpFig = e.target.closest('[data-jumpfig]');
      if (jumpFig) {
        e.preventDefault();
        const id = jumpFig.dataset.jumpfig;
        const box = document.querySelector(`[data-figbox="${CSS.escape(id)}"]`);
        if (window.innerWidth <= 1088) closeRail();
        flashAndScroll(box);
        return;
      }
      const zoom = e.target.closest('[data-zoom]');
      if (zoom) { e.preventDefault(); lbOpen(zoom.dataset.zoom); return; }

      const secBtn = e.target.closest('[data-gosec]');
      if (secBtn) {
        const el = document.getElementById(secBtn.dataset.gosec);
        if (el) {
          el.scrollIntoView({ block: 'start', behavior: 'smooth' });
          if (window.innerWidth <= 1088) closeRail();
        }
        return;
      }
      const pin = e.target.closest('[data-pin]');
      if (pin) { pinRef(pin.dataset.pin); return; }
      const pinBtn = e.target.closest('[data-pin-btn]');
      if (pinBtn) { pinRef(pinBtn.dataset.pinBtn); hidePopover(); return; }
      const back = e.target.closest('[data-backref]');
      if (back) { e.preventDefault(); jumpToCitation(back.dataset.backref); hidePopover(); return; }
      const aff = e.target.closest('#affilToggle');
      if (aff) {
        const list = $('#affilList');
        if (list) list.hidden = !list.hidden;
        return;
      }
      if (e.target.closest('.topbar')) return;   // toolbar buttons manage their own popovers
      if (!e.target.closest('#pop')) hidePopover();
    });

    /* hover preview on inline citations */
    let hoverTimer = 0;
    document.addEventListener('pointerover', (e) => {
      const chip = e.target.closest('a[data-ref]');
      if (!chip) return;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        const ref = S.byRef.get(Number(chip.dataset.ref));
        if (ref) showPopover(chip, ref);
      }, 130);
    });
    document.addEventListener('pointerout', (e) => {
      const chip = e.target.closest('a[data-ref]');
      if (!chip) return;
      clearTimeout(hoverTimer);
      const pop = $('#pop');
      setTimeout(() => {
        if (!pop.matches(':hover') && !document.querySelector('#pop.show')) hidePopover();
        else if (!pop.matches(':hover')) hidePopover();
      }, 180);
    });
    $('#pop').addEventListener('pointerleave', () => setTimeout(() => {
      if (!$('#pop').matches(':hover')) hidePopover();
    }, 160));

    /* figure image click -> lightbox */
    document.addEventListener('click', (e) => {
      const img = e.target.closest('figure.fig > img');
      if (!img) return;
      const box = img.closest('[data-figbox]');
      if (box) { lbOpen(box.dataset.figbox); return; }
      const src = img.getAttribute('src');
      const f = S.figs.find((x) => x.src === src);
      if (f) lbOpen(f.id); else { $('#lbImg').src = src; $('#lbCap').textContent = ''; $('#lb').hidden = false; }
    });

    /* top bar */
    $('#btnRail').addEventListener('click', toggleRail);
    $('#btnDiag').addEventListener('click', showDiagnostics);
    addNativeTabsButton();

    /* type & theme panel — markup built from the constants above, no article data involved */
    buildTypePanel();
    $('#btnType').addEventListener('click', (e) => { e.stopPropagation(); toggleTypePanel(); });
    $('#typeset').addEventListener('click', (e) => {
      e.stopPropagation();
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.theme) applyTheme(t.dataset.theme);
      if (t.dataset.font) applyFont(t.dataset.font);
    });
    $('#sizeRange').addEventListener('input', (e) => applyScale(Number(e.target.value) / 100));
    $('#sizeDown').addEventListener('click', () => applyScale(Math.round((S.scale - 0.04) * 100) / 100));
    $('#sizeUp').addEventListener('click', () => applyScale(Math.round((S.scale + 0.04) * 100) / 100));
    $('#leadRange').addEventListener('input', (e) => applyLeading(Number(e.target.value) / 100));
    $('#readRange').addEventListener('input', (e) => applyRead(Number(e.target.value)));
    /* picking any custom colour switches to the custom skin */
    $('#colBg').addEventListener('input', (e) => setCustom({ bg: e.target.value }));
    $('#colFg').addEventListener('input', (e) => setCustom({ fg: e.target.value }));
    $('#colAccent').addEventListener('input', (e) => setCustom({ accent: e.target.value }));
    document.addEventListener('click', (e) => {
      if ($('#typeset').hasAttribute('hidden')) return;
      if (e.target.closest('#typeset') || e.target.closest('#btnType')) return;
      toggleTypePanel(false);
    });

    /* lightbox */
    $('#lbClose').addEventListener('click', lbClose);
    $('#lbPrev').addEventListener('click', () => lbStep(-1));
    $('#lbNext').addEventListener('click', () => lbStep(1));
    $('#lbZoomIn').addEventListener('click', () => lbZoom(1.25));
    $('#lbZoomOut').addEventListener('click', () => lbZoom(0.8));
    $('#lbReset').addEventListener('click', () => { S.lb.zoom = 1; S.lb.tx = 0; S.lb.ty = 0; lbApply(); });
    $('#lb').addEventListener('click', (e) => { if (e.target.id === 'lb') lbClose(); });

    const stage = $('#lbStage');
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      lbZoom(e.deltaY < 0 ? 1.12 : 0.89);
    }, { passive: false });
    stage.addEventListener('pointerdown', (e) => {
      if (S.lb.zoom <= 1) return;
      S.lb.dragging = true;
      S.lb.startX = e.clientX - S.lb.tx;
      S.lb.startY = e.clientY - S.lb.ty;
      stage.classList.add('dragging');
      stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener('pointermove', (e) => {
      if (!S.lb.dragging) return;
      S.lb.tx = e.clientX - S.lb.startX;
      S.lb.ty = e.clientY - S.lb.startY;
      lbApply();
    });
    stage.addEventListener('pointerup', (e) => {
      S.lb.dragging = false;
      stage.classList.remove('dragging');
      try { stage.releasePointerCapture(e.pointerId); } catch (err) {}
    });

    /* keyboard */
    document.addEventListener('keydown', (e) => {
      const tgt = e.target;
      if (tgt && typeof tgt.matches === 'function' && tgt.matches('input, textarea, select')) return;
      const lbOpenNow = !$('#lb').hidden;
      if (e.key === 'Escape') {
        if (lbOpenNow) return lbClose();
        hideHlPalette();
        hideHlPen();
        hidePopover();
        closeRail();
        return;
      }
      if (lbOpenNow) {
        if (e.key === 'ArrowRight') return lbStep(1);
        if (e.key === 'ArrowLeft') return lbStep(-1);
        if (e.key === '0') { S.lb.zoom = 1; S.lb.tx = 0; S.lb.ty = 0; lbApply(); return; }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'j' || k === 'k') {
        const secs = $$('.sec');
        if (!secs.length) return;
        const y = window.scrollY + 80;
        let i = secs.findIndex((s) => s.offsetTop > y);
        i = i < 0 ? secs.length - 1 : i;
        const target = secs[Math.max(0, Math.min(secs.length - 1, k === 'j' ? i : i - 2))];
        target.scrollIntoView({ block: 'start', behavior: 'smooth' });
      } else if (k === 's') switchTab('sections');
      else if (k === 'f') switchTab('figures');
      else if (k === 'r') switchTab('references');
      else if (k === 't') applyTheme(THEMES[(THEMES.indexOf(S.theme) + 1) % THEMES.length]);
      else if (k === 'z') toggleRail();
    });

    let rt = 0;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => { if (window.innerWidth > 1088) { $('#rail').classList.remove('open'); ensureScrim().classList.remove('on'); } }, 150);
    });
  }

  function ensureScrim() {
    let s = $('.rail-scrim');
    if (!s) {
      s = document.createElement('div');
      s.className = 'rail-scrim';
      s.addEventListener('click', closeRail);
      document.body.appendChild(s);
    }
    return s;
  }
  function closeRail() {
    $('#rail').classList.remove('open');
    const s = $('.rail-scrim');
    if (s) s.classList.remove('on');
  }
  function openRail() {
    $('#rail').classList.add('open');
    ensureScrim().classList.add('on');
  }
  /* one entry point for the ☰ button and the "z" shortcut */
  function toggleRail() {
    const rail = $('#rail');
    if (!rail) return;
    if (window.innerWidth > 1088) {
      /* wide window: collapse the column for real, the article re-centres */
      const off = document.documentElement.dataset.rail !== 'off';
      document.documentElement.dataset.rail = off ? 'off' : 'on';
      try { localStorage.setItem('sr-rail', off ? 'off' : 'on'); } catch (e) { /* ignore */ }
      schedulePaint();
      return;
    }
    rail.classList.toggle('open');
    ensureScrim().classList.toggle('on', rail.classList.contains('open'));
  }

  /* diagnostics: what the extractor managed to read */
  /* In the app the article covers the native top bar, so the tab list is reachable from here —
     the browser extension has no shell and no tabs, and skips this. */
  function addNativeTabsButton() {
    if (typeof SchReader === 'undefined' || !SchReader || typeof SchReader.showTabs !== 'function') return;
    if ($('#btnAppTabs')) return;
    const b = document.createElement('button');
    b.id = 'btnAppTabs';
    b.title = 'Tabs';
    b.textContent = '❐';
    b.addEventListener('click', () => { try { SchReader.showTabs(); } catch (e) { /* ignore */ } });
    const diag = $('#btnDiag');
    if (diag && diag.parentNode) diag.parentNode.insertBefore(b, diag);
  }

  function showDiagnostics() {
    const a = S.article || {};
    const counts = [
      ['sections', (a.sections || []).length],
      ['paragraphs', (a.sections || []).reduce((n, s) => n + s.blocks.filter((b) => b.t === 'p').length, 0)],
      ['figures', S.figs.length],
      ['references', S.refs.length],
      ['in-text citations', $$('a[data-ref]').length],
      ['highlights', hlList.length],
    ];
    const warn = (a.warnings || []).map((w) => `<li>${esc(w)}</li>`).join('');
    const pop = $('#pop');
    const btn = $('#btnDiag');
    pop.innerHTML = `
      <div class="pop-head">Parse report</div>
      <div class="pop-txt">
        <table style="width:100%;font-size:.76rem;border-collapse:collapse">
          ${counts.map(([k, v]) => `<tr><td style="padding:.1rem 0;color:var(--fg-soft)">${esc(k)}</td><td style="text-align:right;font-variant-numeric:tabular-nums;font-weight:600">${v}</td></tr>`).join('')}
        </table>
        ${warn ? `<p style="margin:.5rem 0 0;color:var(--fg-soft)">Weak spots: <ul style="margin:.2rem 0 0;padding-left:1.1rem">${warn}</ul></p>` : ''}
        <p style="margin:.5rem 0 0;font-size:.7rem;color:var(--fg-faint)">${esc((a.source && a.source.host) || '')} · ${esc((a.source && a.source.adapter) || 'generic path')}</p>
      </div>`;
    pop.hidden = false;
    pop.classList.add('show');
    const r = btn.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 10, r.right - pop.offsetWidth))}px`;
    pop.style.top = `${r.bottom + 8}px`;
    S.popFor = btn;
  }

  /* ---------------------------------------------------------
     Highlights

     Painted into a blend layer over the article instead of wrapping the
     text in <mark> elements: no DOM surgery, nothing to re-split across
     paragraphs, and the publisher markup (chips, links, figure refs) is
     never touched. Anchors are stored as text + 48 chars of context, so
     they survive a re-parse and a reload.
     --------------------------------------------------------- */
  const HL_COLORS = [
    { id: 'yellow', hex: '#ffe066', label: 'Yellow' },
    { id: 'green', hex: '#a8e6a3', label: 'Green' },
    { id: 'blue', hex: '#a9d3ff', label: 'Blue' },
    { id: 'pink', hex: '#ffb3d1', label: 'Pink' },
    { id: 'purple', hex: '#d6c2ff', label: 'Purple' },
    { id: 'orange', hex: '#ffc78a', label: 'Orange' },
  ];
  const hlHex = (id) => (HL_COLORS.find((c) => c.id === id) || HL_COLORS[0]).hex;
  let hlList = [];        // { id, color, text, prefix, suffix, ts }
  let hlRects = [];       // last painted boxes, for hit-testing
  let hlPalState = null;  // { mode: 'create' | 'edit', id }
  let hlPaintQueued = false;

  /* a stable key for this article: DOI beats URL beats title */
  function articleKey() {
    const m = (S.article && S.article.meta) || {};
    const src = (S.article && S.article.source) || {};
    return String(m.doi || src.url || m.title || location.href).slice(0, 300);
  }
  const hlKey = () => `sr-hl:${articleKey()}`;

  async function hlLoad() {
    const key = hlKey();
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const got = await chrome.storage.local.get(key);
        if (Array.isArray(got[key])) return got[key];
      }
    } catch (e) { /* fall through to localStorage */ }
    try { return JSON.parse(localStorage.getItem(key) || '[]') || []; } catch (e) { return []; }
  }
  async function hlSave() {
    const key = hlKey();
    const list = hlList.map((h) => ({
      id: h.id, color: h.color, text: h.text, prefix: h.prefix, suffix: h.suffix, ts: h.ts,
    }));
    /* the store owns the write when it is loaded (it is, on every page that also runs the
       reader) — that is what lets highlights reach the other devices */
    if (window.SR_LIB && typeof SR_LIB.hlPut === 'function') {
      await SR_LIB.hlPut(key, list);
      if (SR_LIB.sync) SR_LIB.sync.auto();
      return;
    }
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ [key]: list });
        return;
      }
    } catch (e) { /* fall through */ }
    try { localStorage.setItem(key, JSON.stringify(list)); } catch (e) { /* quota */ }
  }

  /* flat text of the article plus the text nodes it is made of */
  function flatIndex() {
    const root = $('#paper');
    const nodes = [];
    let text = '';
    if (!root) return { text, nodes };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let n = walker.nextNode();
    while (n) {
      const v = n.nodeValue || '';
      const parent = n.parentElement;
      if (v && !(parent && parent.closest('.hl-layer'))) {
        nodes.push({ node: n, start: text.length, end: text.length + v.length });
        text += v;
      }
      n = walker.nextNode();
    }
    return { text, nodes };
  }
  /* character offset of a DOM boundary inside the article */
  function offsetOfNode(container, offset) {
    if (container.nodeType === 3) {
      const idx = flatIndex();
      const hit = idx.nodes.find((x) => x.node === container);
      if (hit) return hit.start + offset;
    }
    try {
      const pre = document.createRange();
      pre.setStart($('#paper'), 0);
      pre.setEnd(container, offset);
      return pre.toString().length;
    } catch (e) { return null; }
  }
  function domRange(idx, start, end) {
    const a = idx.nodes.find((x) => start >= x.start && start < x.end);
    const b = idx.nodes.find((x) => end > x.start && end <= x.end);
    if (!a || !b) return null;
    const r = document.createRange();
    r.setStart(a.node, start - a.start);
    r.setEnd(b.node, end - b.start);
    return r;
  }
  /* find the stored span again; the surrounding context decides between repeats */
  function findAnchor(idx, h) {
    const hay = idx.text;
    const needle = h.text;
    if (!hay || !needle) return null;
    let first = -1;
    let from = 0;
    while (from <= hay.length) {
      const i = hay.indexOf(needle, from);
      if (i < 0) break;
      if (first < 0) first = i;
      const before = hay.slice(Math.max(0, i - 48), i);
      const after = hay.slice(i + needle.length, i + needle.length + 48);
      const pOk = !h.prefix || before.endsWith(h.prefix);
      const sOk = !h.suffix || after.startsWith(h.suffix);
      if (pOk && sOk) return [i, i + needle.length];
      from = i + 1;
    }
    return first < 0 ? null : [first, first + needle.length];
  }

  function syncHlMode() {
    const layer = $('#hlLayer');
    if (!layer) return;
    const dark = luminance(getComputedStyle(document.body).backgroundColor) < 0.35;
    layer.dataset.mode = dark ? 'dark' : 'light';
  }
  function schedulePaint() {
    if (hlPaintQueued) return;
    hlPaintQueued = true;
    requestAnimationFrame(() => { hlPaintQueued = false; paintHighlights(); });
  }
  function paintHighlights() {
    const layer = $('#hlLayer');
    const paper = $('#paper');
    if (!layer || !paper) return;
    syncHlMode();
    layer.textContent = '';
    hlRects = [];
    const base = paper.getBoundingClientRect();
    const idx = flatIndex();
    let missed = 0;
    for (const h of hlList) {
      const span = findAnchor(idx, h);
      const range = span ? domRange(idx, span[0], span[1]) : null;
      if (!range) { missed += 1; continue; }
      for (const rect of range.getClientRects()) {
        if (rect.width < 1 || rect.height < 1) continue;
        const box = document.createElement('i');
        const x = rect.left - base.left;
        const y = rect.top - base.top;
        box.style.cssText = `left:${x}px;top:${y}px;width:${rect.width}px;`
          + `height:${rect.height}px;background:${hlHex(h.color)}`;
        layer.appendChild(box);
        hlRects.push({ id: h.id, x, y, w: rect.width, h: rect.height });
      }
    }
    S.hlMissing = missed;
  }
  function hitHighlight(clientX, clientY) {
    const paper = $('#paper');
    if (!paper || !hlRects.length) return null;
    const base = paper.getBoundingClientRect();
    const x = clientX - base.left;
    const y = clientY - base.top;
    for (let i = hlRects.length - 1; i >= 0; i -= 1) {
      const r = hlRects[i];
      if (x >= r.x - 2 && x <= r.x + r.w + 2 && y >= r.y && y <= r.y + r.h) return r;
    }
    return null;
  }

  function hideHlPen() { const bar = $('#hlBar'); if (bar) bar.hidden = true; }
  function hideHlPalette() { const pal = $('#hlPal'); if (pal) pal.hidden = true; }
  function placeFloating(el, x, y) {
    el.hidden = false;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(x, window.innerWidth - w - 8));
    let top = y;
    if (top + h > window.innerHeight - 8) top = Math.max(8, y - h - 28);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  function updateSelectionBar() {
    const bar = $('#hlBar');
    if (!bar) return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) { S.pendingRange = null; bar.hidden = true; return; }
    const range = sel.getRangeAt(0);
    const paper = $('#paper');
    if (!paper || !paper.contains(range.commonAncestorContainer)) { bar.hidden = true; return; }
    if (!sel.toString().trim()) { bar.hidden = true; return; }
    S.pendingRange = range.cloneRange();
    bar.style.setProperty('--hl-now', hlHex(S.hlColor));
    bar.hidden = false;
    const rects = range.getClientRects();
    const last = rects[rects.length - 1] || range.getBoundingClientRect();
    const w = bar.offsetWidth || 32;
    const h = bar.offsetHeight || 32;
    let x = last.right + 6;
    let y = last.top - h - 6;
    if (x + w > window.innerWidth - 8) x = last.right - w;
    if (y < 56) y = last.bottom + 8;
    bar.style.left = `${Math.max(8, x)}px`;
    bar.style.top = `${Math.max(8, y)}px`;
  }

  function openHlPalette(x, y, mode, id) {
    hlPalState = { mode, id: id || null };
    const cur = mode === 'edit' ? (hlList.find((h) => h.id === id) || {}).color : S.hlColor;
    const pal = $('#hlPal');
    pal.innerHTML = HL_COLORS.map((c) => `<button type="button" data-color="${c.id}"
        class="${c.id === cur ? 'on' : ''}" style="background:${c.hex}" title="${esc(c.label)}"></button>`).join('')
      + (mode === 'edit' ? '<button type="button" class="del" data-del="1" title="Remove highlight">✕</button>' : '');
    hideHlPen();
    placeFloating(pal, x, y);
  }

  function commitHighlight(colorId) {
    const range = S.pendingRange;
    S.pendingRange = null;
    hideHlPen();
    hideHlPalette();
    if (!range) return;
    const start = offsetOfNode(range.startContainer, range.startOffset);
    const end = offsetOfNode(range.endContainer, range.endOffset);
    if (start == null || end == null || end <= start) { toast('Could not anchor that selection'); return; }
    const idx = flatIndex();
    const text = idx.text.slice(start, end);
    if (!text.trim()) return;
    /* a selection that sits inside an existing highlight replaces it, otherwise the two
       translucent boxes stack and the text turns muddy */
    hlList = hlList.filter((h) => {
      const span = findAnchor(idx, h);
      return !(span && span[0] <= start && span[1] >= end);
    });
    hlList.push({
      id: `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      color: colorId,
      text,
      prefix: idx.text.slice(Math.max(0, start - 48), start),
      suffix: idx.text.slice(end, end + 48),
      ts: Date.now(),
    });
    S.hlColor = colorId;
    try { localStorage.setItem('sr-hlcolor', colorId); } catch (e) { /* ignore */ }
    hlSave();
    paintHighlights();
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    toast('Highlighted');
  }
  function recolorHighlight(id, colorId) {
    const h = hlList.find((x) => x.id === id);
    if (!h) return;
    h.color = colorId;
    hlSave();
    paintHighlights();
  }
  function removeHighlight(id) {
    const before = hlList.length;
    hlList = hlList.filter((h) => h.id !== id);
    if (hlList.length === before) return;
    hlSave();
    paintHighlights();
    toast('Highlight removed');
  }

  function installHighlightUI() {
    const bar = $('#hlBar');
    const pal = $('#hlPal');

    /* keep the selection alive while the pen is pressed */
    bar.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
    bar.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      commitHighlight(S.hlColor);
    });
    bar.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const r = bar.getBoundingClientRect();
      openHlPalette(r.left, r.bottom + 8, 'create');
    });

    document.addEventListener('pointerup', (e) => {
      if (e.target.closest && (e.target.closest('#hlBar') || e.target.closest('#hlPal'))) return;
      setTimeout(updateSelectionBar, 10);
    });
    document.addEventListener('keyup', (e) => {
      if (e.shiftKey || e.key === 'Shift' || e.key.indexOf('Arrow') === 0) updateSelectionBar();
    });
    document.addEventListener('selectionchange', () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) { S.pendingRange = null; hideHlPen(); }
    });
    /* right-click on a painted highlight: change colour or remove it */
    document.addEventListener('contextmenu', (e) => {
      if (e.target.closest && e.target.closest('#hlBar, #hlPal')) return;
      const hit = hitHighlight(e.clientX, e.clientY);
      if (!hit) return;
      e.preventDefault();
      openHlPalette(e.clientX + 2, e.clientY + 10, 'edit', hit.id);
    });
    pal.addEventListener('click', (e) => {
      e.stopPropagation();
      const b = e.target.closest('button');
      if (!b || !hlPalState) return;
      if (b.dataset.del) removeHighlight(hlPalState.id);
      else if (b.dataset.color) {
        if (hlPalState.mode === 'edit') recolorHighlight(hlPalState.id, b.dataset.color);
        else commitHighlight(b.dataset.color);
      }
      hideHlPalette();
    });
    document.addEventListener('mousedown', (e) => {
      if ($('#hlPal').hidden) return;
      if (e.target.closest && e.target.closest('#hlPal')) return;
      hideHlPalette();
    });

    /* the layer must follow reflow: typeface, size, measure, images, rail toggle */
    if ('ResizeObserver' in window) new ResizeObserver(() => schedulePaint()).observe($('#paper'));
    window.addEventListener('resize', () => schedulePaint());
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => schedulePaint());
    for (const img of $$('figure.fig img')) img.addEventListener('load', () => schedulePaint(), { once: true });
    let rafScroll = false;
    window.addEventListener('scroll', () => {
      if (rafScroll || !S.pendingRange) return;
      rafScroll = true;
      requestAnimationFrame(() => { rafScroll = false; if (S.pendingRange) updateSelectionBar(); });
    }, { passive: true });
  }

  async function initHighlights() {
    const paper = $('#paper');
    if (!paper) return;
    const layer = document.createElement('div');
    layer.className = 'hl-layer';
    layer.id = 'hlLayer';
    paper.appendChild(layer);
    S.hlColor = localStorage.getItem('sr-hlcolor') || 'yellow';
    hlList = await hlLoad();
    paintHighlights();
    installHighlightUI();
  }

  /* ---------------------------------------------------------
     Library: ☆ save, reading history, resume position
     --------------------------------------------------------- */
  const LIBAPI = window.SR_LIB || null;
  const lib = { id: '', saved: false, pct: 0, sectionId: '', lastWrite: 0, dirty: false };

  function setFav(saved) {
    const b = $('#btnFav');
    if (!b) return;
    b.textContent = saved ? '★' : '☆';
    b.classList.toggle('on', saved);
    b.title = saved ? 'Saved — click to remove from my library' : 'Save this article to my library';
    b.setAttribute('aria-pressed', String(!!saved));
  }

  /* which section the reader is actually inside — sections carry the ids, not the headings */
  function currentSectionId() {
    const secs = $$('#paper section[id]');
    let id = '';
    for (const s of secs) {
      if (s.getBoundingClientRect().top <= 140) id = s.id; else break;
    }
    return id;
  }

  function progressPayload() {
    return { pct: lib.pct, sectionId: lib.sectionId, ts: Date.now() };
  }

  function noteProgress(ratio) {
    lib.pct = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
    lib.sectionId = currentSectionId();
    if (!lib.saved || !lib.id) return;
    const now = Date.now();
    if (now - lib.lastWrite < 5000) { lib.dirty = true; return; }
    lib.lastWrite = now;
    lib.dirty = false;
    LIBAPI.patch(lib.id, { progress: progressPayload(), lastReadAt: now });
  }

  function flushProgress() {
    if (!lib.saved || !lib.id) return;
    LIBAPI.patch(lib.id, { progress: progressPayload(), lastReadAt: Date.now() });
    lib.dirty = false;
  }

  async function toggleSaved() {
    if (!LIBAPI || !lib.id) { toast('This article has no stable identifier to save'); return; }
    if (lib.saved) {
      await LIBAPI.remove(lib.id);
      lib.saved = false;
      setFav(false);
      toast('Removed from my library');
      return;
    }
    const entry = LIBAPI.entryFrom(S.article);
    entry.progress = lib.pct > 1 ? progressPayload() : null;
    await LIBAPI.upsert(entry);
    lib.saved = true;
    setFav(true);
    toast('Saved — find it under ▤ My library');
  }

  /* "Save to note" from the translation card: a note lives on a library entry, so an article
     that was never starred is saved on the spot — the button would otherwise do nothing and
     look broken. Both languages are kept: the Chinese alone is unreadable months later. */
  async function saveTranslationNote(original, translated) {
    if (!LIBAPI || !lib.id) return { ok: false, why: 'no-id' };
    let entry = await LIBAPI.get(lib.id);
    if (!entry) {
      const fresh = LIBAPI.entryFrom(S.article);
      fresh.progress = lib.pct > 1 ? progressPayload() : null;
      await LIBAPI.upsert(fresh);
      lib.saved = true;
      setFav(true);
      entry = await LIBAPI.get(lib.id);
      if (!entry) return { ok: false, why: 'save-failed' };
    }
    const line = `【译】${translated}\n【原】${original}`;
    await LIBAPI.patch(lib.id, { note: entry.note ? `${entry.note}\n\n${line}` : line });
    return { ok: true };
  }

  function openLibrary() {
    if (typeof SchReader !== 'undefined' && SchReader && typeof SchReader.openLibrary === 'function') {
      try { SchReader.openLibrary(); return; } catch (e) { /* fall through */ }
    }
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: 'SR_LIBRARY' });
      return;
    }
    window.open('library.html', '_blank');
  }

  function showResume(progress) {
    const pct = Math.max(1, Math.min(100, Math.round(progress.pct || 0)));
    const bar = document.createElement('div');
    bar.className = 'resume';
    bar.innerHTML = `<span>You stopped at ${pct}%</span>
      <button type="button" id="resumeGo">Resume</button>
      <button type="button" class="x" id="resumeNo" aria-label="Dismiss">✕</button>`;
    document.body.appendChild(bar);
    $('#resumeGo').addEventListener('click', () => {
      const h = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo({ top: Math.round(h * pct / 100), behavior: 'smooth' });
      bar.remove();
    });
    $('#resumeNo').addEventListener('click', () => bar.remove());
    setTimeout(() => { if (bar.parentNode) bar.remove(); }, 20000);
  }

  async function initLibrary(a) {
    if (!LIBAPI) return;
    lib.id = LIBAPI.keyFor(a);
    $('#btnFav').addEventListener('click', toggleSaved);
    $('#btnLib').addEventListener('click', openLibrary);

    const url = (a.source && a.source.url) || '';
    const title = (a.meta && a.meta.title) || document.title;
    const journal = (a.meta && a.meta.journal) || (a.source && a.source.host) || '';

    if (url) {
      const entry = lib.id ? await LIBAPI.get(lib.id) : null;
      lib.saved = !!entry;
      setFav(lib.saved);
      if (entry) {
        LIBAPI.patch(lib.id, { lastReadAt: Date.now() });
        if (entry.progress && entry.progress.pct >= 5) showResume(entry.progress);
      }
      /* history is opt-out, and never records the same article twice */
      LIBAPI.pushHistory({ id: lib.id || ('url:' + url), url, title, journal, ts: Date.now() });
    }

    window.addEventListener('pagehide', flushProgress);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flushProgress(); });
  }

  /* ---------------------------------------------------------
     Boot
     --------------------------------------------------------- */
  async function boot() {
    applyTheme(localStorage.getItem('sr-theme') || 'light');
    document.documentElement.dataset.rail = localStorage.getItem('sr-rail') || 'on';
    applyScale(Number(localStorage.getItem('sr-scale')) || 1);
    applyFont(localStorage.getItem('sr-font') || 'palatino');
    applyLeading(Number(localStorage.getItem('sr-leading')) || 1.72);
    applyRead(Number(localStorage.getItem('sr-read')) || 41);

    const a = await loadArticle();
    if (!a) {
      $('#paper').innerHTML = `<div class="boot"><h1>Nothing to show</h1>
        <p>This page expects an article handed over by the extension. Open an article page and
        click the <b>SchReader</b> pill in the bottom-right corner.</p></div>`;
      $('#rail').hidden = true;
      return;
    }
    S.article = a;
    S.figs = a.figures || [];
    S.refs = (a.references || []).slice().sort((x, y) => x.n - y.n);
    S.byRef = new Map(S.refs.map((r) => [r.n, r]));
    S.byFig = new Map(S.figs.map((f) => [f.id, f]));
    document.documentElement.dataset.citestyle = a.citationStyle || 'numeric';

    document.title = `${(a.meta && a.meta.title) || 'Article'} — SchReader`;
    const docTitle = (a.meta && a.meta.title) || 'Untitled article';
    document.title = `${docTitle} — SchReader`;
    $('#docTitle').textContent = docTitle;
    $('#docTitle').title = docTitle;
    const host = (a.source && a.source.host) || '';
    const journal = (a.meta && a.meta.journal) || host;
    $('#srcLabel').innerHTML = `<b>${esc(journal)}</b>${host ? ' · ' + esc(host) : ''}`;
    if (a.source && a.source.url) $('#btnOriginal').href = a.source.url;

    const paper = $('#paper');
    paper.innerHTML = `${renderHeader(a)}
      ${renderBody(a)}`;
    /* citation counts must exist before the reference list is built (it shows back-references) */
    computeCitations();
    paper.insertAdjacentHTML('beforeend', `${renderSupplementary(a)}
      ${renderReferenceList(a)}`);
    renderRail();
    wire();
    setupSpy();
    await initHighlights();
    if (window.SR_TRANSLATE) {
      window.SR_TRANSLATE.init({ paper: $('#paper'), onSaveNote: saveTranslationNote });
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    await initLibrary(a);

    /* images that fail to load get a quiet placeholder */
    for (const img of $$('figure.fig img')) {
      img.addEventListener('error', () => {
        const box = img.closest('figure');
        if (box) box.classList.add('img-failed');
        img.alt = `${img.alt || 'Image'} (could not load — the publisher may block direct image links)`;
      }, { once: true });
    }
  }

  boot();
})();

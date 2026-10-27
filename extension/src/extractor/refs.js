/* SchReader — reference-list discovery + inline citation mapping. */
(() => {
  const SR = (window.SR = window.SR || {});
  const U = (SR.util = SR.util || {});
  const R = (SR.refs = {});

  const HEADING = /^(references?|literature cited|bibliography|works? cited|citations?|references and notes|notes and references|参考文献)$/i;

  const SERVICE_HOST = /(crossref\.org|pubmed\.ncbi|ncbi\.nlm\.nih\.gov|scholar\.google|semanticscholar|adsabs|scopus|webofscience|cas\.org|dimensions\.ai|altmetric|orcid\.org|doi\.org\/10\.|unpaywall|linkout)/i;

  const childNodesOf = (el) => {
    /* the item list inside a reference container */
    const direct = Array.from(el.children || []);
    if (!direct.length) return [];
    const lis = direct.filter((c) => c.tagName === 'LI' || c.getAttribute('role') === 'listitem');
    if (lis.length >= 3) return lis;
    const rich = direct.filter((c) => U.text(c).length > 45 && !U.isJunk(c));
    if (rich.length >= 3) return rich;
    /* one level deeper (div > ol > li, etc.) */
    const nested = [];
    for (const c of direct) {
      const inner = Array.from(c.children || []).filter((x) => x.tagName === 'LI' || U.text(x).length > 45);
      if (inner.length >= 3) nested.push(...inner);
    }
    return nested.length >= 3 ? nested : [];
  };

  const score = (el) => {
    if (!el || !el.isConnected || U.isJunk(el)) return -1;
    const items = childNodesOf(el);
    if (items.length < 3) return -1;
    let good = 0;
    for (const it of items.slice(0, 80)) {
      const t = U.text(it);
      if (t.length > 45) good += 1;
      if (/\b(19|20)\d{2}\b/.test(t)) good += 0.6;
      if (U.findDoi(t)) good += 0.6;
      if (/\bet al\b|,\s*[A-Z]\.|&/.test(t)) good += 0.4;
    }
    return good * 4 + Math.min(items.length, 60) * 0.5 - U.linkDensity(el) * 5;
  };

  const containerCandidates = () => {
    const sels = ['[id*="references" i]', '[class*="reference-list" i]', '[class*="references" i]',
      '[class*="bibliography" i]', '[id*="bibliography" i]', '[class*="citation-list" i]',
      '[class*="ref-list" i]', '[data-test*="reference" i]', 'ol.references', 'section.references'];
    const out = new Set();
    for (const sel of sels) for (const el of U.qsa(document, sel)) out.add(el);
    return Array.from(out);
  };

  /* references that are not wrapped in a container: paragraphs right after a "References" heading */
  const fromHeading = () => {
    const heads = U.qsa(document, 'h1,h2,h3,h4,h5,h6,[role="heading"],strong,b,div,span')
      .filter((h) => HEADING.test(U.text(h)) && U.len(h) < 40);
    for (const h of heads.slice(0, 4)) {
      const block = h.parentElement;
      let scope = h;
      for (let i = 0; i < 3 && scope; i++) {
        scope = scope.nextElementSibling || (scope.parentElement && scope.parentElement.nextElementSibling);
        if (!scope) break;
        const items = childNodesOf(scope);
        if (items.length >= 3) return { node: scope, items };
        const ps = Array.from(scope.children || []).filter((c) => U.text(c).length > 50);
        if (ps.length >= 3) return { node: scope, items: ps };
      }
      if (block) {
        const sib = Array.from(block.children || []).filter((c) => U.text(c).length > 50);
        if (sib.length >= 4) return { node: block, items: sib };
      }
    }
    return null;
  };

  /* trailing counters are part of the label on Cell/ScienceDirect: "Scopus (102)" */
  const SERVICE_TEXT = /^(?:(?:view|open|preview|show|get|find)\s+(?:in|on|at)\s+)?(?:cas|crossref|pubmed(?: central|\/ncbi)?|google scholar|semantic scholar|ads|scopus|web of science|openurl|dimensions|altmetric|researchgate)\s*(?:\([^)]{0,14}\))?$/i;

  /* "View reference in article" style controls: they scroll back into the body and are
     useless inside our own list (Frontiers renders them as <a href="#B12a">) */
  const REF_NAV_TEXT = /^(?:view|see|open|go\s+to)\s+(?:the\s+)?(?:full\s+)?reference(?:\s+in\s+(?:article|page))?$/i;
  const REF_NAV_HREF = /^#B\d{1,3}[a-z]?$/i;

  const stripServiceLinks = (el) => {
    /* anchors that only point at a citation service */
    const isServiceText = (raw) => {
      const t = String(raw || '').replace(/[®™]/g, '').trim();
      return SERVICE_TEXT.test(t) || REF_NAV_TEXT.test(t);
    };
    for (const a of U.qsa(el, 'a[href]')) {
      const href = a.getAttribute('href') || '';
      const t = U.text(a);
      if ((SERVICE_HOST.test(href) || REF_NAV_HREF.test(href) || isServiceText(t)) && t.length < 40) a.remove();
    }
    /* the same service names sometimes survive as bare spans */
    for (const node of U.qsa(el, 'span, i, em, b, sup, small, div')) {
      const t = U.text(node);
      if (t && isServiceText(t) && U.len(el) > t.length * 2) node.remove();
    }
    for (const b of U.qsa(el, 'button, svg')) b.remove();
  };

  /* remove wrappers left empty by the cleanup (they add phantom vertical space) */
  const dropEmpty = (el) => {
    for (const node of U.qsa(el, 'p, div, span, section, ul, ol, li, a')) {
      if (!U.text(node) && !U.qs(node, 'img')) node.remove();
    }
  };

  const leadingNumber = (raw) => {
    const m = String(raw || '').match(/^\s*\[?(\d{1,3})[.)\]]?\s+/);
    return m ? parseInt(m[1], 10) : 0;
  };

  const numFromNode = (node, fallback) => {
    const dc = node.getAttribute('data-counter') || node.getAttribute('data-index') || '';
    const fromDc = leadingNumber(dc) || (/(\d+)/.test(dc) ? parseInt(dc.match(/(\d+)/)[1], 10) : 0);
    if (fromDc) return fromDc;
    const id = node.id || (U.qs(node, '[id]') || {}).id || '';
    const m = String(id).match(/(?:^|[^\d])(\d{1,3})$/);
    if (m && /ref|cite/i.test(id)) return parseInt(m[1], 10);
    const lead = leadingNumber(U.text(node));
    return lead || fallback;
  };

  R.parse = (adapter) => {
    let items = [];
    let container = null;

    /* 1) adapter-provided item selector */
    if (adapter && adapter.refItem) {
      const nodes = U.qsa(document, adapter.refItem).filter((n) => U.text(n).length > 30);
      if (nodes.length >= 3) { items = nodes; container = nodes[0].parentElement; }
    }

    /* 2) best-scoring container by class/id, then by heading */
    if (!items.length) {
      let best = null, bestScore = 0;
      for (const el of containerCandidates()) {
        const s = score(el);
        if (s > bestScore) { bestScore = s; best = el; }
      }
      if (best && bestScore > 12) { items = childNodesOf(best); container = best; }
      if (!items.length) {
        const h = fromHeading();
        if (h) { items = h.items; container = h.node; }
      }
    }

    /* 3) last resort: any <ol> whose items look like citations */
    if (!items.length) {
      let best = null, bestScore = 0;
      for (const ol of U.qsa(document, 'ol')) {
        const s = score(ol);
        if (s > bestScore) { bestScore = s; best = ol; }
      }
      if (best && bestScore > 15) { items = childNodesOf(best); container = best; }
    }

    if (!items.length) return { items: [], container: null };

    const seen = new Set();
    const out = [];
    items.forEach((node, i) => {
      const clone = node.cloneNode(true);
      stripServiceLinks(clone);
      dropEmpty(clone);
      /* ScienceDirect puts the in-text jump target as a leading label:
         <span class="label">Akman Gunduz and Douglas, 2009</span> + the real entry.
         Drop it when the entry itself still has text of its own — but keep its wording,
         because the entry proper starts with initials ("E. Akman Gunduz") and the label is
         the only place the bare surname and year appear. */
      let label = '';
      for (const kid of Array.from(clone.children).slice(0, 2)) {
        const t = U.text(kid);
        if (!t || t.length > 70) continue;
        if (U.len(clone) - t.length < 60) continue;
        const isJumpLabel = !!U.qs(kid, 'a[href^="#"]');
        const looksAuthorYear = /^(\(?\d{1,3}[.)\]]?\)?|[A-Z][^!?]{0,46}?\b(?:19|20)\d{2}[a-z]?\)?)$/.test(t);
        if (isJumpLabel || looksAuthorYear) { label = t; kid.remove(); break; }
      }
      /* the item number may live in its own element ("<span class=\"label\">1.</span>") */
      const firstEl = clone.firstElementChild;
      if (firstEl && /^\d{1,3}[.)\]]?$/.test(U.text(firstEl))) firstEl.remove();
      else if (firstEl && /^\d{1,3}[.)\]]?\s*/.test(U.text(firstEl)) && U.len(firstEl) < U.len(clone) * 0.4) {
        const tn0 = document.createTreeWalker(firstEl, NodeFilter.SHOW_TEXT).nextNode();
        if (tn0) tn0.nodeValue = (tn0.nodeValue || '').replace(/^\s*\d{1,3}[.)\]]?\s*/, '');
      }
      /* drop our own leading "1." numbering, we render our own counters */
      const tn = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
      const first = tn.nextNode();
      if (first && /^\s*\[?\d{1,3}[.)\]]?\s+/.test(first.nodeValue || '')) {
        first.nodeValue = first.nodeValue.replace(/^\s*\[?\d{1,3}[.)\]]?\s+/, '');
      }
      U.absolutize(clone);
      U.separateBlocks(clone);
      U.padCitationParts(clone);
      const text = U.text(clone);
      if (text.length < 12) return;
      const key = U.dedupeKey(text);
      if (seen.has(key)) return;
      seen.add(key);

      const links = U.qsa(clone, 'a[href^="http"]');
      let url = '';
      for (const a of links) {
        const href = a.getAttribute('href') || '';
        if (/doi\.org|\.pdf$|\/abs\/|\/full\//i.test(href)) { url = href; break; }
      }
      if (!url && links.length) url = links[0].getAttribute('href') || '';

      /* keys used later to spot a reference card pasted into the body: the whole entry plus
         its emphasises runs (titles are bold/italic/own-div in most templates) */
      const keys = [];
      const addKey = (v) => { const k = U.dedupeKey(v); if (k.length >= 30) keys.push(k.slice(0, 72)); };
      addKey(text);
      for (const el of U.qsa(clone, 'strong, b, em, i, cite, div, p, span')) {
        const t = U.text(el);
        if (t.length >= 25 && t.length <= 220 && !/\d{4}/.test(t)) addKey(t);
      }

      out.push({
        n: numFromNode(node, i + 1),
        id: node.id || (U.qs(node, '[id]') || {}).id || '',
        label,
        keys,
        html: clone.innerHTML,
        text,
        doi: U.findDoi(text) || U.findDoi(url),
        url,
        citedAt: [],
      });
    });

    /* renumber sequentially only when the source numbers are missing or unusable */
    const nums = out.map((r) => r.n);
    const sane = nums.every((n, i) => n > 0 && (i === 0 || n >= nums[i - 1])) && new Set(nums).size === nums.length;
    if (!sane) out.forEach((r, i) => { r.n = i + 1; });

    return { items: out, container };
  };

  /* ---------- author-year citations ("(Abbot & Moran 2002)") ---------- */
  const SURNAME_RE = /^\s*([A-Z][A-Za-zÀ-ÿ'’\-]{1,})/;

  /* first author surname of a reference item, tolerating "Abbot PA, Moran NA (2002)"
     and ScienceDirect's "E. Akman Gunduz, A.E. Douglas ..." (leading initials) */
  R.surnames = (text) => {
    const head = String(text || '').split(/\((?:19|20)\d{2}[a-z]?\)|\b(?:19|20)\d{2}\b/)[0] || '';
    const first = head.split(/,|&|\band\b|;/)[0] || '';
    const cleaned = first.replace(/^\s*(?:[A-Z]{1,2}\.\s*)+/, '');
    const m = cleaned.match(SURNAME_RE);
    return m ? m[1] : '';
  };

  R.buildNameYear = (refs) => {
    const map = new Map();
    for (const r of refs) {
      const sur = R.surnames(r.label || r.text);
      const y = String(r.label || r.text || '').match(/\b(?:19|20)\d{2}\b/);
      if (!sur || !y) continue;
      const key = `${sur.toLowerCase()}|${y[0]}`;
      if (!map.has(key)) map.set(key, r.n);   // first reference wins on duplicate keys
    }
    return map;
  };

  /* map used to turn in-page anchors / numbers into canonical reference numbers */
  R.linkMap = (refs) => {
    const byId = new Map();
    const byNum = new Map();
    for (const r of refs) {
      if (r.id) byId.set(r.id, r.n);
      byNum.set(String(r.n), r.n);
    }
    return { byId, byNum, max: refs.length };
  };
})();

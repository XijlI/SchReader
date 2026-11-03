/* SchReader — body discovery + block/section walking + inline citation & figure linking. */
(() => {
  const SR = (window.SR = window.SR || {});
  const U = (SR.util = SR.util || {});
  const B = (SR.blocks = {});

  const CAND = 'h2,h3,h4,h5,p,figure,table,pre,blockquote,ul,ol,div,[data-sr-figure]';
  const HOLDER = 'figure,table,ul,ol,blockquote,pre';

  /* some publishers (PNAS/Literatum, several news CMSs) put body paragraphs in bare
     <div>s. A leaf div — only inline children — is a paragraph, not a wrapper. */
  const INLINE_ONLY = /^(SPAN|A|B|I|EM|STRONG|SUP|SUB|U|SMALL|BR|CODE|ABBR|MARK|FONT|WBR|IMG|TIME|Q|CITE|S|DEL|INS|VAR|SAMP|KBD|BIG|TT|NOBR)$/;
  const isTextLeaf = (el) => {
    for (const c of el.children) if (!INLINE_ONLY.test(c.tagName)) return false;
    return true;
  };
  const BOILERPLATE = /^(download|download pdf|download full[- ]size image|share|share this article|cite this article|cite|citation|copy link|rights and permissions|reprints|reprint|permissions|buy article|buy this article|access options|access through your institution|sign in|log in|register|view full text|view pdf|save|related articles|recommended articles|you may also like|most read|article metrics|metrics|advertisement|open in new tab|go to figure|back to top|show more|show less|read more)$/i;

  /* ---------- root discovery ---------- */
  const headingCount = (el) => {
    let n = 0;
    for (const h of U.qsa(el, 'h2,h3')) {
      if (h.closest('figure,table,aside,[data-sr-skip]')) continue;
      const t = U.text(h);
      if (t.length > 1 && t.length < 200) n++;
    }
    return n;
  };

  B.findRoot = (hints, anchors) => {
    anchors = (anchors || []).filter(Boolean);
    for (const sel of hints || []) {
      const el = U.qs(document, sel);
      if (el && U.text(el).length > 600) return el;
    }

    const scores = new Map();
    /* body text may live in <p> or in bare leaf <div>s (PNAS/Literatum, many CMSs) */
    const textBlocks = [];
    for (const el of U.qsa(document, 'p, div')) {
      if (el.tagName === 'DIV' && !isTextLeaf(el)) continue;
      if (!el.textContent || el.textContent.length < 80) continue;
      if (U.isJunk(el)) continue;
      const t = U.text(el);
      /* a leaf div inside another leaf div is a duplicate — keep the outer one only */
      if (el.parentElement && el.parentElement.tagName === 'DIV' && isTextLeaf(el.parentElement) && U.len(el.parentElement) >= t.length) continue;
      textBlocks.push(el);
    }
    for (const p of textBlocks) {
      const t = U.len(p);
      let node = p.parentElement, depth = 0;
      while (node && node !== document.body && depth < 4) {
        const add = (depth === 0 ? 1 : 0.45) * Math.min(t / 200, 3);
        scores.set(node, (scores.get(node) || 0) + add);
        node = node.parentElement; depth++;
      }
    }

    const ranked = [];
    for (const [el, s] of scores) {
      if (U.isJunk(el)) continue;
      let sc = s * (1 - U.linkDensity(el) * 0.75);
      if (el.tagName === 'ARTICLE' || el.tagName === 'MAIN') sc *= 1.15;
      if (el.closest('nav,footer,aside,[class*="comment" i],[class*="related" i]')) sc *= 0.2;
      ranked.push({ el, sc, heads: headingCount(el), len: U.len(el) });
    }

    /* prefer a container that looks like a whole article (several section headings),
       which stops one huge "Methods" block from winning on paragraph mass alone */
    const whole = ranked.filter((r) => r.heads >= 2 && r.len > 900);
    const pool = whole.length ? whole : ranked;
    pool.sort((a, b) => (b.sc - a.sc) || (b.len - a.len));
    let best = pool.length ? pool[0].el : null;

    /* climb out of thin wrappers only — never up into page chrome */
    let guard = 0;
    while (best && best.parentElement && best.parentElement !== document.body && guard++ < 3) {
      const par = best.parentElement;
      if (U.isJunk(par)) break;
      if (headingCount(par) !== headingCount(best)) break;
      const parText = U.len(par), ownText = U.len(best);
      if (parText - ownText > ownText * 0.2) break;
      if (U.linkDensity(par) > 0.3) break;
      if (U.qsa(par, 'p').length > U.qsa(best, 'p').length * 1.2 + 3) break;
      best = par;
    }

    /* an article body must also contain the reference list and the abstract —
       climbing to their common ancestor pulls in the sibling sections that a
       single high-scoring block would otherwise hide */
    if (best && anchors.length) {
      let node = best;
      while (node && node !== document.body && anchors.some((a) => !node.contains(a))) node = node.parentElement;
      if (node && node !== document.body && U.linkDensity(node) < 0.35 && U.len(node) < 400000) best = node;
    }

    if (!best) best = U.qs(document, 'article, main, [role="main"]') || document.body;
    return best;
  };

  /* ---------- mark junk once, on the live tree (marks ride along into the clone) ---------- */
  B.markJunk = (root) => {
    const rootLen = U.len(root);
    /* if the whole article is still hidden the page has not finished revealing it — marking
       descendants would empty the result, so skip the visibility pass in that case */
    const rootHidden = U.isHiddenStyle(root);
    /* Citation popovers: a trigger carries aria-controls / data-db-target-for pointing at the
       card it reveals. Cell keeps one card next to every citation, and the card holds a whole
       reference entry — drop the target, never the trigger or its number. */
    const popTargets = new Set();
    for (const el of U.qsa(root, '[aria-controls], [data-db-target-for], [aria-describedby]')) {
      for (const attr of ['aria-controls', 'data-db-target-for', 'aria-describedby']) {
        const v = el.getAttribute(attr);
        if (!v) continue;
        for (const id of v.split(/\s+/)) if (id) popTargets.add(id);
      }
    }
    for (const el of U.qsa(root, '*')) {
      if (el.hasAttribute('data-sr-skip') || el.closest('[data-sr-skip]')) continue;
      if (el.id && popTargets.has(el.id)) { el.setAttribute('data-sr-skip', 'popover'); continue; }
      if (U.isJunk(el)) {
        /* never discard something that reads like article content: a class token
           ("section toc-section", "commentary-body") must not outweigh 900 chars of text */
        if (U.len(el) > 900 && U.linkDensity(el) < 0.35) continue;
        /* A class token such as "figureButton" is not chrome: Frontiers wraps every figure
           (image + caption) in <button class="ArticleFigure__figureButton"> so its own
           lightbox opens on click. Junk-marking that button deleted 3 of 4 figures. */
        if (el.querySelector && el.querySelector('figure')) continue;
        if (el.querySelector && el.querySelector('img') && U.len(el) > 80) continue;
        el.setAttribute('data-sr-skip', '1');
        continue;
      }
      /* anything the stylesheet hides is not article text: collapsed panels, duplicate
         mobile/desktop copies, and the citation cards Cell parks beside every reference.
         checkVisibility is style-only, so this is cheap enough to run on every node. */
      const rawLen = el.textContent ? el.textContent.length : 0;
      if (rawLen < 20 || rawLen > rootLen * 0.6) continue;
      if (!rootHidden && U.isHiddenStyle(el)) { el.setAttribute('data-sr-skip', 'hidden'); continue; }
      if (el.querySelector && rawLen > 200 && U.isInvisible(el)) {
        el.setAttribute('data-sr-skip', 'hidden');
      }
    }
    /* service menus: mark only the innermost one. Cell wraps the citation number and the
       reference popover in the same span, so marking the outer element would eat the "1". */
    const menus = new Set(U.qsa(root, '*').filter((el) => U.isServiceMenu(el)));
    const hasMenuChild = new Set();
    for (const m of menus) for (let p = m.parentElement; p; p = p.parentElement) hasMenuChild.add(p);
    for (const m of menus) {
      if (hasMenuChild.has(m)) continue;                 /* an outer wrapper, not the menu itself */
      if (m.closest('[data-sr-skip]')) continue;        /* already covered by an ancestor mark */
      m.setAttribute('data-sr-skip', 'menu');
    }
  };

  /* ---------- mobile accordion layouts ----------
     PLOS and other mobile templates render the whole body as an accordion:
       <ul class="main-accordion"><li class="accordion-item">
         <a class="expander">1. Introduction</a>
         <section class="accordion-content">…paragraphs…</section>
       </li>…
     Walked as-is the <ul> is a list candidate, so every paragraph is skipped as "inside a
     list" and the paper ships as one giant bullet list with no section headings. Flatten it:
     the trigger becomes an <h2>, the panel's content joins the body flow. */
  B.flattenAccordions = (root) => {
    const lists = U.qsa(root, 'ul, ol').filter((el) => {
      if (!/accordion|expander|collaps/i.test(`${el.className || ''} ${el.id || ''}`)) return false;
      return [...el.children].filter((c) => c.tagName === 'LI').length >= 2;
    });
    let count = 0;
    for (const list of lists) {
      for (const li of [...list.children]) {
        if (li.tagName !== 'LI') continue;
        const kids = [...li.children];
        const trig = kids.find((k) => /expand|toggle|accordion/i.test(`${k.className || ''} ${k.id || ''}`)
          && !/content|panel/i.test(String(k.className || '')));
        const panel = kids.find((k) => k !== trig
          && (/content|panel/i.test(String(k.className || '')) || k.tagName === 'SECTION' || k.tagName === 'DIV'));
        if (trig && panel) {
          const label = U.text(trig);
          if (label && label.length <= 200 && !BOILERPLATE.test(label)) {
            const h = document.createElement('h2');
            h.textContent = label;
            li.insertBefore(h, trig);
            trig.remove();
          }
        }
        /* a skip mark on the item (e.g. "this panel is the abstract / the reference list")
           must survive the unwrap, or the reader renders the abstract twice */
        const inherited = li.getAttribute('data-sr-skip');
        if (inherited) for (const c of [...li.children]) c.setAttribute('data-sr-skip', inherited);
        /* unwrap the item: its children join the flow (still inside the clone only) */
        const frag = document.createDocumentFragment();
        while (li.firstChild) frag.appendChild(li.firstChild);
        li.replaceWith(frag);
      }
      const parent = list.parentNode;
      if (parent) {
        const inherited = list.getAttribute('data-sr-skip');
        if (inherited) for (const c of [...list.children]) c.setAttribute('data-sr-skip', inherited);
        const frag = document.createDocumentFragment();
        while (list.firstChild) frag.appendChild(list.firstChild);
        list.replaceWith(frag);
      }
      count++;
    }
    return count;
  };

  B.clearMarks = (root) => {
    for (const el of U.qsa(root, '[data-sr-skip]')) el.removeAttribute('data-sr-skip');
  };

  /* ---------- headings that are not headings ----------
     Some templates (Atypon/Literatum: Annual Reviews, and anything else on that platform)
     render a section title as <div class="tl-main-part title"> inside a plain div, and a
     subheading as <p class="tl-lowest-section">. Nothing in the walker sees them, so the whole
     paper arrived as one unnamed section. The adapter names the elements; promote them to real
     h2/h3 on the clone (text only — the divider wrapper also carries the section menu). */
  B.promoteHeadings = (root, adapter) => {
    if (!adapter) return 0;
    let n = 0;
    for (const [sel, tag] of [[adapter.headings, 'H2'], [adapter.subheadings, 'H3']]) {
      if (!sel) continue;
      for (const el of U.qsa(root, sel)) {
        if (!el.parentNode || el.tagName === tag) continue;
        if (el.closest('[data-sr-skip]')) continue;
        const t = U.text(el);
        if (!t || t.length > 260 || BOILERPLATE.test(t)) continue;
        const h = document.createElement(tag);
        h.textContent = t;
        el.replaceWith(h);
        n++;
      }
    }
    return n;
  };

  /* ---------- collapsed mobile sections ----------
     Some publishers render the article body as a stack of collapsed accordions on phones
     (PLOS: `section.accordion-content { display:none }` until the heading is tapped). The
     visibility pass in markJunk then deletes the whole body, and the reader comes out empty
     with no error anywhere. That text is the only copy on the page, so revive it. A collapsed
     element whose text is already visible elsewhere is a genuine duplicate (mobile + desktop
     copies of one block) and stays hidden. */
  B.reviveCollapsed = (root) => {
    const hidden = U.qsa(root, '[data-sr-skip="hidden"]');
    if (!hidden.length) return 0;
    const visible = U.norm(root.innerText || '');
    let revived = 0;
    for (const el of hidden) {
      if (!el.parentNode) continue;
      /* a collapsed *content* block always holds paragraphs or tiles; a hidden header
         wrapper (Atypon's "Go to section…" divider) holds only divs and got revived as if
         it were a hidden section. The whole subtree is marked 'hidden' by the same pass, so
         only 'junk'/'menu' marks (chrome we named) disqualify an inner paragraph. */
      const hasContent = U.qsa(el, 'p, li, figure, table, h2, h3, h4')
        .some((n) => !n.closest('[data-sr-skip="junk"], [data-sr-skip="menu"], [data-sr-skip="popover"]'));
      if (!hasContent) continue;
      const t = U.norm(el.textContent || '');
      if (t.length < 300) continue;                        /* collapse chrome, not a section */
      if (visible.includes(t.slice(0, 80))) continue;      /* already on screen somewhere else */
      el.removeAttribute('data-sr-skip');
      /* the marks inside came from the same collapsed container */
      for (const d of U.qsa(el, '[data-sr-skip="hidden"]')) d.removeAttribute('data-sr-skip');
      revived++;
    }
    return revived;
  };

  /* ---------- inline citation -> chip ---------- */
  const chip = (n) => {
    const a = document.createElement('a');
    a.className = 'ref-chip';
    a.setAttribute('data-ref', String(n));
    a.setAttribute('href', `#ref-${n}`);
    a.textContent = String(n);
    return a;
  };

  const expandNums = (spec) => {
    const out = [];
    const parts = String(spec).split(/\s*,\s*/);
    for (const p of parts) {
      const range = p.match(/^(\d{1,3})\s*[–—-]\s*(\d{1,3})$/);
      if (range) {
        const a = +range[1], b = +range[2];
        if (b >= a && b - a < 30) { for (let i = a; i <= b; i++) out.push(i); continue; }
      }
      const m = p.match(/^\d{1,3}$/);
      if (m) out.push(+p);
    }
    return out;
  };

  const replaceAnchor = (a, nums) => {
    const frag = document.createDocumentFragment();
    nums.forEach((n, i) => {
      if (i) frag.appendChild(document.createTextNode(','));
      frag.appendChild(chip(n));
    });
    a.replaceWith(frag);
  };

  /* A printed range split across links — <a>20</a>–<a>23</a> — leaves the numbers in between
     with no element of their own, so references 21 and 22 read as "not cited in text" and can
     never be located (PNAS and Nature both print ranges this way). Rewrite such a range as the
     numbers it stands for, each with its own chip; leave one alone when every middle number is
     missing from the reference list. */
  const siblingChip = (el, dir) => {
    let node = el;
    for (let hop = 0; hop < 4 && node; hop++) {
      let s = dir < 0 ? node.previousSibling : node.nextSibling;
      while (s && s.nodeType === 3 && !/\S/.test(s.nodeValue || '')) s = dir < 0 ? s.previousSibling : s.nextSibling;
      if (!s) { node = node.parentElement; continue; }
      if (s.nodeType !== 1) return null;
      if (s.classList && s.classList.contains('ref-chip')) return s;
      const inner = U.qsa(s, 'a.ref-chip');
      return inner.length ? (dir < 0 ? inner[inner.length - 1] : inner[0]) : null;
    }
    return null;
  };

  const stitchRanges = (root, refMap) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (t) => (/^[–—-]$/.test((t.nodeValue || '').trim()) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    const dashes = [];
    let tn;
    while ((tn = walker.nextNode())) dashes.push(tn);
    let filled = 0;
    for (const d of dashes) {
      if (!d.parentNode) continue;
      const left = siblingChip(d, -1);
      const right = siblingChip(d, 1);
      if (!left || !right || left === right) continue;
      const a = Number(left.dataset.ref), b = Number(right.dataset.ref);
      if (!a || !b || b <= a || b - a > 30) continue;
      let cover = 0;
      for (let i = a + 1; i < b; i++) if (refMap.byNum.has(String(i))) cover++;
      if (!cover) continue;
      const frag = document.createDocumentFragment();
      for (let i = a; i <= b; i++) {
        if (i > a) frag.appendChild(document.createTextNode(','));
        frag.appendChild(refMap.byNum.has(String(i)) ? chip(i) : document.createTextNode(String(i)));
      }
      left.replaceWith(frag);
      if (d.parentNode) d.remove();
      if (right.parentNode) right.remove();
      filled += cover;
    }
    return filled;
  };

  /* author-year chip: keeps the original wording, just becomes clickable */
  const chipNY = (n, text) => {
    const a = document.createElement('a');
    a.className = 'ref-chip ny';
    a.setAttribute('data-ref', String(n));
    a.setAttribute('data-ny', '1');
    a.setAttribute('href', `#ref-${n}`);
    a.textContent = text;
    return a;
  };

  const NY_RE = /\(?\b([A-Z][A-Za-zÀ-ÿ'’\-]{1,})(?:(?:\s*(?:&|and|et\s+al\.?)\s*)([A-Z][A-Za-zÀ-ÿ'’\-]{1,})?)?[,’']*\s*\(?((?:19|20)\d{2})[a-z]?\)?/g;

  B.linkNameYear = (node, nyMap) => {
    if (!nyMap || !nyMap.size) return 0;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
      acceptNode: (t) => (t.parentElement && t.parentElement.closest('a, sup, .ref-chip, script, style, h2, h3'))
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const targets = [];
    let tn;
    while ((tn = walker.nextNode())) {
      NY_RE.lastIndex = 0;
      if (NY_RE.test(tn.nodeValue || '')) targets.push(tn);
    }
    let hits = 0;
    for (const t of targets) {
      const s = t.nodeValue;
      const frag = document.createDocumentFragment();
      let last = 0, m, hit = false;
      NY_RE.lastIndex = 0;
      while ((m = NY_RE.exec(s))) {
        const n = nyMap.get(`${m[1].toLowerCase()}|${m[3]}`);
        if (!n) continue;
        hit = true;
        frag.appendChild(document.createTextNode(s.slice(last, m.index)));
        frag.appendChild(chipNY(n, m[0].replace(/\s+/g, ' ').trim()));
        last = m.index + m[0].length;
        hits++;
      }
      if (!hit) continue;
      frag.appendChild(document.createTextNode(s.slice(last)));
      t.replaceWith(frag);
    }
    return hits;
  };

  B.linkCitations = (node, refMap, nyMap) => {
    if (!refMap || !refMap.max) return;

    /* 0. Some publishers render an in-text citation as a widget, not a link: Frontiers ships
         <button|span role="button" id="B3-button" class="ArticleReference">…<span
         id="B3a" aria-hidden="true"></span>3</button|span>. Buttons are widget chrome and get
         stripped later (cleanBlock), which is why the citation numbers used to vanish. Convert
         first — and match on the id convention alone, not on a tag: the 2025 template swapped
         the <button> for a <span>, so a tag-qualified query missed all 84 markers and every
         reference read "not cited in text" while the body showed bare numbers. */
    for (const el of U.qsa(node, '[id$="-button"]')) {
      if (!el.parentNode) continue;
      const m = (el.id || '').match(/^B(\d{1,3})[a-z]?-button$/i);
      if (!m) continue;
      const n = Number(m[1]);
      if (!refMap.byNum.has(String(n))) continue;
      if (!/^\d{1,3}$/.test(U.text(el).trim())) continue;
      replaceAnchor(el, [n]);
    }
    /* same idea, but keyed on the class name when the id is not informative */
    for (const el of U.qsa(node, 'button')) {
      if (!el.parentNode) continue;
      if (!/referen|citation|cite|bib/i.test(`${el.id} ${el.className}`)) continue;
      const t = U.text(el).trim();
      if (!/^\d{1,3}$/.test(t)) continue;
      const n = Number(t);
      if (!refMap.byNum.has(String(n))) continue;
      replaceAnchor(el, [n]);
    }

    /* 0c. Citation markers that are neither links nor <sup>. MDPI renders one as
         <span role="link" class="html-reference" aria-label="Reference 4"
               reference-link="#B4-insects-12-00871">4</span>
         and leaves the square brackets around it as ordinary text. Nothing above sees
         these: there is no href, no sup, and the "[3,4]" shape lives in several nodes, so
         the numbered text never matches either. Read the target from the attribute (the
         id may be absent on a saved page, so fall back to the number it carries), then
         drop the brackets the template left behind. */
    const CITE_ATTR = ['reference-link', 'data-reference-link', 'data-reference', 'data-ref-id', 'data-cite', 'data-citation'];
    const CITE_CLASS = '[class*="html-reference" i], [class*="html-bibr" i]';

    /* "right" strips the "]" that follows the last marker of a group, "left" the "["
       that precedes the first one — the other markers of the group see a comma, not a
       bracket, so running this per marker needs no group bookkeeping. */
    const dropBracket = (el, side) => {
      const sib = side === 'left' ? el.previousSibling : el.nextSibling;
      if (!sib || sib.nodeType !== 3) return;
      const v = sib.nodeValue || '';
      const m = side === 'left' ? v.match(/^(.*?)\s*\[\s*$/) : v.match(/^\s*\]\s*(.*)$/);
      if (!m) return;
      sib.nodeValue = m[1];
      if (!sib.nodeValue.trim()) sib.remove();
    };

    const citeNum = (el, raw) => {
      const frag = String(raw || '').split('#').pop().trim();
      if (frag && refMap.byId.has(frag)) return refMap.byId.get(frag);
      const tries = [
        frag.match(/^B?(\d{1,3})[a-z]?(?:$|[-_.])/i),
        String(el.getAttribute('aria-label') || '').match(/(\d{1,3})\s*$/),
        U.text(el).trim().match(/^\[?(\d{1,3})\]?$/),
      ];
      for (const m of tries) {
        const n = m ? Number(m[1]) : 0;
        if (n && refMap.byNum.has(String(n))) return n;
      }
      return 0;
    };

    for (const el of U.qsa(node, CITE_ATTR.map((a) => `[${a}]`).join(',') + ',' + CITE_CLASS)) {
      if (!el.parentNode || el.classList.contains('ref-chip')) continue;
      if (el.closest('a[href], .ref-chip')) continue;   /* step 1 owns real links */
      const raw = CITE_ATTR.map((a) => el.getAttribute(a)).find(Boolean) || '';
      const n = citeNum(el, raw);
      if (!n) continue;
      dropBracket(el, 'left');
      dropBracket(el, 'right');
      replaceAnchor(el, [n]);
    }

    /* 1. anchors that target a reference item */
    for (const a of U.qsa(node, 'a[href]')) {
      if (a.classList.contains('ref-chip') || !a.parentNode) continue;
      const href = a.getAttribute('href') || '';
      const frag = href.indexOf('#') >= 0 ? href.slice(href.indexOf('#') + 1) : '';
      let nums = [];
      if (frag && refMap.byId.has(frag)) nums = [refMap.byId.get(frag)];
      else {
        const t = U.text(a).replace(/[\[\]\s]/g, '');
        const sig = href + ' ' + (a.className || '') + ' ' + (a.getAttribute('data-test') || '') + ' ' + (a.getAttribute('role') || '');
        if (/^\d{1,3}(,\d{1,3})*$/.test(t) && /ref|cite|bib|footnote/i.test(sig)) {
          nums = expandNums(t).filter((n) => refMap.byNum.has(String(n)));
          if (nums.length > 6) nums = [];
        }
      }
      if (nums.length) replaceAnchor(a, nums);
      else if (nyMap && nyMap.size) {
        /* author-year anchor pointing at a target we cannot resolve (#b6 and friends):
           read the surname/year out of the anchor's own text instead */
        const t = U.text(a);
        const m = t.match(/^\(?\s*([A-Z][A-Za-zÀ-ÿ'’\-]{1,})(?:(?:\s*(?:&|and|et\s+al\.?)\s*)([A-Z][A-Za-zÀ-ÿ'’\-]{1,})?)?[,’']*\s*\(?((?:19|20)\d{2})/);
        if (m) {
          const n = nyMap.get(`${m[1].toLowerCase()}|${m[3]}`);
          if (n) a.replaceWith(chipNY(n, t.replace(/\s+/g, ' ').trim()));
        }
      }
    }

    /* 2. <sup> holding bare numbers ("12", "3,4", "5–7") */
    for (const sup of U.qsa(node, 'sup')) {
      if (!sup.parentNode) continue;
      if (U.qsa(sup, 'a, .ref-chip').length) continue;
      const t = U.text(sup);
      if (!/^\[?\s*\d{1,3}(\s*[,-–—]\s*\d{1,3})*\s*\]?$/.test(t)) continue;
      /* A superscript that continues a number is an exponent, not a citation:
         "1×10^6 cells/mL" (ref 6 exists) used to become a chip and inflate the count. */
      let prev = sup.previousSibling;
      while (prev && prev.nodeType !== 3 && prev.nodeType !== 1) prev = prev.previousSibling;
      if (prev && prev.nodeType === 3 && /[\d×·^*]\s*$/.test(prev.nodeValue || '')) continue;
      const nums = expandNums(t.replace(/[\[\]]/g, '')).filter((n) => refMap.byNum.has(String(n)));
      if (!nums.length) continue;
      const frag = document.createDocumentFragment();
      nums.forEach((n, i) => { if (i) frag.appendChild(document.createTextNode(',')); frag.appendChild(chip(n)); });
      sup.replaceWith(frag);
    }

    /* 3. bracketed citations left as plain text */
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
      acceptNode: (t) => (t.parentElement && t.parentElement.closest('a, sup, script, style, .ref-chip'))
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const targets = [];
    let tn;
    while ((tn = walker.nextNode())) {
      if (/\[\s*\d{1,3}(\s*[,-–—]\s*\d{1,3})*\s*\]/.test(tn.nodeValue || '')) targets.push(tn);
    }
    for (const t of targets) {
      const frag = document.createDocumentFragment();
      let last = 0;
      const s = t.nodeValue;
      const re = /\[\s*(\d{1,3}(?:\s*[,-–—]\s*\d{1,3})*)\s*\]/g;
      let m;
      while ((m = re.exec(s))) {
        const nums = expandNums(m[1]).filter((n) => refMap.byNum.has(String(n)));
        if (!nums.length) continue;
        frag.appendChild(document.createTextNode(s.slice(last, m.index)));
        nums.forEach((n, i) => {
          if (i) frag.appendChild(document.createTextNode(','));
          frag.appendChild(chip(n));
        });
        last = m.index + m[0].length;
      }
      if (!last) continue;
      frag.appendChild(document.createTextNode(s.slice(last)));
      t.replaceWith(frag);
    }

    /* 4. "20–23" printed as two links: give the numbers in between chips of their own */
    stitchRanges(node, refMap);
  };

  /* ---------- "Fig. 3" mentions -> anchors ---------- */
  const FIG_LABEL = /^((?:Figs?\.?|Figures?)\s*\d{1,2})/i;

  B.linkFigureMentions = (node, figs) => {
    if (!figs || !figs.length) return;
    const byNum = new Map();
    for (const f of figs) {
      /* "Extended Data Fig. 2" is a different object from "Fig. 2" — never cross-link them */
      if (/^(Extended\s+Data|Supplementary)\b/i.test(f.label || '')) continue;
      const m = String(f.label || '').match(/(\d{1,2})/);
      if (m) byNum.set(m[1], f);
    }
    if (!byNum.size) return;

    /* publishers usually wrap the figure number in its own <a>; link that anchor in place */
    for (const a of U.qsa(node, 'a[href]')) {
      const t = U.text(a);
      if (!FIG_LABEL.test(t) || /^(Extended\s+Data|Supplementary)\b/i.test(t)) continue;
      const num = (t.match(/(\d{1,2})/) || [])[1];
      const f = byNum.get(num);
      if (!f) continue;
      a.setAttribute('data-fig', f.id);
      a.removeAttribute('href');
      a.removeAttribute('target');
    }

    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
      acceptNode: (t) => (t.parentElement && t.parentElement.closest('a, sup, h2, h3, figcaption, .ref-chip, .fig-link'))
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const targets = [];
    let tn;
    while ((tn = walker.nextNode())) {
      const v = tn.nodeValue || '';
      if (/(?:Figs?\.?|Figures?)\s*\d{1,2}/i.test(v)) targets.push(tn);
      else if (/(Figs?\.?|Figures?)\s*$/i.test(v)) targets.push(tn);   // "… (Fig. <a>1</a>)"
    }

    for (const t of targets) {
      /* case A: the number lives in the following inline element — common on Nature/Springer */
      const tail = (t.nodeValue || '').match(/(Figs?\.?|Figures?)\s*$/i);
      if (tail) {
        if (/(Extended\s+Data|Supplementary)\s+$/i.test(t.nodeValue.slice(0, -tail[0].length))) continue;
        let sib = t.nextSibling;
        while (sib && sib.nodeType === 3 && !/\S/.test(sib.nodeValue || '')) sib = sib.nextSibling;
        if (!sib || sib.nodeType !== 1) continue;
        const dm = U.text(sib).match(/^(\d{1,2})/);
        if (!dm) continue;
        const f = byNum.get(dm[1]);
        if (!f) continue;
        if (sib.tagName === 'A') {
          sib.setAttribute('data-fig', f.id);
          sib.removeAttribute('href');
          sib.removeAttribute('target');
        } else {
          const wrap = document.createElement('a');
          wrap.setAttribute('data-fig', f.id);
          sib.parentNode.insertBefore(wrap, sib);
          wrap.appendChild(sib);
        }
        continue;
      }

      /* case B: the whole mention sits in one text node */
      const re = /()(?:Figs?\.?|Figures?)\s*(\d{1,2})/gi;
      const s = t.nodeValue;
      const frag = document.createDocumentFragment();
      let last = 0, m, hit = false;
      while ((m = re.exec(s))) {
        /* skip mentions that belong to Extended Data / Supplementary figures */
        const before = s.slice(Math.max(0, m.index - 16), m.index);
        if (/(Extended\s+Data\s+|Supplementary\s+)$/i.test(before)) continue;
        const f = byNum.get(m[2]);
        if (!f) continue;
        hit = true;
        frag.appendChild(document.createTextNode(s.slice(last, m.index)));
        const a = document.createElement('a');
        a.className = 'fig-link';
        a.setAttribute('data-fig', f.id);
        a.textContent = m[0];
        frag.appendChild(a);
        last = m.index + m[0].length;
      }
      if (!hit) continue;
      frag.appendChild(document.createTextNode(s.slice(last)));
      t.replaceWith(frag);
    }
  };

  /* ---------- walk ---------- */
  const cleanBlock = (node) => {
    const c = node.cloneNode(true);
    for (const j of U.qsa(c, 'button, script, style, form, input, select, textarea, noscript, [data-sr-skip]')) j.remove();
    for (const a of U.qsa(c, 'a[href]')) {
      const t = U.text(a);
      if (t && BOILERPLATE.test(t) && U.len(a) < 40) { a.remove(); continue; }
      a.removeAttribute('target');
    }
    U.absolutize(c);
    return c.innerHTML;
  };

  const headingLevel = (tag) => (tag === 'H2' ? 1 : tag === 'H3' ? 2 : 3);

  B.walk = (root, opts) => {
    const { exclude = [], refMap = null, figs = [], nyMap = null } = opts || {};
    const sections = [];
    let cur = { id: 'lead', title: '', level: 0, blocks: [] };
    const seen = new Set();
    const cands = U.qsa(root, CAND);
    const candSet = new Set(cands);
    const figBySrc = new Map(figs.map((f) => [f.src, f]));

    const push = (block) => {
      if (cur.blocks.length === 0 && sections.length === 0 && block.t === 'p') {
        cur.title = cur.title || '';
      }
      cur.blocks.push(block);
    };

    for (const node of cands) {
      /* walk runs on a detached clone, so check parentNode, never isConnected */
      if (!node.parentNode) continue;
      if (node.closest('[data-sr-skip]')) continue;
      if (exclude.some((x) => x && (x === node || (x.contains && x.contains(node))))) continue;

      /* a figure container marked by figures.collect(): emit the figure exactly here */
      const stamp = node.getAttribute && node.getAttribute('data-sr-figure');
      if (stamp) {
        const fkey = 'fig:' + stamp;
        if (!seen.has(fkey)) { seen.add(fkey); push({ t: 'figure', fid: stamp }); }
        continue;
      }
      const insideFig = node.closest('[data-sr-figure]');
      if (insideFig && insideFig !== node) continue;

      const holder = node.parentElement && node.parentElement.closest(HOLDER);
      if (holder && holder !== node && candSet.has(holder)) continue;

      const tag = node.tagName;
      const txt = U.text(node);

      if (/^H[2-5]$/.test(tag)) {
        if (!txt || txt.length > 260) continue;
        if (BOILERPLATE.test(txt)) continue;
        /* anything collected before the first heading belongs to the lead section */
        if (cur.blocks.length && !sections.includes(cur)) sections.push(cur);
        const id = node.id || `sec-${U.domId(txt)}`;
        cur = { id, title: txt, level: headingLevel(tag), blocks: [] };
        sections.push(cur);
        continue;
      }

      if (tag === 'FIGURE') {
        const imgs = U.qsa(node, 'img');
        const img = imgs.sort((a, b) => (b.naturalWidth || 0) * (b.naturalHeight || 0) - (a.naturalWidth || 0) * (a.naturalHeight || 0))[0];
        const src = img ? U.imgSrc(img) : '';
        const f = figBySrc.get(src);
        if (f) {
          const key = 'fig:' + f.id;
          if (seen.has(key)) continue;
          seen.add(key);
          push({ t: 'figure', fid: f.id });
        } else if (src) {
          push({ t: 'image', src, alt: img ? (img.getAttribute('alt') || '') : '', html: cleanBlock(node) });
        }
        continue;
      }

      if (tag === 'TABLE') {
        if (txt.length < 8) continue;
        /* A table with a single cell is a layout box, not data — Atypon wraps a whole
           subsection in <table><tr><td><p>…, so the table branch flattened four paragraphs
           (and their heading) into one run-on block. Let its children walk as body flow. */
        if (U.qsa(node, 'td, th').length <= 1 && U.qs(node, 'p, div, h2, h3, h4, ul, ol')) {
          candSet.delete(node);
          continue;
        }
        /* table cells carry citations too (Frontiers' primer table cites refs 27–30) —
           link them before cleanBlock strips the <button> markers, or those references
           read "not cited in text" while the brackets around them come out empty */
        B.linkFigureMentions(node, figs);
        B.linkCitations(node, refMap, nyMap);
        const cap = U.qs(node, 'caption');
        push({
          t: 'table',
          label: cap ? U.norm(U.text(cap)).slice(0, 120) : '',
          html: cleanBlock(node),
        });
        continue;
      }

      if (txt.length < 2 && !U.qs(node, 'img')) continue;
      if (tag === 'DIV') {
        /* a wrapper div has block children; a paragraph div does not */
        if (!isTextLeaf(node)) continue;
        if (txt.length < 60) continue;
      }
      if (U.linkDensity(node) > 0.55 && txt.length < 400) continue;
      if (BOILERPLATE.test(txt)) continue;

      const key = U.dedupeKey(txt);
      if (key.length > 20) {
        if (seen.has(key)) continue;
        seen.add(key);
      } else if (U.qsa(node, 'img').length === 0) continue;

      /* figure linking first: publishers wrap "Fig. 1" numbers in anchors, and citation
         linking would otherwise rewrite those anchors */
      B.linkFigureMentions(node, figs);
      B.linkCitations(node, refMap, nyMap);
      if (nyMap) B.linkNameYear(node, nyMap);

      const html = cleanBlock(node);
      if (!html || html === '<br>') continue;

      const type = tag === 'P' ? 'p'
        : (tag === 'UL' || tag === 'OL') ? 'list'
        : (tag === 'BLOCKQUOTE') ? 'quote'
        : (tag === 'PRE') ? 'pre' : 'p';

      push({ t: type, html });
    }

    /* attachment of citation chips happens on each serialized block */
    const out = [];
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      const next = sections[i + 1];
      /* keep a heading-only section when it owns subsections (e.g. "Methods") */
      if (s.blocks.length) out.push(s);
      else if (next && (next.level || 1) > (s.level || 1)) out.push(s);
    }
    if (cur.blocks.length && !out.includes(cur)) out.push(cur);
    return out;
  };

  /* run the citation/figure linking over one serialized block, then hand back html */
  B.finalizeBlock = (html, refMap, figs, isCaptionSafe) => {
    if (!html) return '';
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const frag = tpl.content;
    const wrap = document.createElement('div');
    wrap.appendChild(frag);
    B.linkCitations(wrap, refMap);
    if (!isCaptionSafe) B.linkFigureMentions(wrap, figs);
    return wrap.innerHTML;
  };
})();

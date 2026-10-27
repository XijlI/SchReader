/* SchReader — shared DOM helpers (content-script scope, also loadable in a normal page) */
(() => {
  const SR = (window.SR = window.SR || {});
  const U = (SR.util = {});

  U.qsa = (root, sel) => { try { return Array.from((root || document).querySelectorAll(sel)); } catch (e) { return []; } };
  U.qs = (root, sel) => U.qsa(root, sel)[0] || null;
  U.norm = (s) => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  U.text = (el) => U.norm(el && el.textContent || '');
  U.len = (el) => U.text(el).length;

  U.abs = (href, base) => {
    if (!href) return '';
    const h = String(href).trim();
    if (!h || h === '#') return '';
    try { return new URL(h, base || document.baseURI).href; } catch (e) { return h; }
  };

  /* biggest candidate inside a srcset string ("a.jpg 640w, b.jpg 1280w") */
  U.srcsetLargest = (srcset) => {
    if (!srcset) return '';
    let best = '', bestScore = -1;
    for (const part of String(srcset).split(',')) {
      const bits = part.trim().split(/\s+/);
      if (!bits[0]) continue;
      const d = bits[1] || '1x';
      const score = /w$/i.test(d) ? parseFloat(d) : (parseFloat(d) || 1) * 1200;
      if (score > bestScore) { bestScore = score; best = bits[0]; }
    }
    return best;
  };

  /* resolve an <img> to the highest-quality http(s) URL we can find */
  /* prefer the image behind a link when the link points at a larger version */
  U.imgSrc = (img) => {
    const c = [];
    const anchor = img.closest('a[href]');
    if (anchor) {
      const abs = U.abs(anchor.getAttribute('href') || '');
      /* The anchor around a thumbnail usually points at a bigger copy — but on mobile
         publishers it often points at an HTML figure *page* (PLOS mobile:
         /plosone/article/figure?id=…), which then renders as a broken image. Only take the
         anchor when it reads like an image URL, not like a viewer page. */
      const looksImage = /\.(png|jpe?g|gif|webp|tiff?)(\?|$)/i.test(abs) ||
        /\/(image|images|img|photo|media)\b/i.test(abs) ||
        /[?&](image|imageurl|imgurl|file|size|format)=/i.test(abs);
      if (/^https?:/i.test(abs) && !/download/i.test(abs) && looksImage) {
        c.push(abs);
      }
    }
    if (img.currentSrc) c.push(img.currentSrc);
    c.push(img.getAttribute('src'));
    for (const a of ['data-src', 'data-lazy-src', 'data-original', 'data-highres', 'data-full-src', 'data-zoom-src']) {
      const v = img.getAttribute(a); if (v) c.push(v);
    }
    const own = U.srcsetLargest(img.getAttribute('srcset') || img.getAttribute('data-srcset'));
    if (own) c.push(own);
    const pic = img.closest('picture');
    if (pic) for (const s of U.qsa(pic, 'source')) {
      const v = U.srcsetLargest(s.getAttribute('srcset') || s.getAttribute('data-srcset') || s.getAttribute('data-src'));
      if (v) c.push(v);
    }
    for (const raw of c) {
      if (!raw) continue;
      const abs = U.abs(raw);
      if (/^data:image\//i.test(abs) && abs.length < 400) continue;   // spacer pixel
      if (/^https?:/i.test(abs)) return abs;
    }
    return '';
  };

  const JUNK = /(^|[\s_-])(advert\w*|ads?|sponsor\w*|promo\w*|newsletter|subscribe|subscription|cookie\w*|consent|gdpr|related|recommend\w*|read-?more|most-?read|popular|share|sharing|social|metrics|altmetric|citation-?metric|breadcrumb|footer|site-?header|masthead|navbar|nav-?bar|navigation|menu|toolbar|banner|modal|popup|overlay|skip-?link|search|login|signin|paywall|access-?options|institutional|buy-?article|rights|permissions|reprint|export-?citation|save-?article|download-?pdf|article-?tools|author-?info|affiliation-?list|figure-?(?:gallery|carousel)|pagination|table-of-contents|outline|collateral|feedback|survey|disqus|comments|tooltips?|popovers?|hover-?card|preview-?card)([\s_-]|$)/i;

  U.isJunk = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (/^(NAV|FOOTER|HEADER|ASIDE|FORM|BUTTON|SELECT|INPUT|TEXTAREA|SCRIPT|STYLE|NOSCRIPT|IFRAME|SVG|CANVAS)$/.test(tag)) return true;
    if (el.getAttribute('role') === 'navigation' || el.getAttribute('aria-hidden') === 'true') return true;
    const sig = `${el.id || ''} ${el.getAttribute('class') || ''} ${el.getAttribute('data-test') || ''} ${el.getAttribute('data-component') || ''}`;
    return JUNK.test(sig);
  };

  /* style-only visibility test: Element.checkVisibility evaluates display/visibility and does
     NOT force layout the way getBoundingClientRect does, so it is safe to call on every node. */
  U.isHiddenStyle = (el) => {
    try {
      if (el.checkVisibility) return !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      const cs = getComputedStyle(el);
      return cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0;
    } catch (e) { return false; }
  };

  /* true when an element is not rendered (duplicated mobile/desktop copies, collapsed panels) */
  U.isInvisible = (el) => {
    try {
      if (!el.isConnected) return true;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return true;
      const r = el.getBoundingClientRect();
      return r.width < 2 && r.height < 2;
    } catch (e) { return false; }
  };

  U.linkDensity = (el) => {
    const total = U.len(el);
    if (!total) return 1;
    let a = 0;
    for (const x of U.qsa(el, 'a')) a += U.text(x).length;
    return Math.min(a / total, 1);
  };

  U.dedupeKey = (s) => U.norm(s).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 160);

  U.domId = (s) => U.norm(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'x';

  U.escapeHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  U.DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>]+)/i;
  U.findDoi = (s) => {
    const m = String(s || '').match(U.DOI_RE);
    if (!m) return '';
    return m[1].replace(/[.,;)\]]+$/, '');
  };

  /* resolve every relative URL inside a cloned subtree so the reader page can load it */
  U.absolutize = (root) => {
    for (const a of U.qsa(root, 'a[href]')) {
      const v = a.getAttribute('href');
      if (v && !/^(#|javascript:|mailto:|tel:)/i.test(v)) {
        const abs = U.abs(v);
        if (abs) a.setAttribute('href', abs);
      }
    }
    for (const el of U.qsa(root, 'img, source, video, audio, iframe')) {
      for (const attr of ['src', 'poster']) {
        const v = el.getAttribute(attr);
        if (v && !/^(data:|blob:)/i.test(v)) {
          const abs = U.abs(v);
          if (abs) el.setAttribute(attr, abs);
        }
      }
      for (const attr of ['srcset', 'data-srcset']) {
        const v = el.getAttribute(attr);
        if (v) el.setAttribute(attr, v.split(',').map((p) => {
          const bits = p.trim().split(/\s+/);
          return [U.abs(bits[0]), bits[1] || ''].filter(Boolean).join(' ');
        }).join(', '));
      }
    }
  };
  /* ---------- block separators ---------- */
  const BLOCK_TAGS = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DIV|DL|DT|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TBODY|TD|TFOOT|TH|THEAD|TR|UL)$/;

  /* textContent has no separators across block boundaries, so a reference written as
     <div>authors</div><div>title</div> reads as "DouglasSymbiotic bacteria" once flattened.
     Put a space after every block element so flattened text and rendered text agree. */
  U.separateBlocks = (root) => {
    for (const el of U.qsa(root, '*')) {
      if (!BLOCK_TAGS.test(el.tagName)) continue;
      const nx = el.nextSibling;
      if (nx && nx.nodeType === 3 && /^\s/.test(nx.nodeValue || '')) continue;
      el.parentNode.insertBefore(document.createTextNode(' '), el.nextSibling);
    }
  };

  /* JATS-style references split a name into inline spans with no whitespace between them
     (Frontiers: surname "Abreu" + initials "CC" inside one .References__name), which reads
     as "AbreuCC". Only join element→element boundaries whose classes say they are parts of
     a citation, so ordinary inline markup is left alone. */
  const CIT_PART = /name|surname|given|initial|author|editor|volume|pages?|year|title|journal|source|publisher/i;
  U.padCitationParts = (root) => {
    for (const el of U.qsa(root, 'span, i, b, em, sup, sub, a')) {
      if (!CIT_PART.test(String(el.className || ''))) continue;
      let nx = el.nextSibling;
      while (nx && nx.nodeType === 8) nx = nx.nextSibling;   /* skip HTML comments */
      if (!nx || nx.nodeType !== 1) continue;
      if (!CIT_PART.test(String(nx.className || ''))) continue;
      if (!/[A-Za-z0-9]\s*$/.test(el.textContent || '')) continue;
      if (!/^\s*[A-Za-z0-9]/.test(nx.textContent || '')) continue;
      el.parentNode.insertBefore(document.createTextNode(' '), nx);
    }
  };

  /* ---------- publisher service menus ---------- */
  const SERVICE_WORDS = /(crossref|scopus|pubmed|semantic scholar|google scholar|web of science|openurl|dimensions|altmetric|researchgate)/gi;

  /* a block offering two or more citation services is a menu, never article text —
     this catches ScienceDirect "ReferenceLinks" and Cell's inlined citation popovers */
  U.isServiceMenu = (el) => {
    const raw = el.textContent;                       /* no regex on huge subtrees */
    if (!raw || raw.length < 12 || raw.length > 500) return false;
    const hits = new Set((raw.match(SERVICE_WORDS) || []).map((s) => s.toLowerCase()));
    return hits.size >= 2;
  };
})();

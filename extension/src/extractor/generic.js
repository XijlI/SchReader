/* SchReader — orchestrator: live page -> article model. */
(() => {
  const SR = (window.SR = window.SR || {});
  const U = SR.util;
  const G = (SR.orchestrate = {});

  /* index path of `el` inside `root`, so the same node can be found in the clone */
  const pathOf = (root, el) => {
    const path = [];
    let n = el;
    while (n && n !== root) {
      const p = n.parentElement;
      if (!p) return null;
      path.unshift(Array.prototype.indexOf.call(p.children, n));
      n = p;
    }
    return n === root ? path : null;
  };
  const follow = (root, path) => {
    let n = root;
    for (const i of path) { n = n && n.children[i]; if (!n) return null; }
    return n;
  };

  const collectSupplementary = (pdfUrl) => {
    const out = [];
    const seen = new Set();
    for (const a of U.qsa(document, 'a[href]')) {
      const href = a.href || '';
      const text = U.text(a);
      if (!href || !/^https?:/i.test(href)) continue;
      if (text.length < 3 || text.length > 120) continue;
      if (/^(download\s+)?pdf$/i.test(text) || (pdfUrl && href === pdfUrl)) continue;  // the article PDF itself
      const isFile = /\.(pdf|xlsx?|docx?|zip|csv|mp4|mov|avi|tif|tiff)$/i.test(href);
      const looksSupp = /supplement|supporting information|source data|extended data|additional file|media\s*\d|movie|dataset/i.test(`${text} ${href}`);
      if (!isFile && !looksSupp) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      out.push({ label: text || href.split('/').pop(), href, kind: isFile ? 'file' : 'link' });
      if (out.length >= 24) break;
    }
    return out;
  };

  /* numeric vs author-year: decide BEFORE linking so numeric papers never get stray
     "Smith 2002" links from ordinary prose */
  const detectStyle = (root, refs) => {
    /* strongest signal: citation anchors whose text is "Heie, 1987" / "Shigenobu et al. 2000" */
    const NY_LIKE = /^\(?\s*[A-Z][A-Za-zÀ-ÿ'’\-]{1,}(?:(?:\s*(?:&|and|et\s+al\.?)\s*)[A-Z]?[A-Za-zÀ-ÿ'’\-]*)?[,’']*\s*\(?(?:19|20)\d{2}/;
    const nyLike = U.qsa(root, 'a').filter((a) => NY_LIKE.test(U.text(a))).length;
    if (nyLike >= 4) return 'name-year';

    const numericAnchors = U.qsa(root, 'a[href]').filter((a) => {
      const h = a.getAttribute('href') || '';
      const sig = `${a.getAttribute('data-test') || ''} ${a.className || ''}`;
      return /#\s*ref|#bib|#r\d|#cr\d/i.test(h) || /ref|cite/i.test(sig);
    }).length;
    const numSups = U.qsa(root, 'sup').filter((s) => /^\s*\[?\d/.test(U.text(s))).length;
    /* markers that carry the target as an attribute instead of a URL (MDPI:
       <span reference-link="#B4-…">4</span>) — they are numeric citations too, and on a
       page whose only <sup>s are affiliation numbers this is the sole signal */
    const numMarked = U.qsa(root, '[reference-link], [data-reference-link], [data-cite], [class*="html-reference" i]').length;
    if (numericAnchors + numSups + numMarked >= 3) return 'numeric';
    if (!refs.length) return 'numeric';
    /* name-year reference lists put the year right after the author list */
    const early = refs.filter((r) => {
      const t = String(r.text || '');
      const i = t.search(/\b(?:19|20)\d{2}\b/);
      return i >= 0 && i < Math.max(40, t.length * 0.35);
    }).length;
    return early >= refs.length * 0.5 ? 'name-year' : 'numeric';
  };

  SR.extract = () => {
    const t0 = (performance && performance.now) ? performance.now() : Date.now();
    const warnings = [];
    const host = location.hostname;
    const adapter = (SR.adapters || []).find((a) => a.hosts.some((re) => re.test(host))) || null;

    const meta = SR.meta.extract();
    if (!meta.title) warnings.push('title');

    /* references and abstract are discovered first: their position tells us how far the
       article container has to reach (an article contains its main text AND its refs) */
    const refsResult = SR.refs.parse(adapter);
    const references = refsResult.items;
    if (!references.length) warnings.push('no reference list found');

    const absInfo = SR.meta.abstractNode();

    const root = SR.blocks.findRoot(adapter && adapter.articleRoot, [refsResult.container, absInfo && absInfo.el]);
    const rootTextLen = U.len(root);
    if (!root || rootTextLen < 400) warnings.push('article body looks very short');

    SR.blocks.markJunk(root);
    const revived = SR.blocks.reviveCollapsed(root);
    if (revived) warnings.push('collapsed sections revived: ' + revived);

    let abstractHtml = absInfo ? (U.absolutize(absInfo.clone), absInfo.clone.innerHTML) : meta.abstractHtml;
    /* Some publishers store the abstract as escaped markup inside a meta tag
       ("&lt;h2&gt;Summary&lt;/h2&gt;&lt;p&gt;…"), which would otherwise render as literal text.
       Decode exactly once — the reader sanitizes whatever comes out of here. */
    if (abstractHtml && /&lt;\/?(?:p|div|br|span|b|i|em|strong|h[1-6])\b/i.test(abstractHtml)) {
      const ta = document.createElement('textarea');
      ta.innerHTML = abstractHtml;
      abstractHtml = ta.value;
      /* we render our own "Abstract" heading, so drop a duplicate one (it may sit behind
         an empty <p> left over from the escaped markup) */
      abstractHtml = abstractHtml
        .replace(/^(?:\s*<p>\s*)*\s*<h[1-6][^>]*>\s*(?:abstract|summary|摘要|概要)\s*<\/h[1-6]>\s*/i, '')
        .replace(/^(\s*<p>\s*)+/i, '');
    }
    if (!abstractHtml) warnings.push('no abstract found');

    /* nodes rendered separately (reference panel, abstract) must not also appear in the body
       flow. Mark them on the LIVE tree so the mark rides into the clone: path arithmetic
       stops matching as soon as flattenAccordions rewrites the structure. */
    const exclude = [];
    const markSeparate = (el) => {
      if (!el || !root.contains(el) || el === root) return;
      /* drop the whole wrapper (heading included), but never one that is most of the article */
      let node = el;
      const wrap = el.closest('section, li, div[class*="section" i], div[id*="section" i]');
      if (wrap && wrap !== root && root.contains(wrap) && U.len(wrap) < U.len(root) * 0.4) node = wrap;
      node.setAttribute('data-sr-skip', 'exclude');
      exclude.push(node);
    };
    markSeparate(refsResult.container);
    if (absInfo) markSeparate(absInfo.el);

    const clone = root.cloneNode(true);
    U.absolutize(clone);

    for (const sel of (adapter && adapter.junk) || []) {
      for (const el of U.qsa(clone, sel)) el.remove();
    }

    const figures = SR.figures.collect(clone);
    if (!figures.length) warnings.push('no figures found');

    const flattened = SR.blocks.flattenAccordions(clone);
    if (flattened) warnings.push('accordion layout flattened: ' + flattened);

    const refs = references.map((r) => ({
      n: r.n, id: r.id, html: r.html, text: r.text, doi: r.doi, url: r.url,
    }));
    const refMap = SR.refs.linkMap(refs);
    const citationStyle = detectStyle(root, refs);
    const nyMap = citationStyle === 'name-year' ? SR.refs.buildNameYear(refs) : null;

    let sections = SR.blocks.walk(clone, { exclude, refMap, figs: figures, nyMap });

    /* A reference card pasted into the body is never article text. Whatever the template
       (Cell's hidden citation cards, a "cited by" drawer, a preview list), the node repeats a
       reference entry we already hold — so strip anything matching one of those keys. */
    const refKeys = Array.from(new Set(references.flatMap((r) => r.keys || [])));
    if (refKeys.length) {
      const stripInlineRefs = (html) => {
        if (!html) return html;
        const tpl = document.createElement('template');
        tpl.innerHTML = html;
        let changed = false;
        for (const el of Array.from(tpl.content.querySelectorAll('div, span, section, p, li, blockquote, figure, td, aside'))) {
          const t = el.textContent || '';
          if (t.length < 25) continue;
          const k = U.dedupeKey(t);
          if (k && refKeys.some((rk) => k.includes(rk))) { el.remove(); changed = true; }
        }
        return changed ? tpl.innerHTML : html;
      };
      for (const s of sections) for (const b of s.blocks) if (b.html) b.html = stripInlineRefs(b.html);
      sections = sections.filter((s) => s.blocks.length || s.title);
    }

    /* Extended Data / Supplementary sections on a publisher page are usually just shells that
       link to a separate page — their links already live in `supplementary`, so drop the shells */
    sections = sections.filter((s) => !/^(Extended\s+Data\s+(Fig|Table)|Supplementary\s+(Figs?|Figures?|Information|Table|Data|Movie|Video))/i.test(s.title || ''));

    /* the reader renders its own reference list and its own supplementary block, so a body
       section repeating them is noise; UI shells ("View options", "eReader") are pure chrome */
    const isShell = (s) => {
      const short = s.blocks.every((b) => (b.html ? b.html.replace(/<[^>]+>/g, '').length : 0) < 90);
      return short && /^(view options|information|pdf|pdf and supporting information|ereader|download|references|bibliography|literature cited|works cited|notes and references)$/i.test(s.title || '');
    };
    sections = sections.filter((s) => !isShell(s));

    /* the reader renders its own title/author/affiliation/date header, so matching blocks that
       leaked into the lead section are duplicates — drop them */
    const stripHtml = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const metaStrings = {
      doi: norm(meta.doi),
      date: norm(meta.date),
      authors: (meta.authors || []).map(norm).filter((a) => a.length > 4),
      affils: (meta.affiliations || []).map(norm).filter((a) => a.length > 12),
    };
    const isMetaBlock = (b) => {
      const t = norm(stripHtml(b.html));
      if (!t || t.length > 600) return false;
      if (metaStrings.doi && t.includes(metaStrings.doi)) return true;
      if (metaStrings.date && t.includes(metaStrings.date)) return true;
      if (metaStrings.affils.some((a) => t.includes(a) || a.includes(t))) return true;
      if (metaStrings.authors.length && metaStrings.authors.filter((a) => t.includes(a)).length >= Math.min(2, metaStrings.authors.length)) return true;
      if (/^(received|accepted|published online|first published|revised|issue published)\b/i.test(t)) return true;
      return false;
    };
    if (sections.length > 1 || (sections[0] && !sections[0].title)) {
      const lead = sections.find((s) => !s.title);
      if (lead) lead.blocks = lead.blocks.filter((b) => !isMetaBlock(b));
    }
    sections = sections.filter((s) => s.blocks.length || s.title);

    /* Publisher footers. Frontiers packs keywords, the citation line, editors, reviewers,
       copyright, the licence and promo art into a final "Summary" section (plus a promo
       blurb section). None of it is article content, and the promo image used to arrive as
       a body image block. */
    const FOOTER_TITLE = /^(?:summary|share|cite this article|article metrics|related articles|most viewed|people also looked at|expert judgment makes science stronger|frontiers is open science)$/i;
    const FOOTER_BLOCK = /^(?:©|copyright\b|this is an open-access article|open-access article|correspondence:|edited by|reviewed by|received:|accepted:|published:|keywords\b|all claims expressed|the authors declare|licen[cs]e\b)/i;
    /* only near the end: plenty of articles open with a section called "Summary" */
    sections = sections.filter((s, i) => !(i >= sections.length - 2 && FOOTER_TITLE.test((s.title || '').trim())));
    const isPromoImage = (b) => b.t === 'image' && /(?:brand\.|marketing|promo(?:tion)?[-_/])/i.test(String(b.html || ''));
    sections = sections.map((s, i) => {
      const tail = i >= sections.length - 2;
      return {
        ...s,
        blocks: s.blocks.filter((b) => {
          if (isPromoImage(b)) return false;
          if (tail && b.t === 'p' && FOOTER_BLOCK.test(stripHtml(b.html))) return false;
          return true;
        }),
      };
    });
    sections = sections.filter((s) => s.blocks.length || s.title);

    const bodyText = sections.reduce((n, s) => n + s.blocks.reduce((m, b) => m + (b.html ? b.html.length : 0), 0), 0);
    if (!sections.length) warnings.push('no body sections (abstract-only page?)');
    else if (bodyText < 1200) warnings.push('body text is thin');

    SR.blocks.clearMarks(root);

    const model = {
      source: {
        url: location.href,
        host,
        adapter: adapter ? adapter.id : '',
        journal: meta.journal,
        doi: meta.doi,
        pdfUrl: meta.pdfUrl,
      },
      meta: {
        title: meta.title,
        subtitle: meta.subtitle,
        journal: meta.journal,
        publisher: meta.publisher,
        articleType: meta.articleType,
        doi: meta.doi,
        date: meta.date,
        volume: meta.volume,
        pages: meta.pages,
        authors: meta.authors,
        affiliations: meta.affiliations,
        keywords: meta.keywords,
      },
      abstractHtml,
      sections,
      figures,
      references: refs,
      citationStyle,
      supplementary: collectSupplementary(meta.pdfUrl),
      warnings,
      stats: {
        ms: Math.round((performance && performance.now ? performance.now() : Date.now()) - t0),
        bodyChars: rootTextLen,
        paragraphs: sections.reduce((n, s) => n + s.blocks.filter((b) => b.t === 'p').length, 0),
      },
    };
    return model;
  };
})();

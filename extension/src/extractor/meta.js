/* SchReader — metadata layer. Reads Highwire citation_* metas (used by most publishers)
   then falls back to dc.* / og:* / visible DOM. */
(() => {
  const SR = (window.SR = window.SR || {});
  const U = (SR.util = SR.util || {});
  const M = (SR.meta = {});

  const contentOf = (sel) => {
    const el = U.qs(document, sel);
    return el ? U.norm(el.getAttribute('content') || el.getAttribute('value') || '') : '';
  };
  const metaAll = (name) => U.qsa(document, `meta[name="${name}"], meta[property="${name}"]`)
    .map((e) => U.norm(e.getAttribute('content') || '')).filter(Boolean);

  const FIRST = ['citation_title', 'dc.title', 'og:title', 'twitter:title'];

  M.pick = (names) => {
    for (const n of names) {
      const v = contentOf(`meta[name="${n}"], meta[property="${n}"]`);
      if (v) return v;
    }
    return '';
  };

  /* "Surname, Given Names" -> "Given Names Surname" */
  M.authorName = (raw) => {
    const s = U.norm(raw).replace(/\s*[;|]\s*$/, '');
    if (!s) return '';
    if (/^\s*\d|^\s*[A-Z]\.?\s*$/.test(s)) return '';
    const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
    if (parts.length === 2 && parts[1].length < 60 && !/\d{4}/.test(parts[1])) return `${parts[1]} ${parts[0]}`;
    return s;
  };

  M.authors = () => {
    let list = metaAll('citation_author');
    if (!list.length) list = metaAll('citation_authors').join(';').split(';').map((s) => s.trim());
    let names = list.map(M.authorName).filter(Boolean);
    if (names.length) return names;

    /* DOM fallbacks: byline containers. Each author is normally one element (an <a>, a
       <button>, an <li>), so group the container's own children instead of harvesting every
       nested span — that splits "Eva Nováková" into two names on ScienceDirect. */
    const sels = ['[class*="author-list"]', '[class*="article-author"]', '[class*="author-group"]',
      '[class*="contributor"]', '[class*="author"]', '[id*="author"]', '[data-test="author-list"]', '.byline'];
    /* "Eva Nováková a b" — ScienceDirect appends affiliation letters to the name */
    const cleanName = (t) => String(t || '')
      .replace(/\s+(?:[a-z]\s*){1,3}$/, '')
      .replace(/\s+/g, ' ').trim();
    const BAD_AUTHOR = /author|editor|search|correspond|get rights|show more|show less|view all|download|share|cite/i;
    const groupsOf = (box) => {
      const kids = Array.from(box.children);
      if (kids.length >= 2) return kids;
      const deeper = kids.flatMap((k) => Array.from(k.children));
      return deeper.length >= 2 ? deeper : kids;
    };
    let best = [], bestScore = 0;
    for (const sel of sels) {
      for (const box of U.qsa(document, sel).slice(0, 8)) {
        const names = groupsOf(box).map(U.text).map(cleanName)
          .filter((t) => t.length > 3 && t.length < 60 && /^[A-ZÀ-Ý\u4e00-\u9fa5]/.test(t)
            && !/[0-9]/.test(t) && !BAD_AUTHOR.test(t));
        const uniq = Array.from(new Set(names));
        if (uniq.length < 2 || uniq.length > 40) continue;
        const spaced = uniq.filter((n) => /\s/.test(n)).length;
        const score = spaced * 2 + Math.min(uniq.length, 8);
        if (score > bestScore) { bestScore = score; best = uniq; }
      }
    }
    return best.map(M.authorName).filter(Boolean);
  };

  M.affiliations = () => {
    const out = [];
    const meta = metaAll('citation_author_institution');
    if (meta.length) return Array.from(new Set(meta));
    const sels = ['[id*="affiliation"] li', '[class*="affiliation"] li', '[id*="affiliations"] li',
      '[class*="affiliations"] li', '[class*="author-affiliation"]', '[class*="institution"]'];
    for (const sel of sels) {
      const nodes = U.qsa(document, sel).slice(0, 20);
      const texts = nodes.map(U.text).filter((t) => t.length > 8 && t.length < 400);
      if (texts.length) { texts.forEach((t) => out.push(t)); break; }
    }
    /* the block right under the title that starts with a digit is usually the affiliation list */
    if (!out.length) {
      const h1 = U.qs(document, 'h1');
      let n = h1;
      for (let i = 0; i < 6 && n; i++) {
        n = n.nextElementSibling || (n.parentElement && n.parentElement.nextElementSibling);
        if (!n) break;
        const t = U.text(n);
        if (t.length > 20 && t.length < 900 && (/^\d[\s.,]/.test(t) || /universit|institut|department|laborator|school|college|hospital|academy/i.test(t))) {
          t.split(/\s{3,}|\s*\|\s*/).map(U.norm).filter((x) => x.length > 12).forEach((x) => out.push(x));
          break;
        }
      }
    }
    return out.filter((v, i, a) => v && a.indexOf(v) === i).slice(0, 12);
  };

  M.abstractNode = () => {
    const cleanClone = (el) => {
      const clone = el.cloneNode(true);
      for (const h of U.qsa(clone, 'h1, h2, h3, h4, [class*="heading" i], [class*="title" i]')) {
        if (/^abstract$/i.test(U.text(h))) h.remove();
      }
      for (const j of U.qsa(clone, 'button, script, style, nav, form, [class*="tool" i]')) j.remove();
      return clone;
    };
    const tryEl = (el) => {
      if (!el || el.nodeType !== 1 || U.isJunk(el)) return null;
      const clone = cleanClone(el);
      const t = U.text(clone);
      if (t.length > 120 && t.length < 14000) return { el, clone };
      return null;
    };

    /* 1. the usual ids/classes */
    const cands = ['#abstract', '[id="abstract"]', '[id^="abstract-"]', '[class*="abstract" i]',
      'section[aria-labelledby*="abstract" i]', 'div[role="paragraph"][class*="abstract" i]', 'section#abstract'];
    for (const sel of cands) {
      for (const el of U.qsa(document, sel).slice(0, 8)) {
        const hit = tryEl(el);
        if (hit) return hit;
      }
    }

    /* 2. publisher-agnostic: find the heading that says "Abstract" and take its container */
    const heads = U.qsa(document, 'h1,h2,h3,h4,h5,div,span,strong,b')
      .filter((h) => /^abstract$/i.test(U.text(h)) && U.len(h) <= 24);
    for (const h of heads.slice(0, 4)) {
      const wrap = h.parentElement;
      const sib = h.nextElementSibling;
      const hit = tryEl(wrap && U.len(wrap) > 400 ? wrap : null) || tryEl(sib) || tryEl(wrap);
      if (hit) {
        if (hit.el === wrap && !U.qs(hit.el, 'h1,h2,h3,h4')) {
          /* wrapper only held the heading — fall back to the sibling content */
          const alt = tryEl(sib);
          if (alt) return alt;
        }
        return hit;
      }
    }
    return null;
  };

  M.abstractHtml = () => {
    const found = M.abstractNode();
    if (found) return found.clone.innerHTML;
    const m = M.pick(['citation_abstract', 'dc.description', 'og:description', 'description']);
    return m && m.length > 100 ? `<p>${U.escapeHtml(m)}</p>` : '';
  };

  M.doi = () => {
    let d = M.pick(['citation_doi', 'dc.identifier', 'dc.identifier.doi', 'prism.doi', 'doi']);
    if (d && /10\.\d{4,9}\//.test(d)) return U.findDoi(d);
    const canon = contentOf('link[rel="canonical"]');
    d = U.findDoi(canon) || U.findDoi(location.href);
    if (d) return d;
    for (const a of U.qsa(document, 'a[href*="doi.org"], a[href*="/doi/"]').slice(0, 20)) {
      const v = U.findDoi(a.getAttribute('href') || '') || U.findDoi(U.text(a));
      if (v) return v;
    }
    return '';
  };

  M.date = () => {
    const raw = M.pick(['citation_publication_date', 'citation_online_date', 'citation_date',
      'dc.date', 'dc.date.issued', 'article:published_time', 'prism.publicationDate', 'dc.date.created']);
    if (!raw) {
      const t = U.text(document.body).slice(0, 4000);
      const m = t.match(/\b(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2})\b/);
      if (m) return m[1];
    }
    return raw.replace(/^(\d{4})\/(\d{2})\/(\d{2}).*/, '$1-$2-$3');
  };

  M.keywords = () => {
    const arr = metaAll('citation_keywords').concat(metaAll('keywords')).concat(metaAll('dc.subject'));
    let out = arr.map((s) => s.replace(/[;,]\s*$/, ''));
    if (!out.length) {
      for (const el of U.qsa(document, '[class*="keyword"], [id*="keyword"], [data-test*="keyword"]').slice(0, 6)) {
        /* harvesting a/li/span together doubles every keyword, and the outer element keeps
           the separator ("CD4+ T cell differentiation," next to "CD4+ T cell differentiation") */
        out = out.concat(U.qsa(el, 'a, li, span').map(U.text));
      }
    }
    const seen = new Set();
    const clean = [];
    for (const raw of out) {
      const t = U.norm(raw).replace(/^[\s,;]+/, '').replace(/[\s,;]+$/, '');
      if (!t || t.length > 60) continue;
      const k = t.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      clean.push(t);
      if (clean.length >= 20) break;
    }
    return clean;
  };

  M.extract = () => {
    let title = M.pick(FIRST);
    if (!title) title = U.text(U.qs(document, 'h1'));
    if (!title) title = (document.title || '').replace(/\s*[|–—-]\s*[^|–—-]{1,40}$/, '').trim();
    title = title.replace(/\s*[|·]\s*(Nature|Science|Cell|Wiley Online Library|PubMed( Central)?|ACS Publications|Frontiers)\s*$/i, '').trim();

    let subtitle = M.pick(['citation_subtitle', 'dc.title.alternative']);
    /* og:description is a blurb, not a subtitle — it duplicates the abstract/author summary */
    if (!subtitle) {
      const desc = M.pick(['og:description', 'description']);
      if (desc && desc.length <= 140) subtitle = desc;
    }
    if (subtitle && subtitle.trim().length > 140) subtitle = '';
    if (subtitle && subtitle.toLowerCase() === title.toLowerCase()) subtitle = '';

    const journal = M.pick(['citation_journal_title', 'prism.publicationName', 'dc.source', 'og:site_name'])
      .replace(/^dc\.source$/, '').replace(/\s*\d{4}$/, '');
    const type = M.pick(['citation_article_type', 'dc.type', 'prism.aggregationType', 'article:section']);
    /* dc.type on Atypon is the *format* ("Text"), not the article type — it read as
       "Review Article / Text" in the reader header */
    const typeLabel = /^(text|full ?text|html|body)$/i.test(U.norm(type)) ? '' : U.norm(type);
    const volume = M.pick(['citation_volume', 'prism.volume']);
    const pages = [M.pick(['citation_firstpage']), M.pick(['citation_lastpage'])].filter(Boolean).join('–');
    const pdf = M.pick(['citation_pdf_url']) || U.abs((U.qs(document, 'link[type="application/pdf"], a[href$=".pdf"]') || { href: '' }).href || '');
    const publisher = M.pick(['citation_publisher', 'dc.publisher']);

    const authorList = M.authors();
    return {
      title: U.norm(title),
      subtitle: U.norm(subtitle),
      journal: U.norm(journal) || location.hostname.replace(/^www\./, ''),
      publisher: U.norm(publisher),
      articleType: typeLabel || 'Article',
      doi: M.doi(),
      date: M.date(),
      volume, pages,
      pdfUrl: pdf,
      authors: authorList,
      affiliations: M.affiliations(),
      keywords: M.keywords(),
      abstractHtml: M.abstractHtml(),
    };
  };
})();

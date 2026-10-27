/* SchReader — figure discovery. */
(() => {
  const SR = (window.SR = window.SR || {});
  const U = (SR.util = SR.util || {});
  const F = (SR.figures = {});

  const LABEL = /^\s*((?:Extended\s+Data\s+)?(?:Supplementary\s+)?(?:Fig(?:ure)?s?\.?|Table|Scheme|Movie|Video|Box)\s*(\d+[a-z]?))\s*[:.|]?\s*/i;

  const area = (img) => {
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    return w * h;
  };

  /* Front-Matter photos: Frontiers puts each author's Loop avatar inside a <figure>,
     so "has a figure tag" is not enough — reject the avatar itself. */
  const AVATAR_IMG = (img) => {
    const sig = `${img.className} ${(img.parentElement && img.parentElement.className) || ''} ${img.alt || ''}`;
    if (/(^|\s)avatar\b|profile[-_ ]?photo|headshot/i.test(sig)) return true;
    const src = img.currentSrc || img.src || '';
    return /\/images?\/profile\//i.test(src) || /^https?:\/\/loop\./i.test(src);
  };

  const biggestImg = (el) => {
    const imgs = U.qsa(el, 'img').filter((i) => !/sprite|icon|logo|spinner|placeholder|blank/i.test(`${i.className} ${i.id} ${i.alt}`) && !AVATAR_IMG(i));
    if (!imgs.length) return null;
    return imgs.sort((a, b) => area(b) - area(a))[0];
  };

  const pickCaption = (node) => {
    let cap = U.qs(node, 'figcaption') || U.qs(node, '[class*="figcaption" i]') || U.qs(node, '[itemprop="caption"]');
    if (!cap) {
      const sels = ['[class*="caption" i]', '[class*="legend" i]', '[class*="description" i]', '[data-test*="caption" i]'];
      for (const s of sels) { cap = U.qs(node, s); if (cap && U.text(cap).length > 10) break; }
    }
    return cap;
  };

  const stripLabel = (capClone) => {
    const walker = document.createTreeWalker(capClone, NodeFilter.SHOW_TEXT);
    let tn = walker.nextNode();
    let budget = 5;
    while (tn && budget--) {
      const v = tn.nodeValue || '';
      if (!v.trim()) { tn = walker.nextNode(); continue; }
      if (LABEL.test(v)) { tn.nodeValue = v.replace(LABEL, ''); return true; }
      /* the label may be its own element ("<b>Fig. 1</b>") — drop it entirely */
      const el = tn.parentElement;
      if (el && el !== capClone && /^(FIG|B|STRONG|SPAN|I|EM)$/.test(el.tagName) && U.text(el).length < 24 && LABEL.test(U.text(el))) {
        el.remove();
        return true;
      }
      break;
    }
    return false;
  };

  /* a bare "doi:10.1371/…" trailing a caption is navigation, not caption text */
  const DOI_ONLY = /^\s*doi:\s*10\.\d{4,}\S*\s*$/i;
  const dropDoi = (capClone) => {
    for (const n of [...capClone.childNodes]) {
      if (n.nodeType === 3) {
        if (DOI_ONLY.test(n.nodeValue || '')) n.remove();
      } else if (n.nodeType === 1) {
        if (DOI_ONLY.test(U.text(n)) && !U.qs(n, 'img')) { n.remove(); continue; }
        dropDoi(n);
      }
    }
  };

  F.collect = (root) => {
    const out = [];
    const seen = new Set();
    const usedImgs = new Set();

    const add = (label, captionEl, img, host, link) => {
      const src = img ? U.imgSrc(img) : '';
      if (!src) return;
      const key = `${U.dedupeKey(label)}|${src}`;
      if (seen.has(key)) return;
      seen.add(key);
      usedImgs.add(img);
      const id = 'fig-' + U.domId(label || `figure-${out.length + 1}`).replace(/^fig-?/, '') || `fig-${out.length + 1}`;
      /* stamp the container so the body walker can drop the figure in at the right place,
         whatever tag the publisher used (<figure>, div.figure, li.figure …) */
      const box = (captionEl && captionEl.parentElement) || img.closest('figure') || null;
      if (box && box !== document.body) {
        let hostEl = box;
        /* keep the stamp on a node that also contains the image */
        if (!hostEl.contains(img) && box.parentElement) hostEl = box.parentElement;
        if (hostEl.contains(img)) hostEl.setAttribute('data-sr-figure', id);
      }
      let captionHtml = '';
      if (captionEl) {
        const c = captionEl.cloneNode(true);
        for (const b of U.qsa(c, 'button, [class*="tool"], [class*="share"]')) b.remove();
        U.absolutize(c);
        stripLabel(c);
        /* PLOS mobile appends the article DOI to every caption block ("… Procedure.
           doi:10.1371/journal.pone.0317372") — noise, not part of the caption. */
        dropDoi(c);
        /* …and a "More »" link that only exists on the publisher's own page */
        for (const a of U.qsa(c, 'a')) {
          if (/^(more|read more|show more|view more)\s*[»›►→]?$/i.test(U.norm(a.textContent || ''))) a.remove();
        }
        for (const e of U.qsa(c, 'span, b, strong, i, em')) {
          if (!U.text(e) && !U.qs(e, 'img')) e.remove();
        }
        captionHtml = c.innerHTML;
      }
      out.push({
        id: id || `fig-${out.length + 1}`,
        label: label || `Fig. ${out.length + 1}`,
        captionHtml,
        src,
        thumb: src,
        alt: img ? (img.getAttribute('alt') || '').slice(0, 300) : '',
        href: link || '',
        origin: host ? 'inline' : 'loose',
      });
    };

    /* 1) real <figure> elements */
    for (const fig of U.qsa(root, 'figure')) {
      if (U.isJunk(fig)) continue;
      const cap = pickCaption(fig);
      const img = biggestImg(fig);
      if (!img) continue;
      const capText = U.text(cap) || U.text(fig);
      const m = capText.match(LABEL);
      const label = m ? U.norm(m[1]) : '';
      const link = (U.qs(fig, 'a[href]') || {}).href || '';
      /* a <figure> with neither a number nor a real caption is a byline portrait
         (Frontiers puts every author avatar in one), not a figure */
      if (!label && (cap ? U.text(cap) : '').length < 18) continue;
      const iw = img.naturalWidth || img.width || 0;
      const ih = img.naturalHeight || img.height || 0;
      if (iw > 0 && ih > 0 && Math.max(iw, ih) < 120) continue;
      add(label, cap, img, true, link);
    }

    /* 2) images with a caption elsewhere in the same block ("div.figure > img + div.figcaption") */
    for (const img of U.qsa(root, 'img')) {
      if (usedImgs.has(img) || AVATAR_IMG(img)) continue;
      /* lazy images have no natural size yet — only reject the ones we can measure and
         that are small in BOTH dimensions (icons); a wide, short table image is legitimate */
      const iw = img.naturalWidth || img.width || 0;
      const ih = img.naturalHeight || img.height || 0;
      if (iw > 0 && ih > 0 && Math.max(iw, ih) < 150) continue;
      let host = img.closest('div, section, li, td, p, figure');
      let cap = null, label = '';
      for (let i = 0; i < 4 && host; i++) {
        const cand = pickCaption(host);
        /* the label must come from the caption itself, not from the whole block:
           figure wrappers often start with "Download: PNG …" before the caption */
        const labelSrc = cand ? U.text(cand) : U.text(host);
        const m = labelSrc.match(LABEL);
        if (cand && m) { cap = cand; label = U.norm(m[1]); break; }
        if (!cand) {
          for (const h of [host.nextElementSibling]) {
            if (!h) continue;
            const mm = U.text(h).match(LABEL);
            if (mm) { cap = h; label = U.norm(mm[1]); break; }
          }
          if (cap) break;
        }
        host = host.parentElement;
      }
      if (!cap || !label) continue;
      add(label, cap, img, true, '');
    }

    /* The same image often exists twice — in the article body and in a "figures" outline
       sidebar. Dedupe keeps one entry, so stamp EVERY container holding that image;
       otherwise the body copy never gets a figure block and the figure vanishes from the
       text while still being listed in the rail. */
    for (const fig of out) {
      const file = String(fig.src || '').split('?')[0].split('/').pop().toLowerCase();
      if (file.length < 6) continue;
      for (const img of U.qsa(root, 'img')) {
        const src = String(U.imgSrc(img) || '').split('?')[0].toLowerCase();
        if (!src || !src.endsWith(file)) continue;
        const hostEl = img.closest('figure') || img.closest('div, section, li, td, p');
        if (hostEl && hostEl !== document.body) hostEl.setAttribute('data-sr-figure', fig.id);
      }
    }

    /* stable order by numeric label */
    out.sort((a, b) => {
      const na = parseInt((a.label.match(/(\d+)/) || [0, 999])[1], 10);
      const nb = parseInt((b.label.match(/(\d+)/) || [0, 999])[1], 10);
      return na - nb;
    });
    return out;
  };
})();

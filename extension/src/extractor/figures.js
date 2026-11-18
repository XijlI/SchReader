/* SchReader — figure discovery. */
(() => {
  const SR = (window.SR = window.SR || {});
  const U = (SR.util = SR.util || {});
  const F = (SR.figures = {});

  /* The number may carry a panel letter ("Fig. 1a"), but it must not swallow the first letter
     of the next word: on a figures-outline item the text runs "Figure 2View in article" (no
     whitespace between the label and the link), and with the /i flag "2V" used to be a label —
     which both invented a figure and defeated dedupe against the real "Fig. 2". */
  const LABEL = /^\s*((?:Extended\s+Data\s+)?(?:Supplementary\s+)?(?:Fig(?:ure)?s?\.?|Table|Scheme|Movie|Video|Box)\s*(\d{1,3}(?:[a-z](?![A-Za-z0-9]))?)(?![A-Za-z0-9]))\s*[:.|]?\s*/i;

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

  /* Loaders and spacers are not figures. Atypon keeps a spinner.gif under every figure
     thumbnail, and the "image with a caption nearby" pass happily paired it with the real
     caption — Figure 1 showed up twice, once pointing at spinner.gif. */
  const PLACEHOLDER = (img) => /sprite|icon|logo|spinner|placeholder|blank|loading/i
    .test(`${img.className} ${img.id} ${img.alt} ${img.getAttribute('src') || ''}`);

  const biggestImg = (el) => {
    const imgs = U.qsa(el, 'img').filter((i) => !PLACEHOLDER(i) && !AVATAR_IMG(i));
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

  /* Caption blocks inside one figure container that are NOT the primary caption but still
     belong to it. Springer Nature splits a figure in two: <figcaption> holds the one-line
     title ("Fig. 3: …") and the panel description ("a, … b, …") sits in a sibling
     <div data-test="bottom-caption">. The body walker emits the container whole, so whatever
     the caption does not swallow disappears from the reader — the figure ends up with a bold
     title and no legend at all. */
  const CAPTIONISH = [
    'figcaption', '[class*="figcaption" i]', '[itemprop="caption"]',
    '[class*="caption" i]', '[class*="legend" i]', '[class*="description" i]',
    '[data-test*="caption" i]', '[data-test*="description" i]',
  ].join(',');

  const captionExtras = (scope, cap) => {
    if (!scope || U.qsa(scope, 'img, picture').length > 3) return [];
    const base = U.text(cap);
    const cands = U.qsa(scope, CAPTIONISH)
      .filter((el) => el !== cap && !(cap && (cap.contains(el) || el.contains(cap))))
      .filter((el) => !U.qs(el, 'img, picture, table'))
      .filter((el) => {
        const t = U.text(el);
        return t.length > 11 && !(base && base.includes(t));
      });
    /* keep the innermost match only: a wrapper that contains another candidate would add
       the same sentence twice */
    return cands.filter((el) => !cands.some((o) => o !== el && el.contains(o)));
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

    const add = (label, captionEl, img, host, link, scope) => {
      const raw = img ? U.imgSrc(img) : '';
      if (!raw) return;
      /* the article renders the 1200 px copy (crisp on a phone, ~1 MB), the rail keeps the
         publisher's thumbnail, and the lightbox asks for the original only when opened */
      const src = U.imgTier(raw, 'lw1200');
      const big = U.imgTier(raw, 'full');
      const key = `${U.dedupeKey(label)}|${src}`;
      if (seen.has(key)) return;
      seen.add(key);
      usedImgs.add(img);
      const id = 'fig-' + U.domId(label || `figure-${out.length + 1}`).replace(/^fig-?/, '') || `fig-${out.length + 1}`;
      /* stamp the container so the body walker can drop the figure in at the right place,
         whatever tag the publisher used (<figure>, div.figure, li.figure …) */
      const box = scope || (captionEl && captionEl.parentElement) || img.closest('figure') || null;
      if (box && box !== document.body) {
        let hostEl = box;
        /* keep the stamp on a node that also contains the image */
        if (!hostEl.contains(img) && box.parentElement) hostEl = box.parentElement;
        if (hostEl.contains(img)) hostEl.setAttribute('data-sr-figure', id);
      }
      let captionHtml = '';
      const parts = captionEl ? [captionEl].concat(captionExtras(box, captionEl)) : [];
      const cleaned = [];
      for (const part of parts) {
        const c = part.cloneNode(true);
        for (const b of U.qsa(c, 'button, [class*="tool"], [class*="share"]')) b.remove();
        U.absolutize(c);
        /* only the primary caption carries the "Fig. 3:" label — peeling it off a panel
           description would eat the first words of the legend */
        if (part === captionEl) stripLabel(c);
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
        const html = c.innerHTML.trim();
        if (html) cleaned.push(html);
      }
      captionHtml = cleaned.join(' ');
      out.push({
        id: id || `fig-${out.length + 1}`,
        label: label || `Fig. ${out.length + 1}`,
        captionHtml,
        src,
        thumb: raw,
        big: big !== src ? big : '',
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
      add(label, cap, img, true, link, fig);
    }

    /* 2) images with a caption elsewhere in the same block ("div.figure > img + div.figcaption") */
    for (const img of U.qsa(root, 'img')) {
      if (usedImgs.has(img) || AVATAR_IMG(img) || PLACEHOLDER(img)) continue;
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
            /* A sibling that carries its own image is another item in a thumbnail list
               (Frontiers' figures-outline sidebar), not the caption of this one — reading
               its label made every outline entry a duplicate figure under the *next*
               number ("Figure 2V", "Table 1P"). */
            if (U.qs(h, 'img, picture')) continue;
            const mm = U.text(h).match(LABEL);
            if (mm) { cap = h; label = U.norm(mm[1]); break; }
          }
          if (cap) break;
        }
        host = host.parentElement;
      }
      if (!cap || !label) continue;
      /* the scope must hold both the image and the caption, or the extras search would walk
         a stranger's figure */
      add(label, cap, img, true, '', host && host.contains(cap) ? host : (cap.parentElement || host));
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

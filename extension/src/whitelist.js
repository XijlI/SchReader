/* SchReader — which sites the extension is allowed to run on.
   This list is the single source of truth: the options page renders it, the content
   script refuses anything that is not on it, and `.github/scripts/sync_whitelist.py`
   copies it into manifest.json (Chrome needs the domains at install time, where no
   script can help).
   Domains are matched with subdomains, so `wiley.com` also covers
   `onlinelibrary.wiley.com`. */
(() => {
  'use strict';

  const DEFAULT_DOMAINS = [
    // big publishers — full-text platforms
    'sciencedirect.com',
    'cell.com',
    'thelancet.com',
    'springer.com',
    'science.org',
    'wiley.com',
    'tandfonline.com',
    'sagepub.com',
    'oup.com',
    'cambridge.org',
    'acs.org',
    'rsc.org',
    'degruyter.com',
    'karger.com',
    'thieme-connect.com',
    'cochranelibrary.com',
    'bmj.com',
    'nejm.org',
    'jamanetwork.com',
    'annualreviews.org',
    // society / open-access journals
    'pnas.org',
    'plos.org',
    'frontiersin.org',
    'mdpi.com',
    'asm.org',
    'elifesciences.org',
    'peerj.com',
    'f1000research.com',
    'royalsocietypublishing.org',
    'biologists.com',
    'physiology.org',
    'hindawi.com',
    'jstage.jst.go.jp',
    'scielo.br',
    // physics / CS / engineering
    'aps.org',
    'iop.org',
    'aip.org',
    'ieee.org',
    'acm.org',
    // archives and Chinese-language platforms
    'jstor.org',
    'biorxiv.org',
    'medrxiv.org',
    'arxiv.org',
    'europepmc.org',
    'ncbi.nlm.nih.gov',
    'cnki.net',
    'wanfangdata.com.cn',
    'cqvip.com',
  ];

  const STORAGE_KEY = 'sr-sites';   // custom domains the user added, array of strings

  /* "https://onlinelibrary.wiley.com/doi/10.1002/x?y=1" -> "onlinelibrary.wiley.com" */
  const norm = (raw) => String(raw == null ? '' : raw)
    .trim().toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')   // scheme
    .replace(/^[^/@]*@/, '')                  // user:password@
    .split(/[/?#]/)[0]                        // path, query, hash
    .replace(/:\d+$/, '')                     // :port
    .replace(/^\*\./, '')                     // *.example.com
    .replace(/^www\./, '')                    // www is matched by the bare domain
    .replace(/^\.+|\.+$/g, '');

  const isValid = (domain) =>
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(domain);

  /* host is on the list, or is a subdomain of an entry */
  const matches = (host, list) => {
    const h = String(host || '').toLowerCase().replace(/^www\./, '');
    return (list || []).some((d) => h === d || h.endsWith('.' + d));
  };

  /* globalThis: content scripts and the options page see `window`, the
     service worker (importScripts) sees `self` — one assignment works for all. */
  globalThis.SR_SITES = { DEFAULT_DOMAINS, STORAGE_KEY, norm, isValid, matches };
})();

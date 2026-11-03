/* SchReader — publisher adapters.
   These are SELECTOR HINTS ONLY (where the body starts, where the reference list lives,
   what to throw away). All the real work is done by the generic machinery, so a site
   without an adapter still works, and one fix improves every site.
   Selectors are best-effort against publicly known DOM structures; the generic path is
   the fallback whenever a hint misses. */
(() => {
  const SR = (window.SR = window.SR || {});

  SR.adapters = [
    {
      id: 'sciencedirect',
      hosts: [/(^|\.)sciencedirect\.com$/, /(^|\.)cell\.com$/, /(^|\.)thelancet\.com$/, /(^|\.)nejm\.org$/],
      articleRoot: ['#body', 'div#body', 'article#article', 'div.Body'],
      refItem: '#references .reference, .references .reference, div.reference, .bib-reference',
      junk: ['#related-articles', '.related-content', '.article-tools', '#citing-articles',
        '#recommended-articles', '.publication-cover', '#footer', '.js-article-actions'],
    },
    {
      id: 'wiley',
      hosts: [/(^|\.)wiley\.com$/],
      articleRoot: ['section.article-section__full', 'div.article-section__full', 'div.doi-fulltext', 'article'],
      refItem: '.article-section__full-refs li, li.article-reference, .article-references li, .ref-list li',
      junk: ['.article-actions', '.article-tools', '.coolBar', '.publication-history',
        '#journal-banner', '.article-table-of-contents'],
    },
    {
      id: 'acs',
      hosts: [/(^|\.)pubs\.acs\.org$/],
      articleRoot: ['#articleBody', 'div.articleBody', 'article', '#abstractBox'],
      refItem: 'ul.pubs-rc-list li, ol.pubs-rc-list li, .references li, li.reference',
      junk: ['.articleMetrics', '#citationMetrics', '.recommended-articles', '.article-tools'],
    },
    {
      id: 'ieee',
      hosts: [/(^|\.)ieeexplore\.ieee\.org$/],
      articleRoot: ['div.document-main', 'div#article', 'div.article', 'div.document'],
      refItem: '.reference-container li, .document-reference, ul.reference-list li',
      junk: ['.document-tools', '.stats', '.metrics', '.document-actions'],
    },
    {
      id: 'oup',
      hosts: [/(^|\.)academic\.oup\.com$/],
      articleRoot: ['section.article-body', 'div.article-body', 'div.widget-items', 'article'],
      refItem: '.js-reference-list li, .ref-list li, ol.references li, .al-article-references li',
    },
    {
      id: 'tandf',
      hosts: [/(^|\.)tandfonline\.com$/],
      articleRoot: ['.hlFld-Fulltext', 'div#fulltext', 'article', '#abstract'],
      refItem: '.references li, .ref-link-list li, .citation-list li',
      junk: ['.metrics', '.recommendations', '.article-tools'],
    },
    {
      id: 'sage',
      hosts: [/(^|\.)sagepub\.com$/],
      articleRoot: ['#fulltext', 'div.fulltext', 'article', '#abstract'],
      refItem: '.ref-list li, ol.references li, .references li',
    },
    {
      id: 'cambridge',
      hosts: [/(^|\.)cambridge\.org$/],
      articleRoot: ['#fulltext', 'div#article-body', '.article-body', 'article'],
      refItem: '.references li, .citation-list li, .ref-list li',
    },
    {
      id: 'aps',
      hosts: [/(^|\.)aps\.org$/],
      articleRoot: ['section#article', 'div#article-body', 'article'],
      refItem: '.references li, ol.references li, .article-ref-list li',
    },
    {
      id: 'iop',
      hosts: [/(^|\.)iopscience\.iop\.org$/],
      articleRoot: ['article', 'div.article-text', '#article-text'],
      refItem: '.references li, ol.references li',
    },
    {
      id: 'arxiv',
      hosts: [/(^|\.)arxiv\.org$/],
      articleRoot: ['div.ltx_page_content', 'div.ltx_document', 'article'],
      refItem: '.ltx_bibitem, li.ltx_bibitem, .ltx_bibliography li',
    },
    {
      id: 'biorxiv',
      hosts: [/(^|\.)biorxiv\.org$/, /(^|\.)medrxiv\.org$/],
      articleRoot: ['div.article', 'div#content-block', 'article', '.article__body'],
      refItem: '.ref-list li, ol.references li, .references li',
    },
    {
      id: 'plos',
      hosts: [/(^|\.)plos\.org$/],
      articleRoot: ['#artText', 'div.article-text', 'article'],
      refItem: 'ol.references > li, .references > li',
      junk: ['.figure-inline-download', '.article-metrics', '.recommended', '.tabs-pane-comments'],
    },
    {
      id: 'frontiers',
      hosts: [/(^|\.)frontiersin\.org$/],
      /* the 2025 template dropped div.JournalFullText: the body is div.ArticleContent (abstract,
         s1…s4, Statements, References, the Summary footer). Without pinning it the scorer reached
         div#__nuxt — the whole Nuxt app — and the site's subject taxonomy rendered as the lead
         section while the "ORIGINAL RESEARCH article" masthead became a section of its own. */
      articleRoot: ['div.ArticleContent', 'div.JournalFullText', 'div.article-section', 'article'],
      refItem: '.references li, div.References div, .References li',
    },
    {
      id: 'mdpi',
      hosts: [/(^|\.)mdpi\.com$/],
      articleRoot: ['div.html-body', 'article.html-body', 'article'],
      refItem: 'ol.references li, div.references li, .html-references li',
      junk: ['.artrelated', '.html-cite', '.metrics'],
    },
    {
      id: 'pmc',
      hosts: [/(^|\.)ncbi\.nlm\.nih\.gov$/, /(^|\.)europepmc\.org$/],
      articleRoot: ['section.body', 'div.article', '#main-content', 'main'],
      refItem: '.ref-list li, section.ref-list li, ol.references li',
    },
    {
      id: 'springer',
      hosts: [/(^|\.)link\.springer\.com$/],
      articleRoot: ['div.c-article-body', 'article', 'section[data-title]'],
      refItem: '.c-article-references__item, ol.c-article-references li',
    },
    {
      id: 'pnas',
      hosts: [/(^|\.)pnas\.org$/],
      articleRoot: ['div.article__body', 'section.article__body', 'article', 'div.core-container', 'div#body', 'main'],
      refItem: 'ol.references li, .references li, .ref-list li, section.references li',
      junk: ['.article-metrics', '.related-articles', '.core-related', '.social-share',
        '.article-tools', '.advertisement', '.signup-promo'],
    },
    {
      id: 'science',
      hosts: [/(^|\.)science\.org$/],
      articleRoot: ['#bodymatter', 'div#article-body', 'article'],
      refItem: 'ol.references li, .references li, #references li',
    },
    {
      id: 'aip',
      hosts: [/(^|\.)pubs\.aip\.org$/],
      articleRoot: ['div.article__body', 'section.article__body', 'article'],
      refItem: '.references li, ol.references li',
    },
    {
      id: 'royalsoc',
      hosts: [/(^|\.)royalsocietypublishing\.org$/],
      articleRoot: ['div.article-body', 'section.article-body', 'article'],
      refItem: '.references li, ol.references li',
    },
    {
      id: 'annurev',
      hosts: [/(^|\.)annualreviews\.org$/],
      /* Atypon/Literatum. The article proper (front matter, body, back matter) lives in
         #html-body; the Abstract / Metrics / References / Cited tabs next to it are hidden
         copies of the same content, so they must stay outside the root — walking them made
         reviveCollapsed pull 16 hidden tab panes back in as duplicate sections. */
      articleRoot: ['#html-body', 'div.itemFullTextHtml', '#itemFullTextId', 'article'],
      refItem: 'span.references li, ol#articlereference > li, .references li',
      /* the section title is a <div class="tl-main-part title"> inside <div class="sectionDivider">,
         and subheadings are <p|span class="tl-lowest-section"> — no <h2>/<h3> anywhere, so the
         walker saw the whole paper as one anonymous section */
      headings: 'div.sectionDivider .tl-main-part.title, div.sectionDivider .tl-main-part',
      subheadings: '.tl-lowest-section',
      /* "Go to section…" dropdown, its caret button and the PowerPoint download form are
         chrome; the dropdown is only 451 chars and would be "revived" as a collapsed section,
         dumping the table of contents into the body as a list */
      junk: ['div.dropDownMenu', '.sectionDivider .menuButton', 'form.pptDwnld'],
    },
    {
      id: 'pubmed',
      hosts: [/(^|\.)pubmed\.ncbi\.nlm\.nih\.gov$/],
      articleRoot: ['div.abstract-content', 'div#abstract', 'main'],
      refItem: '',
    },
  ];
})();

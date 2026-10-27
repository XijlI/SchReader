# SchReader — publisher page → Nature-like reader

## Goal
A Chrome (MV3) extension that re-renders any publisher's article page into a Nature-like layout
reading page: article column + sticky right rail with **Sections / Figures / References**
tabs, hover-preview + jump for inline citations, figure lightbox, reading progress.

Decisions locked with the user:
- Delivery: **unpacked Chrome extension** (no web store, works offline, loads in Edge too).
- Fidelity: **structure + interaction only** — the visual design is ours, not a pixel clone.
- Storage: the article model stays session-only; only the user's own library entries (metadata +
  link, tags, note, reading position), reading history and highlights are persisted locally.
- Nature family (`nature.com` & subdomains) is **skipped** — it already looks like that.
- Target publishers: all of them. Nature excluded; everything else best-effort with adapters.

## Architecture
```
publisher tab  ──content script──►  extract()  ──►  article model (JSON)
                                                      │ chrome.runtime.sendMessage
                                              background SW → chrome.storage.session
                                                      │
                                    reader.html?id=<key>, which replaces the article's tab
```
- No network fetching, no scraping service: the page is already rendered and logged in,
  so paywalls / Cloudflare / institutional access are non-issues.
- Reader is an extension page → its own CSP + zero publisher CSS bleed.

## Extractor layers
1. `meta.js` — Highwire `citation_*` / `dc.*` / `og:*` metas (near-universal across
   Elsevier, Wiley, ACS, T&F, Sage, OUP, MDPI, PLOS, Frontiers, Springer).
2. `adapters.js` — per-publisher **selector hints only** (article root, reference list,
   junk nodes). No forked rendering logic, so one bug fix helps every site.
3. `generic.js` — heuristics: body-block scoring, section splitting on `h2/h3`,
   reference list discovery, figure discovery, inline-citation linking.

If an adapter misses, the generic path still runs; the model records `warnings[]` so the
built-in diagnostics panel can tell the user (and me) what was weak.

## Model
```
{ source:{url,host,publisher,journal,doi,pdfUrl},
  meta:{title,subtitle,kicker,authors[],affiliations[],date,volume,pages,keywords[]},
  abstractHtml, sections:[{id,title,level,blocks:[{t:'p'|'h'|'figure'|'table'|'list'|'quote',html,fid?}]}],
  figures:[{id,label,captionHtml,src,thumb,alt,href}],
  references:[{n,id,html,text,doi,url,citedAt:[chapterId]}],
  supplementary:[{label,href}],
  warnings:[] }
```

## Reader UX (the part the user actually cares about)
- Right rail, 3 tabs, scroll-spy active section, sticky, own scroll pane.
- Inline `ref-chip` superscript: hover → floating citation card (full text + DOI);
  click → rail switches to References, scrolls to and pins that item — **page does not move**.
- Reference item shows `↑N` back-references → jump to first citation in the text.
- Figures tab: thumbnails + truncated captions → click scrolls the article to the figure
  and flashes it. Inline `Fig. 1` mentions in the text are clickable too.
- Lightbox: wheel zoom, drag pan, ←/→ across figures, Esc close, "open original" link.
- Top progress bar; A-/A+; light / sepia / dark; rail collapses under 1100px.
- Keyboard: `j`/`k` next/prev section, `f`/`r`/`s` tabs, `t` theme, `Esc` close.

## Verification
- `dev/` harness serves the repo over http; the saved Nature HTML is used as a
  well-structured fixture and the **generic** path is exercised on it (adapters disabled),
  so the fallback is what gets tested.
- A synthetic Elsevier-shaped fixture (clearly test data) exercises a different DOM shape.
- Screenshots at 1440 and 1100 for user approval before install.

## Library (v2)

Saved papers are metadata + the publisher link — the article body is re-parsed on open, so the store
stays small and nothing copyrighted is kept. `extension/library-store.js` is the single store for
all hosts (`chrome.storage.local` in the extension, the `SchReader` bridge into `Library.kt` on
Android, `localStorage` in the dev harness); `library.html` is the one UI both hosts render.

- ☆ in the reader saves/removes the current paper; ▤ opens the library page.
- Search / sort / tag filters; tags and a note per entry; "Resume" from the stored position.
- History is recorded on open and can be switched off.
- Export BibTeX / RIS / CSV / JSON; import BibTeX or a JSON backup.

## Non-goals
No PDF parsing, no AI summarisation, no auto-translation, no full-text snapshots.

## Install (user, 3 clicks)
`chrome://extensions` → Developer mode → Load unpacked → select `extension/`.

## Site whitelist

The extension runs only on the publisher domains listed in `extension/src/whitelist.js`. Chrome
needs that list at install time, where no script can reach it, so `.github/scripts/sync_whitelist.py`
copies it into `manifest.json` (`content_scripts.matches` and `host_permissions`); CI fails when the
two drift (`--check`).

- A domain the user adds on the options page first goes through `chrome.permissions.request`, so
  Chrome itself asks for the permission. Only after a grant does the service worker call
  `chrome.scripting.registerContentScripts` for that origin; removing the site unregisters it and
  drops the permission.
- `src/content.js` re-checks the host against the stored list before it builds any UI, so the guard
  holds even if a stale dynamic registration survives an extension update.
- The toolbar icon always opens My library (the reading view is started from the in-page pill).
  "Add a publisher" lives in the settings panel (`settings.js`, mounted as a modal from the library
  and as the app's Settings tab): the pill's *allowed sites…* entry opens it with `&add=<host>`
  prefilled, and the request/registration path is unchanged.
- The in-page list intentionally stays broad (47 domains, subdomain-matched): a paper page that is
  not reflowed is an annoyance, an extension that is injected into a bank page is not.

## Verified layouts

| Site | Citation style | How it was checked | Result |
|---|---|---|---|
| Nature (archived page) | Numeric | Real archived page | 65 sections / 110 paragraphs / 5 figures / 87 refs |
| PLOS (journals.plos.org) | Numeric | Live capture | 25 sections / 40 paragraphs / 7 figures / 48 refs |
| PNAS (pnas.org) | Numeric | Real archived page | 16 sections / 28 paragraphs / 4 figures / 43 refs / 64 citations |
| Wiley Online Library | Author–year | Real archived page | 13 sections / 44 paragraphs / 3 figures / 68 refs / 86 citations |
| ScienceDirect | Author–year | Real archived page | 19 sections / 51 paragraphs / 10 figures / 64 refs / 87 citations |
| Cell (cell.com) | Numeric | Real archived page | 20 sections / 55 paragraphs / 3 figures / 79 refs / 127 citations |
| Frontiers (frontiersin.org) | Numeric | Live capture | 28 sections / 64 paragraphs / 4 figures / 51 refs / 80 citations |
| Generic Elsevier layout | Numeric | Hand-written fixture (`dev/fixtures/`) | 7 sections / 9 paragraphs / 2 figures / 5 refs |
| Author–year layout | Author–year | Hand-written fixture (`dev/fixtures/`) | 5 sections / 7 paragraphs / 2 figures / 4 refs |

PNAS and Wiley answer automated fetches with a Cloudflare challenge page, so those runs used pages
saved with Ctrl+S. The saved pages live in `samples/`, which is gitignored; the hand-written
fixtures stay in `dev/fixtures/` because they are committed test data.

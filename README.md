**English** · [中文](README.zh-CN.md)

# SchReader

Read any publisher's paper page in a Nature-like layout: one text column, a fixed
**Sections / Figures / References** rail on the right, citation previews on hover, and a figure
lightbox.

Nothing is downloaded and no article text is saved: the reader re-renders the tab you already have
open, out of your own login session — so paywalls, Cloudflare and institutional access are not a
problem. What *is* kept, in local browser storage, is a **library entry** (title, authors, journal,
DOI, link, your tags/note, reading position) and a short reading history, so a paper can be found
again later. Both are yours, on your machine, and removable from the library page.

Two builds, one codebase: the desktop Chrome/Edge extension in `extension/`, and an Android app in
`android/` that uses the same parsers and the same reader page. On the phone the app opens on
**My library** with three tabs at the bottom — *Library*, *Search* (a shelf of journal home pages,
Google Scholar first, plus any you add) and *Settings*; the bar slides away while you scroll, and the
whole shell wears the same theme as the page (including the reader's custom colours). The browser has
real tabs (up to 8, restored after a restart), and tapping *Search* again returns you to the page you
opened from it before it goes back to the shelf.

---

## Install (once, ~30 seconds)

1. Open `chrome://extensions` (Edge: `edge://extensions`) and switch on **Developer mode**
2. Click **Load unpacked** and pick this repo's `extension` folder
3. Pin the puzzle-piece icon to the toolbar

A click-by-click walkthrough for people who don't write code: [docs/INSTALL.md](docs/INSTALL.md).
Prefer a ready-made download? The [latest release](https://github.com/303035/SchReader/releases/latest)
carries the extension zip and the APK.

## Use it

1. Click the toolbar icon: **My library** opens in its own tab (the same tab comes back every time)
2. Open a paper and let the body text finish loading
3. Click the dark pill in the bottom-right corner: **N SchReader**
4. The reader takes over that tab; "Original ↗" walks back to the publisher page.
   Ctrl/Cmd-click or middle-click the pill if you would rather keep the original page open

The **▾** beside the pill holds *convert this site automatically*, *hide the button here* and
*allowed sites…* (which opens settings with that domain already typed in).

## My library

Both builds open here. **☆** in the reader's top bar keeps a paper; **▤** opens the library from the
reader. The page holds

- search over title / author / DOI / tag, sort by added / last read / title / year
- tags and a free-text note per paper, saved reading position ("Resume" appears next time)
- reading history with a one-click off switch
- export as **BibTeX, RIS, CSV or JSON** (drop straight into Zotero / EndNote / NoteExpress) and
  import back from BibTeX or a JSON backup
- **⚙ Settings** (the app has it as its own tab): theme, reading typeface and size, the allowed-site
  list and the version, in one panel
- **sync across devices**: the same library, reading positions and highlights on the browser and the
  phone, carried by a private gist of your own — see [docs/INSTALL.md §6](docs/INSTALL.md)

"A paper" is metadata plus the link — the article body is re-parsed from the publisher page when you
open it, which is why the store stays tiny. The Android app uses the same page and the same data
shape.

## Which sites it runs on

SchReader only runs on the publishers it knows about — ScienceDirect, Wiley, Springer, Cell,
Science, PNAS, PLOS, Frontiers, MDPI, IEEE, ACM, JSTOR, bioRxiv, CNKI and three dozen more. The list lives
in [extension/src/whitelist.js](extension/src/whitelist.js); every other site is left untouched.

<details>
<summary><b>Verified publishers</b> — the six I have actually run the parser against</summary>

| Publisher | Citation style | Checked against | Sections / paragraphs / figures / refs |
|---|---|---|---|
| ScienceDirect | Author–year | Real saved page | 19 / 51 / 10 / 64 |
| Wiley Online Library | Author–year | Real saved page | 13 / 44 / 3 / 68 |
| Cell (cell.com) | Numeric | Real saved page | 20 / 55 / 3 / 79 |
| PNAS (pnas.org) | Numeric | Real saved page | 16 / 28 / 4 / 43 |
| PLOS (journals.plos.org) | Numeric | Live page | 25 / 40 / 7 / 48 |
| Frontiers (frontiersin.org) | Numeric | Live page | 28 / 64 / 4 / 51 |

Everything else on the list goes through the generic path (`citation_*` meta tags + heuristics)
and is best-effort; the `⋯` panel in the reader shows what was actually found there. Two hand-written
fixtures (a generic Elsevier layout and an author–year layout) cover that fallback path.

nature.com is deliberately *not* on the list: it already looks like this.

</details>

Hit a publisher that isn't on it? Open the reader's **▾ → allowed sites…** (or My library → **⚙ →
Allowed sites**): the domain arrives pre-filled, **Allow site** asks Chrome for permission, and the
pill appears there from then on. **Extension options** in `chrome://extensions` opens the same panel.

## In the reader

| Action | Effect |
|---|---|
| Hover a superscript citation | Full reference card plus a DOI link |
| Click a citation | The rail switches to References and pins it; the text doesn't scroll |
| `↑ cited 3×` on a reference | Jump back to where the text cites it |
| Click a figure, or Expand | Lightbox: wheel to zoom 25–600%, drag to pan, ← → to switch figures |
| Select text, click the pen | Highlight in the current colour (right-click the pen for 6 colours) |
| `J` / `K`, `S` / `F` / `R`, `T`, `Z`, `Esc` | Next section, tabs, theme, collapse rail, close |
| `Aa` | Theme, typeface, custom colours, text size, line height, column width |
| `⋯` | Parse diagnostics: paragraphs, figures and references found |

There are 17 themes and 7 fonts (Inter and IBM Plex Sans ship with the extension, so they work
offline). Highlights are stored per article in `chrome.storage.local`, keyed by DOI.

## Documentation

| Doc | What's in it |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | Click-by-click install and a reader tour, for non-programmers |
| [android/README.md](android/README.md) | The phone build: install, build, what gets mirrored |
| [docs/PLAN.md](docs/PLAN.md) | Architecture, the article model, the whitelist, verified layouts |
| [docs/RELEASING.md](docs/RELEASING.md) | How a release (signed APK + extension zip) is cut |

## Working on it

```
extension/            the folder you load into the browser
  src/whitelist.js    the allowed-site list and the matching rules
  src/content.js      page detection, the pill, triggers parsing
  src/background.js   parks the parse result in memory, opens the reader/library, registers
                      content scripts for sites you added
  src/extractor/      page to article model (meta, blocks, refs, figures, adapters)
  library.*           My library (list, tags, notes, export, history)
  search.*            the Search shelf (journal shortcuts + your own sites)
  settings.js         the settings panel: extension modal + app page, one implementation
  library-store.js    the only store, on all three hosts
  options.html        forwards to library.html?settings=1 (Chrome's "Extension options")
dev/                  local harness: static server + POST /save
samples/              pages saved with Ctrl+S, used as parser fixtures (gitignored)
```

```bash
python3 dev/serve.py 8799
# then http://127.0.0.1:8799/extension/reader.html?dev=article.json

python3 .github/scripts/sync_whitelist.py --check   # manifest.json and whitelist.js in sync
```

## Limitations

- It reads only the text that is already on the page. A PDF-only or iframe-only article gives you
  the abstract and nothing more.
- A publisher redesign can break a selector; `⋯` in the reader shows which counter dropped to 0.
- Images load from the publisher's CDN. A few sites refuse cross-site requests and show a text note
  instead.

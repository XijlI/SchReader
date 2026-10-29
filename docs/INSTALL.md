**English** · [中文](INSTALL.zh-CN.md)

# Install and usage guide (for people who don't write code)

SchReader is a Chrome extension: it turns a paper page into something laid out like a Nature-family
article.
**No sign-up, no downloads over the network, nothing saved.**
(Syncing between devices is optional and needs a free GitHub token — see §6.)

---

## 1. Install it once (about 30 seconds)

1. Open Chrome and type this into the address bar, then press Enter:

   ```
   chrome://extensions
   ```

   > On Edge, type `edge://extensions`

2. Look at the **top-right corner** of the page and flip the **"Developer mode"** switch on.
   A row of extra buttons appears at the top of the page.

3. Click **"Load unpacked"** — it's on the left side, in that new row — and in the folder picker
   that opens, find this project's **`extension`** folder, select it, and click "Select folder".

   > That's the `extension` folder one level up from this file (this doc lives in `docs/`); it
   > contains `manifest.json` directly. Select the folder itself, not a file inside it.

4. Done. A card named **SchReader — paper reflow reader** appears on that same page.
   Click the puzzle-piece icon in the browser's top-right corner and light up the **pin** next to
   SchReader, and the icon stays in your toolbar.

**If you picked the wrong folder in step 3**: delete the card and start over (there's a "Remove"
button in the card's bottom-right corner). If the error message mentions "manifest", you almost
certainly selected the parent directory.

> **In a hurry, or on another computer?** Every release publishes
> `schreader-chrome-vX.Y.Z.zip` on the
> [Releases page](https://github.com/XijlI/SchReader/releases/latest). Download it,
> unzip it anywhere, and in step 3 pick that unzipped folder instead of the `extension` folder.
> Everything else stays the same.

---

## 2. How to use it

1. Open a paper as usual (ScienceDirect, Wiley, ACS, Springer, PLOS… any of them) and wait for the
   body text to show up.
2. A small dark pill appears in the page's **bottom-right corner**:

   ```
   [S  SchReader  ▾]
   ```

   Click it → the reflowed reading layout opens in a **new tab**. The original page is untouched,
   so you can switch back and compare whenever you like.

3. Can't find the pill?
   - On some pages the body hasn't finished loading yet — give it a second or scroll down a bit
   - If the site is not on the allowed list, no pill appears at all — see section 3
   - The **SchReader icon** in the toolbar does not convert the page: it opens your library

4. Want this site to convert automatically from now on: click the **▾** to the right of the pill →
   tick **This site: convert automatically**.

> nature.com doesn't show the pill, because it already looks like this.

---

## 3. Which sites it works on

SchReader only runs on the publisher sites on its allowed list — ScienceDirect, Wiley, Springer,
Cell, PNAS, PLOS, Frontiers, MDPI and a few dozen more. Every other site is left alone, which is
also why it never sees the rest of your browsing.

- **A paper site that isn't on the list** (no pill appears): open the **▾** menu beside the pill on
  any other paper → **allowed sites…**. Settings opens with that domain already filled in — click
  **Allow site**, confirm the permission Chrome asks for, reload the page, and the pill is there.
- **See or edit the list**: the toolbar icon opens your library; the **⚙** button there opens
  settings → **Allowed sites** (whitelisted publishers as chips, your own sites with a Remove
  button). `chrome://extensions` → SchReader → **Details** → **Extension options** lands in the
  same panel.
- What you add is an ordinary Chrome permission, so you can take it back the same way; a removed
  site is not read at all.

---

## 4. How to use the reader page

Three tabs in the right sidebar — the navigation you like:

- **Sections** — the section list; the current section highlights as you scroll, click one to jump
- **Figures** — figure thumbnails; click one to jump to that figure in the text
- **Refs** — every reference; click one to pin it for reading

The middle of the top bar shows the **article title** (truncated if it's long — hover to see it all);
the line under it is the journal name and domain.

Superscript numbers in the body (like `12`):

- **Hover** → the full info for that reference pops up, plus a DOI link
- **Click** → the right panel switches to Refs and highlights that entry, **the text doesn't
  scroll**, so you stay exactly where you were reading

The **↑ cited 3×** under a reference entry → click it to jump back to where the text cites it, with
a flash.

Everything else:

| What you want to do | How |
|---|---|
| Look at a figure / zoom | Click the figure itself, or "Expand" on it; wheel to zoom (**25%–600%**, 100% = the whole figure fits the window); drag to pan when zoomed; ← → to change figures, Esc to close |
| Change theme / font / font size | **Aa** in the top bar — everything is in there (you can also pick your own background and text colors) |
| Highlight text | Select the text → click the **pen** in the top-right; yellow by default |
| Use a different highlight color | **Right-click** the pen and pick a color (yellow / green / blue / pink / purple / orange) |
| Change an existing highlight | **Right-click** the highlight → recolor, or ✕ to delete |
| Next / previous section | `J` / `K` |
| Collapse the sidebar | `Z`, or **☰** in the top bar (on narrow windows the sidebar becomes a drawer) |
| See how parsing went | **⋯** in the top bar — shows how many paragraphs, figures, references, and highlights were extracted |

---

## 5. Updating after the code changes

Go back to `chrome://extensions`, click the **↻** (reload) button on the SchReader card, then
reload the paper page and click the pill again. No need to uninstall and reinstall.

---

## 6. Syncing across devices (browser + phone)

Your library, reading positions and highlights can follow you between the browser and the phone.
Small JSON file, private GitHub gist: titles, links, tags, notes, positions — never the article text.

Set it up once, **on every device**:

1. Sign in to GitHub and open
   <https://github.com/settings/tokens/new?scopes=gist&description=SchReader%20sync>.
2. Tick **gist** and nothing else, scroll down, click **Generate token**.
3. Copy the token — GitHub shows it once. It starts with `ghp_` (classic) or `github_pat_`.
4. In SchReader: **⚙ Settings → Sync**, paste the token, press **Connect**.
5. On the phone (and any other computer) repeat 1–4 with the *same* token — the second device finds
   the same gist by itself, no copy-pasting of ids.

After that: each device pushes a few seconds after you change something and pulls when you open the
library. Two devices editing different things keep both edits; a paper deleted on one disappears from
the other. The token is stored only on that device, and **Disconnect** stops that device without
touching the gist or the other devices.

If something goes wrong the Sync line says so ("GitHub rejected the token (401)…", "Network error…")
instead of failing silently — paste that message back to me.

---

## 7. When a particular site doesn't work

First click **⋯** in the reader's top bar and read the diagnostics:

- **references is 0** → this site writes its references in a form I don't recognize
- **figures is 0** → the figures are probably lazy-loaded; scroll to the bottom of the page first,
  then click the pill
- **sections is 0** → the body text is probably inside a PDF or a reader, and only the abstract is
  reachable

Send me these two things and I'll add an adapter: **① the URL of that page; ② a screenshot of the
diagnostics panel**.

---

## 8. Uninstall

`chrome://extensions` → the SchReader card → **Remove**.
It leaves nothing behind on your computer.

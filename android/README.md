**English** · [中文](README.zh-CN.md)

# SchReader for Android

The same "paper page → Nature-like reading layout" idea, on a phone. Mobile browsers can't install
Chrome extensions, so this is a native Android app: a WebView does duty as the browser, and there's
a floating button in the bottom-right that reflows the current paper using **the same parsers and
the same reader page** (the code in `extension/`).

```
Open the app
 └─ lands on My library, with a bottom bar: Library · Search · Settings
     ├─ Library   saved papers, tags, notes, export/import, reading history (the same page the extension uses)
     ├─ Search    Google Scholar + Nature / Science / Cell by default, "+ Site" adds any journal you use
     │            the search box sends a query to Scholar; a bare address opens directly
     └─ Settings  theme, reading typeface and size, reading-history switch, version
     └─ tap a shelf entry or a library item → the browser view
          ├─ address bar in the top bar: type a URL or a query (anything without a dot is a Scholar search)
          ├─ school/institutional logins go through the normal web flow and the session sticks (persistent cookies)
          └─ tap into a paper page → floating button "N Reader" bottom-right
               └─ parse → the app's built-in reader page (17 themes / highlighting / lightbox / three-tab rail)
                   └─ "Original ↗" in the top bar → back to the publisher page
The bottom bar slides away as you scroll down and comes back when you scroll up; Back returns
Settings/Search → Library, Library → the article you came from, and then exits.
```

## Install

Easiest: grab `schreader-android-vX.Y.Z.apk` from the
[Releases page](https://github.com/303035/SchReader/releases/latest) and skip to step 1
below — it's signed with the release key, so it installs over an older copy.
Download the APK on a PC and copy it to the phone, or open the releases page on the phone itself.

The first release-signed APK (v0.1.0) needs one uninstall of any older debug build, because that one
carries the local debug key.

To build it yourself, the APK lands at `android/app/build/outputs/apk/debug/app-debug.apk`.

1. Get the APK onto the phone (`adb push ... /sdcard/Download/`, or just copy the file over)
2. File manager → Downloads → tap the APK to install (allow "unknown sources")
3. If you install straight over adb, Meizu phones need **Settings → System → Developer options →
   USB installation** enabled first, otherwise you get `INSTALL_FAILED_USER_RESTRICTED`. Once it's
   on:
   ```
   adb install -r -g app-debug.apk
   ```

## Usage

| Action | Effect |
|---|---|
| ‹ / › | Back / forward (the arrow dims when there's nothing to go back to) |
| Type in the address bar | A URL opens directly; anything without a dot becomes a Scholar search; **one tap selects the whole URL** (type a character and it replaces everything) |
| ⟳ | Reload |
| **Long-press ⟳** | Toggle between "mobile / desktop" mode (the arrow turns gold = you're in desktop mode now) |
| **100% on the right of the address bar** | Page zoom: tap to open `− 100% + Reset`, steps at 75/85/100/115/130/150/175/200%; the number turns gold when it isn't 100%, and the choice is remembered (applies to publisher pages only; in the reader page use `Aa` in the top bar for font size) |
| ☆ | Bookmark the current page (stores only the URL + title, never the body) |
| Bottom bar | Library / Search / Settings — hides while you read, one scroll up brings it back. Tapping *Search* when a page is open returns to that page; the next tap goes to the shelf |
| Tab counter (top right) | How many tabs are open — tap for the tab list (switch, close, `+ New`); up to 8, restored after a restart. In the reader the same list opens from `❐` in its toolbar |
| Coming back | Leave the reader for Library or another tab and it reopens where you left it — the article, not the publisher page |
| 25%…200% | Page zoom; the `−` / `+` strip opens directly under that button |
| Floating button "N Reader" | Parse the current page and open the reader |
| Back key | Reader → original page → previous page → the library you came from → exit |
| Share a link into the app | Share text from WeChat/mail and the app pulls the URL out of it and opens it |

### About "this site blocked the app's built-in browser"
Some publishers' anti-automation defenses block embedded browsers (Elsevier/ScienceDirect's
`There was a problem providing the content` + `CPE00001`). What testing actually showed:

- On the same phone, on the same IP, **Chrome gets through** — so it isn't the network;
- A desktop UA makes it *worse* — because the UA says Windows while the client hints
  (Sec-CH-UA) still say Android, and a self-contradicting fingerprint is a red flag;
- The real cause is that WebView's default UA leaks the full phone model and OS build
  (`MEIZU 20 Build/TKQ1…`). The app now sends **a trimmed real-Chrome UA**
  (`Android 10; K` + `Chrome/<major>.0.0.0`), and ScienceDirect article pages have been tested
  end to end: they load and reflow.

If some other site still blocks it, the app says plainly that "the built-in browser was blocked"
rather than pretending parsing failed. Open those in Chrome instead (the cost is no reading
layout).

### When the mobile page won't parse
Some publishers serve a completely different structure on mobile (PLOS mobile even tucks the full
text inside collapsed panels). If the body text comes back too short after you tap "Reader", the
app **automatically reloads with a desktop UA and parses once more**. If that still fails,
long-press ⟳ to switch to desktop mode by hand (desktop layouts are cramped on a phone and need
pinch-zoom — treat it as a last resort).

## Rebuilding

```bash
cd android
./build.cmd          # or just double-click build.cmd on Windows
```

`build.cmd` first runs `tools/mirror.py`, which **mirrors** the reader page, `library.*`,
`search.*`, `settings.*`, `library-store.js`, the fonts and the 7 parser files into the app's
assets (these copies are not checked into git), then runs `gradlew.bat assembleDebug`.

**There is only ever one copy of the source**: change the reader page or a parser in `extension/`,
rebuild, and both the Chrome extension and the Android app update together. No drift between two
codebases.

Requirements: JDK 21 + Android SDK 36 (`sdk.dir` in `android/local.properties`).

## Known limitations (no sugar-coating)

- **Sites that put the body text in a separate iframe are out of reach**: WebView's
  `evaluateJavascript` only runs against the main frame, and the extension's `all_frames` trick has
  no equivalent here. The reader page will tell you "too little body text".
- **PDF pages** can't be reflowed; you can only open them in the system PDF viewer.
- Sites whose mobile page structure differs a lot may need a few more adapter passes (already
  verified on desktop: Nature / PLOS / PNAS / Wiley / ScienceDirect / Cell / Frontiers).
- Selecting text to highlight means long-pressing to select words on a phone, and it's been tested
  less than on desktop.
- Figure thumbnails use the publisher's `size=medium`; "100%" in the lightbox is that medium image.
  For the original, tap "Open image ↗" in the lightbox's bottom-right corner.

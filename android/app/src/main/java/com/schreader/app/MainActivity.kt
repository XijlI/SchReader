package com.schreader.app

import android.annotation.SuppressLint
import android.app.Activity
import android.app.DownloadManager
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.URLUtil
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File

private const val TAG = "SchReader"
private const val ASSET_ORIGIN = "https://appassets.androidplatform.net"
private const val READER_URL = "$ASSET_ORIGIN/assets/reader/reader.html"
private const val MODEL_FILE = "last_article.json"

/**
 * One screen, two WebViews:
 *  - `browser` browses Scholar / publisher pages (the user's own session, real cookies).
 *  - `reader`  shows the extension's reader page served out of the APK, with the parsed
 *              article inlined. It never touches the network for its own assets.
 *
 * The floating "Reading view" button is a native view on top of the WebView: publisher CSS and
 * scripts cannot reach it. Tapping it injects the same extractor the Chrome extension uses,
 * collects the article model through a JS bridge in chunks, then opens the reader.
 */
class MainActivity : Activity() {

    private lateinit var browser: WebView
    private lateinit var reader: WebView
    private lateinit var home: WebView
    private lateinit var topBar: View
    private lateinit var progress: ProgressBar
    private lateinit var urlEdit: EditText
    private lateinit var pillHost: View
    private lateinit var pillLabel: TextView
    private lateinit var starBtn: TextView
    private lateinit var zoomBtn: TextView
    private lateinit var zoomPanel: View
    private lateinit var zoomValue: TextView
    private lateinit var forwardBtn: TextView
    private lateinit var navWrap: View
    private lateinit var navLibrary: View
    private lateinit var navSearch: View
    private lateinit var navSettings: View
    private lateinit var tabsBtn: TextView
    private lateinit var tabSheet: View
    private lateinit var tabList: LinearLayout
    private lateinit var tabTitle: TextView
    private lateinit var toastMsg: TextView

    private lateinit var library: Library
    private val handler = Handler(Looper.getMainLooper())
    private val modelBuf = StringBuilder()

    private var busy = false
    private var readerShowing = false
    /** true while one of the home pages (library / search / settings) owns the screen */
    private var homeShowing = false
    /** which home page is on screen, so the bottom bar can mark it */
    private var homeTab = "library"
    /** the bottom bar slides away on scroll; this is where it currently is */
    private var navShown = true
    /** what Back returns to when a home tab was opened on top of a page: "reader" / "browser" */
    private var backTo: String? = null

    /* ---- browser tabs: URL + title + scroll position; one WebView is reused ---- */
    private val tabs = mutableListOf<BrowserTab>()
    private var activeId = 0
    private var nextId = 1
    /** which home section (library / search) the page on screen was opened from */
    private var currentSection: String? = null
    /** the article JSON of every tab that has been read, so returning to it can re-open the reader */
    private val articleByTab = mutableMapOf<Int, String>()
    /** the tab whose article the reader WebView is currently showing (0 = none) */
    private var readerTab = 0
    /** section → the tab it last opened, so tapping that bar item returns to the page */
    private val sectionTab = mutableMapOf<String, Int>()
    /** scroll position to restore after the next page load (-1 = none) */
    private var pendingScroll = -1
    /** the theme as the pages report it; drives the native chrome */
    private var palette = Palette()
    private var articleUrl: String? = null
    private var articleTitle: String = ""
    private var pendingExtract = false
    private var ua: String = ""
    private var desktopUa: String = ""
    /** true while the browsing WebView pretends to be a desktop browser */
    private var desktopMode = false
    /** one automatic desktop-UA retry per page load, never a loop */
    private var retriedDesktop = false
    /** page zoom for publisher pages, in percent; the reader has its own Aa control */
    private var zoom = 100

    private val prefs by lazy { getSharedPreferences("nv", MODE_PRIVATE) }

    private var sayToken = 0

    /**
     * Everything under assets/ is served; reader.html is special-cased so the parsed article
     * can be inlined as `window.__ARTICLE__` (the reader page already reads that variable,
     * which is also what the extension's dev harness uses).
     */
    private val assetLoader: WebViewAssetLoader by lazy {
        val files = WebViewAssetLoader.AssetsPathHandler(this)
        WebViewAssetLoader.Builder()
            .addPathHandler(
                "/assets/",
                object : WebViewAssetLoader.PathHandler {
                    override fun handle(path: String): WebResourceResponse? {
                        Log.i(TAG, "ASSET $path")
                        /* the asset loader hands us the path WITHOUT a leading slash */
                        return if (path.trim('/') == "reader/reader.html") readerHtml() else files.handle(path)
                    }
                },
            )
            .build()
    }

    // ------------------------------------------------------------------ lifecycle

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        library = Library(this)
        bindViews()
        applySystemBarInsets()
        zoom = prefs.getInt("zoom", 100)

        /* Real Chrome on Android has shipped a REDUCED user agent since v110
           ("Android 10; K", "Chrome/<major>.0.0.0"); the WebView default still leaks the exact
           device model and build. Bot rules (Elsevier/Akamai among them) treat the verbose form
           as an embedded client, so mimic what the real browser sends. */
        val raw = WebSettings.getDefaultUserAgent(this)
        val major = Regex("Chrome/(\\d+)").find(raw)?.groupValues?.get(1) ?: "140"
        ua = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/$major.0.0.0 Mobile Safari/537.36"
        /* a plausible desktop Chrome on Windows, derived from this WebView's own version */
        desktopUa = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/$major.0.0.0 Safari/537.36"

        if ((applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            @Suppress("DEPRECATION")
            WebView.setWebContentsDebuggingEnabled(true)
        }

        setupBrowser()
        setupReader()
        setupHome()
        wireChrome()

        /* the chrome wears the palette the pages reported last session, so there is no dark
           flash before the first page paints */
        prefs.getString("palette", null)?.let { applyPalette(it, false) }
        restoreTabs()

        val start = urlFromIntent(intent)
        when {
            start != null -> {
                /* a link shared into the app opens as its own tab */
                pendingExtract = wantsExtract(intent)
                if (tabs.isEmpty()) newTab(start, null)
                openPage(start, null, forceNewTab = true)
            }
            else -> restoreLastScreen()
        }
    }

    /** Cold start: where you were, not always the library. */
    private fun restoreLastScreen() {
        val last = prefs.getString("lastView", "home:library").orEmpty()
        val tab = activeTab()
        when {
            last == "reader" -> {
                reader.loadUrl(READER_URL)
                showReader()
            }
            last.startsWith("home:") -> showHome(last.removePrefix("home:"))
            tab != null && tab.url.isNotBlank() && tab.url != BLANK_URL -> switchTab(tab.id)
            else -> showHome("library")
        }
        if (tabs.isEmpty()) {
            val t = newTab(BLANK_URL, null)
            activeId = t.id
            updateTabChrome()
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val target = urlFromIntent(intent) ?: return
        pendingExtract = wantsExtract(intent)
        if (target == browser.url) {
            if (pendingExtract) { pendingExtract = false; beginExtract() }
        } else {
            showBrowser()
            browser.loadUrl(target)
        }
    }

    override fun onBackPressed() {
        if (!performBack()) super.onBackPressed()
    }

    override fun onPause() {
        super.onPause()
        captureScroll { saveTabs() }
    }

    private fun performBack(): Boolean {
        if (tabSheet.visibility == View.VISIBLE) {
            hideTabSheet()
            return true
        }
        if (zoomPanel.visibility == View.VISIBLE) {
            zoomPanel.visibility = View.GONE
            return true
        }
        /* a hidden bar is a state the user can be in: give them one press to bring it back */
        if (!navShown) {
            showNav()
            return true
        }
        if (homeShowing) {
            if (homeTab != "library") {
                showHome("library")
                return true
            }
            when (backTo) {
                "reader" -> { closeLibraryPage(); return true }
                "browser" -> { showBrowser(); return true }
            }
            return false
        }
        if (readerShowing) {
            showBrowser()
            return true
        }
        if (browser.canGoBack()) {
            browser.goBack()
            return true
        }
        showHome(currentSection ?: "library")
        return true
    }

    // ------------------------------------------------------------------ views

    private fun bindViews() {
        browser = findViewById(R.id.webBrowser)
        reader = findViewById(R.id.webReader)
        home = findViewById(R.id.webHome)
        topBar = findViewById(R.id.topBar)
        progress = findViewById(R.id.progress)
        urlEdit = findViewById(R.id.urlEdit)
        pillHost = findViewById(R.id.pillHost)
        pillLabel = findViewById(R.id.pillLabel)
        starBtn = findViewById(R.id.btnStar)
        zoomBtn = findViewById(R.id.btnZoom)
        zoomPanel = findViewById(R.id.zoomPanel)
        zoomValue = findViewById(R.id.zoomValue)
        forwardBtn = findViewById(R.id.btnForward)
        navWrap = findViewById(R.id.navWrap)
        navLibrary = findViewById(R.id.navLibrary)
        navSearch = findViewById(R.id.navSearch)
        navSettings = findViewById(R.id.navSettings)
        tabsBtn = findViewById(R.id.btnTabs)
        tabSheet = findViewById(R.id.tabSheet)
        tabList = findViewById(R.id.tabList)
        tabTitle = findViewById(R.id.tabTitle)
        toastMsg = findViewById(R.id.toastMsg)
    }

    // ------------------------------------------------------------ system bars
    /**
     * Android 15+ — and targetSdk 36 makes it unconditional — draws the app behind the status and
     * navigation bars. Unhandled, the status bar sits on top of our own top bar (Samsung One UI is
     * where it bites: the clock and battery swallow taps on the address field and ☰) and the
     * gesture bar overlaps the reader pill. Reserve the insets ourselves: the top bar and both
     * WebViews start below the status bar, the pill and the saved-articles list stay clear of the
     * gesture bar.
     */
    private fun applySystemBarInsets() {
        val root = findViewById<View>(R.id.root)
        root.setOnApplyWindowInsetsListener { view, insets ->
            val (left, top, right, bottom) = systemBarInsets(insets)
            /* the keyboard also has to come out of the WebView: edge-to-edge ignored
               android:windowSoftInputMode="adjustResize", so a sheet centred in the page (the
               library's tag/note editor) would otherwise sit behind the keyboard */
            val keyboard = imeInset(insets)
            val gap = maxOf(bottom, keyboard)
            view.setPadding(left, top, right, gap)

            /* the pill floats above the bottom navigation bar (58dp), which overlays the page.
               The XML carries the same 76dp default for hosts where insets arrive as zero. */
            val pillLp = pillHost.layoutParams as ViewGroup.MarginLayoutParams
            pillLp.bottomMargin = dp(76) + gap
            pillHost.layoutParams = pillLp

            insets
        }
        root.requestApplyInsets()
    }

    private fun imeInset(insets: WindowInsets): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) insets.getInsets(WindowInsets.Type.ime()).bottom else 0

    /** status bar + navigation bar + cutout, as left/top/right/bottom pixels. */
    private fun systemBarInsets(insets: WindowInsets): IntArray {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val i = insets.getInsets(
                WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout()
            )
            return intArrayOf(i.left, i.top, i.right, i.bottom)
        }
        @Suppress("DEPRECATION")
        return intArrayOf(
            insets.systemWindowInsetLeft, insets.systemWindowInsetTop,
            insets.systemWindowInsetRight, insets.systemWindowInsetBottom
        )
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun wireChrome() {
        findViewById<View>(R.id.btnBack).setOnClickListener { performBack() }
        findViewById<View>(R.id.btnForward).setOnClickListener { browser.goForward() }
        findViewById<View>(R.id.btnReload).setOnClickListener {
            if (readerShowing) reader.reload() else browser.reload()
        }
        starBtn.setOnClickListener { toggleFavorite() }
        navLibrary.setOnClickListener { onNavTap("library") }
        navSearch.setOnClickListener { onNavTap("search") }
        navSettings.setOnClickListener { onNavTap("settings") }
        tabsBtn.setOnClickListener { if (tabSheet.visibility == View.VISIBLE) hideTabSheet() else showTabSheet() }
        findViewById<View>(R.id.btnNewTab).setOnClickListener {
            hideTabSheet()
            val t = newTab(BLANK_URL, null)
            activeId = t.id
            currentSection = null
            updateTabChrome()
            saveTabs()
            loadBlank()
        }
        findViewById<View>(R.id.btnTabSheetClose).setOnClickListener { hideTabSheet() }
        pillHost.setOnClickListener { beginExtract() }
        /* long-press the reload arrow to force this site into desktop mode (and back) */
        findViewById<View>(R.id.btnReload).setOnLongClickListener {
            setDesktopMode(!desktopMode)
            say(if (desktopMode) "Desktop site: reloading…" else "Mobile site: reloading…")
            browser.reload()
            true
        }
        zoomBtn.setOnClickListener { toggleZoomPanel() }
        findViewById<View>(R.id.zoomIn).setOnClickListener { stepZoom(+1) }
        findViewById<View>(R.id.zoomOut).setOnClickListener { stepZoom(-1) }
        findViewById<View>(R.id.zoomReset).setOnClickListener { applyZoom(100) }

        urlEdit.setOnFocusChangeListener { _, focused ->
            if (focused) {
                /* editing starts from the real URL, not the shortened host. Anchor at the end
                   and cursor at the start: the whole thing is selected AND the field is
                   scrolled to the beginning (cursor at the end would show only the PII tail). */
                urlEdit.setText(browser.url.orEmpty())
                urlEdit.setSelection(urlEdit.text.length, 0)
                urlEdit.post { if (urlEdit.hasFocus()) urlEdit.setSelection(urlEdit.text.length, 0) }
            } else {
                updateChrome()
            }
        }
        /* a tap on an already-focused field must select all again: the touch moves the cursor
           after onFocusChange has run, which would otherwise collapse the selection */
        urlEdit.setOnClickListener { urlEdit.setSelection(urlEdit.text.length, 0) }
        urlEdit.setOnEditorActionListener { v, actionId, event ->
            val go = actionId == EditorInfo.IME_ACTION_GO ||
                (event != null && event.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN)
            if (go) {
                navigate(urlEdit.text.toString())
                true
            } else {
                false
            }
        }
    }

    // ------------------------------------------------------------------ browser

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupBrowser() {
        val s = browser.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.databaseEnabled = true
        s.userAgentString = ua
        s.useWideViewPort = true
        s.loadWithOverviewMode = false
        s.builtInZoomControls = true
        s.displayZoomControls = false
        s.setSupportMultipleWindows(false)
        s.javaScriptCanOpenWindowsAutomatically = false
        s.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        s.mediaPlaybackRequiresUserGesture = true

        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(browser, true)
        }

        browser.addJavascriptInterface(Bridge(), "SchReader")

        browser.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                handleOutgoingUrl(request.url.toString())

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                progress.visibility = View.VISIBLE
                retriedDesktop = false
                zoomPanel.visibility = View.GONE
                showNav()
                if (url != null && url != BLANK_URL) activeTab()?.let { it.url = url }
            }

            override fun onPageFinished(view: WebView, url: String?) {
                progress.visibility = View.GONE
                articleUrl = null
                articleTitle = view.title.orEmpty()
                activeTab()?.let { t ->
                    if (!url.isNullOrBlank() && url != BLANK_URL) t.url = url
                    if (!view.title.isNullOrBlank()) t.title = view.title.orEmpty()
                    updateTabChrome()
                    saveTabs()
                }
                /* switching back to a tab puts you where you were reading */
                if (pendingScroll > 0) {
                    val y = pendingScroll
                    pendingScroll = -1
                    view.postDelayed({
                        view.evaluateJavascript("window.scrollTo(0, $y)", null)
                    }, 120)
                }
                /* twice: some publisher pages re-render after load and drop the inline zoom */
                if (zoom != 100) {
                    syncPageZoom()
                    handler.postDelayed({ if (!readerShowing && zoom != 100) syncPageZoom() }, 700)
                }
                updateChrome()
                if (pendingExtract) {
                    pendingExtract = false
                    beginExtract()
                }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) {
                    progress.visibility = View.GONE
                    say("Could not open this page: ${error.description}")
                    Log.i(TAG, "PAGE_ERROR ${request.url} ${error.errorCode} ${error.description}")
                }
            }
        }

        browser.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                progress.progress = newProgress
                progress.visibility = if (newProgress >= 100) View.GONE else View.VISIBLE
            }

            override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                Log.d("NVConsole", "${msg.message()} (${msg.sourceId()}:${msg.lineNumber()})")
                return true
            }
        }

        browser.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            download(url, userAgent, contentDisposition, mimeType)
        }

        wireAutoHide(browser)
    }

    private fun handleOutgoingUrl(url: String): Boolean {
        return when {
            url.startsWith("http://") || url.startsWith("https://") -> {
                /* desktop mode is a per-page fallback, not a global switch: a link to another
                   host deserves the fast mobile template again */
                if (desktopMode) {
                    val target = runCatching { Uri.parse(url).host.orEmpty() }.getOrDefault("")
                    val current = runCatching { Uri.parse(browser.url.orEmpty()).host.orEmpty() }.getOrDefault("")
                    if (target.isNotEmpty() && current.isNotEmpty() && target != current) setDesktopMode(false)
                }
                false
            }
            url.startsWith("about:") -> false
            url.startsWith("intent:") || url.startsWith("mailto:") ||
                url.startsWith("tel:") || url.startsWith("sms:") -> {
                openExternal(url)
                true
            }
            else -> true
        }
    }

    // ------------------------------------------------------------------ reader

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupReader() {
        val s = reader.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.userAgentString = ua
        s.builtInZoomControls = true
        s.displayZoomControls = false
        s.setSupportMultipleWindows(false)
        s.mediaPlaybackRequiresUserGesture = true
        // local assets only: never serve a stale reader after an update
        s.cacheMode = WebSettings.LOAD_NO_CACHE

        /* the reader page owns the library (☆ save, history, reading position) and needs the
           bridge for storage plus for opening the library page itself */
        reader.addJavascriptInterface(Bridge(), "SchReader")

        reader.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assetLoader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val target = request.url.toString()
                if (target.startsWith(ASSET_ORIGIN)) return false   // in-page anchors
                if (target == articleUrl) {                          // "Original ↗"
                    showBrowser()
                    return true
                }
                // every other link (Scholar, DOI, supplementary files) continues in the browser view
                showBrowser()
                browser.loadUrl(target)
                return true
            }

            override fun onPageFinished(view: WebView, url: String?) {
                showNav()
                view.evaluateJavascript(
                    "typeof window.__ARTICLE__ + '|' + " +
                        "(document.querySelector('#paper') ? document.querySelector('#paper').children.length : -1)",
                ) { result -> Log.i(TAG, "READER_READY $result") }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) Log.i(TAG, "READER_ERROR ${error.description}")
            }
        }

        reader.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                Log.d("NVConsole", "[reader] ${msg.message()} (${msg.lineNumber()})")
                return true
            }
        }

        wireAutoHide(reader)
    }

    /** Serves reader.html with the freshly parsed model inlined as window.__ARTICLE__. */
    private fun readerHtml(): WebResourceResponse? {
        val html = try {
            assets.open("reader/reader.html").bufferedReader().use { it.readText() }
        } catch (e: Exception) {
            Log.e(TAG, "reader.html missing from assets", e)
            return null
        }
        val json = try {
            File(filesDir, MODEL_FILE).readText()
        } catch (e: Exception) {
            "null"
        }
        // "</" inside the JSON must not close the inline <script>
        val inject = "<script>window.__ARTICLE__ = " + json.replace("<", "\\u003c") + ";</script>\n"
        val served = html.replace(
            "<script src=\"reader.js\"></script>",
            inject + "<script src=\"reader.js\"></script>",
        )
        val response = WebResourceResponse(
            "text/html", "utf-8",
            ByteArrayInputStream(served.toByteArray(Charsets.UTF_8)),
        )
        response.responseHeaders = mutableMapOf("Cache-Control" to "no-store")
        Log.i(TAG, "READER_HTML html=${html.length} injected=${served.length - html.length} model=${json.length}")
        return response
    }

    private fun showReader() {
        readerShowing = true
        activeTab()?.reader = true
        homeShowing = false
        /* a blank tab leaves the address field focused: do not carry its keyboard into the article */
        urlEdit.clearFocus()
        hideKeyboard()
        reader.visibility = View.VISIBLE
        browser.visibility = View.INVISIBLE
        home.visibility = View.GONE
        topBar.visibility = View.GONE
        pillHost.visibility = View.GONE
        zoomPanel.visibility = View.GONE
        showNav()
        markNav()
    }

    private fun showBrowser() {
        activeTab()?.reader = readerShowing
        readerShowing = false
        homeShowing = false
        backTo = null
        reader.visibility = View.GONE
        home.visibility = View.GONE
        browser.visibility = View.VISIBLE
        topBar.visibility = View.VISIBLE
        showNav()
        markNav()
        updateChrome()
    }

    /* ------------------------------------------------------------------ home screens
       library / search / settings are local pages served from the APK and shown in their own
       WebView, with no address bar: the bottom bar is what moves between them. */

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupHome() {
        val s = home.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.databaseEnabled = true
        s.userAgentString = ua
        s.builtInZoomControls = false
        s.displayZoomControls = false
        // local assets only: never show a stale page after an update
        s.cacheMode = WebSettings.LOAD_NO_CACHE

        /* the library page reads and writes the shared store through the same bridge the
           reader uses (see Library.kt) — without it the phone would keep a second list */
        home.addJavascriptInterface(Bridge(), "SchReader")

        home.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assetLoader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val target = request.url.toString()
                if (target.startsWith(ASSET_ORIGIN)) return false    // in-page anchors, own assets
                showBrowser()
                browser.loadUrl(target)
                return true
            }

            override fun onPageFinished(view: WebView, url: String?) {
                Log.i(TAG, "HOME_READY $url")
                showNav()
                // the page's own theme class is set from JS; the bar never covers its content
                view.evaluateJavascript(
                    "typeof SchReader + '|' + (document.body ? document.body.className : '')",
                ) { r -> Log.i(TAG, "HOME_STATE $r") }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) Log.i(TAG, "HOME_ERROR ${request.url} ${error.description}")
            }
        }

        home.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                Log.d("NVConsole", "[home] ${msg.message()} (${msg.lineNumber()})")
                return true
            }
        }

        wireAutoHide(home)
    }

    /* ---------- the bottom bar: where it can take you, and where it leaves you ---------- */

    private fun rememberReturn() {
        backTo = when {
            readerShowing -> "reader"
            !homeShowing && !browser.url.isNullOrEmpty() -> "browser"
            else -> backTo
        }
    }

    /** Open a home tab and remember what Back should return to. */
    private fun openHome(tab: String) {
        rememberReturn()
        showHome(tab)
    }

    /**
     * Bottom bar tap. If that section still has a page open, the first tap returns to the page and
     * the second one goes back to its shelf — that is what people expect from a tab that also
     * holds a browser.
     */
    private fun onNavTap(section: String) {
        hideTabSheet()
        if (homeShowing && homeTab == section) return
        if (!homeShowing && currentSection == section) {
            showHome(section)
            return
        }
        val tid = sectionTab[section]
        if (tid != null && tid != 0 && tabs.any { it.id == tid }) switchTab(tid) else openHome(section)
    }

    private fun showHome(tab: String) {
        /* only a page or the reader tells us what the tab was left on — going from one home screen
           to another must not clear it, or the shelf would forget you were reading */
        if (!homeShowing) activeTab()?.reader = readerShowing
        readerShowing = false
        homeShowing = true
        currentSection = null
        homeTab = tab
        home.visibility = View.VISIBLE
        reader.visibility = View.GONE
        browser.visibility = View.INVISIBLE
        topBar.visibility = View.GONE
        pillHost.visibility = View.GONE
        zoomPanel.visibility = View.GONE
        progress.visibility = View.GONE
        showNav()
        markNav()

        val want = homeUrl(tab)
        val current = home.url.orEmpty().substringBefore('?')
        if (current != want.substringBefore('?') || tab == "settings") {
            home.loadUrl(want)
        } else if (tab == "library") {
            /* the list is read from the store once per page load: ask it to re-read when we come
               back from saving or from a reader session */
            home.evaluateJavascript(
                "window.dispatchEvent(new Event('sr-refresh'))", null,
            )
        }
    }

    private fun markNav() {
        tintNav(navLibrary, homeShowing && homeTab == "library")
        tintNav(navSearch, homeShowing && homeTab == "search")
        tintNav(navSettings, homeShowing && homeTab == "settings")
    }

    /* tinted explicitly rather than through a state-list: a ColorStateList on a duplicated
       parent state is reliable on paper and was grey in practice on this tablet */
    private fun tintNav(item: View, on: Boolean) {
        item.isSelected = on
        val color = if (on) palette.accent else palette.fgSoft
        /* the three bar items share their markup, and shared ids are a lint error (and a
           findViewById trap): paint the row's own children instead of looking ids up */
        val row = item as ViewGroup
        for (i in 0 until row.childCount) {
            when (val child = row.getChildAt(i)) {
                is ImageView -> child.setColorFilter(color)
                is TextView -> child.setTextColor(color)
                else -> Unit
            }
        }
    }

    /* ---------- the bottom bar slides away so a page gets the whole screen ---------- */

    private fun wireAutoHide(view: WebView) {
        view.setOnScrollChangeListener { v, _, y, _, oldY ->
            val dy = y - oldY
            when {
                /* a real downward drag, not the one-pixel jitter of a page finishing layout */
                dy > dp(12) && y > dp(24) -> hideNav()
                dy < -dp(12) -> showNav()
            }
        }
    }

    private fun hideNav() {
        if (!navShown) return
        navShown = false
        navWrap.animate().translationY(navWrap.height.toFloat()).setDuration(170).start()
    }

    private fun showNav() {
        if (navShown && navWrap.translationY == 0f) return
        navShown = true
        navWrap.animate().translationY(0f).setDuration(170).start()
    }

    // ------------------------------------------------------------------ extraction

    private fun beginExtract() {
        if (busy) return
        val pageUrl = browser.url ?: return
        if (!pageUrl.startsWith("http")) {
            say("This page cannot be parsed")
            return
        }
        val bundle = try {
            assets.open("extractor.bundle.js").bufferedReader().use { it.readText() }
        } catch (e: Exception) {
            say("Parser assets are missing — rebuild the app")
            return
        }
        busy = true
        pillLabel.text = "Parsing…"
        say("Reading this page…")
        Log.i(TAG, "EXTRACT_START $pageUrl bundle=${bundle.length}")
        browser.evaluateJavascript(bundle, null)
        browser.evaluateJavascript(EXTRACT_JS, null)
    }

    private inner class Bridge {
        @JavascriptInterface
        fun modelStart() {
            synchronized(modelBuf) { modelBuf.setLength(0) }
        }

        @JavascriptInterface
        fun modelChunk(chunk: String) {
            synchronized(modelBuf) { modelBuf.append(chunk) }
        }

        @JavascriptInterface
        fun modelDone() {
            val json = synchronized(modelBuf) { modelBuf.toString() }
            handler.post { onModel(json) }
        }

        @JavascriptInterface
        fun fail(message: String) {
            handler.post { onExtractFailure(message) }
        }

        /* ---- library: same store as the Chrome extension (see Library.kt) ---- */

        @JavascriptInterface
        fun libLoad(key: String): String = library.json(key)

        @JavascriptInterface
        fun libSave(key: String, body: String) {
            library.putJson(key, body)
        }

        @JavascriptInterface
        fun openLibrary() {
            handler.post { openLibraryPage() }
        }

        @JavascriptInterface
        fun closeLibrary() {
            handler.post { closeLibraryPage() }
        }

        @JavascriptInterface
        fun openArticle(url: String) {
            handler.post { openArticleFromLibrary(url) }
        }

        /** the Search shelf: the page it opens belongs to the Search section */
        @JavascriptInterface
        fun openLink(url: String) {
            handler.post { openFromShelf(url) }
        }

        /** the reader toolbar opens the tab list (the article covers the native top bar) */
        @JavascriptInterface
        fun showTabs() {
            handler.post { showTabSheet() }
        }

        /** every page reports the palette it is actually using (preset or custom) */
        @JavascriptInterface
        fun setTheme(json: String) {
            handler.post { applyPalette(json, true) }
        }

        @JavascriptInterface
        fun shareText(name: String, text: String) {
            handler.post { shareLibraryExport(name, text) }
        }
    }

    private fun onExtractFailure(message: String) {
        busy = false
        pillLabel.text = getString(R.string.pill_label)
        Log.i(TAG, "EXTRACT_FAIL $message")
        say("Parse failed: ${message.take(80)}")
    }

    private fun onModel(json: String) {
        busy = false
        pillLabel.text = getString(R.string.pill_label)
        if (json.isBlank()) {
            say("Nothing was extracted")
            return
        }
        val stats = parseStats(json)
        if (stats == null) {
            Log.i(TAG, "MODEL unreadable bytes=${json.length}")
            say("The parse result could not be read")
            return
        }
        Log.i(TAG, "MODEL bytes=${json.length} sections=${stats.sections} paragraphs=${stats.paragraphs} " +
            "figures=${stats.figures} refs=${stats.refs} warnings=${stats.warnings}")

        articleTitle = stats.title.ifBlank { browser.title.orEmpty() }
        articleUrl = stats.sourceUrl.ifBlank { browser.url ?: "" }
        if (stats.paragraphs < 3) {
            /* A bot wall is not "a mobile template the extractor missed" — retrying as a
               desktop browser makes the fingerprint inconsistent (UA says Windows, client
               hints say Android) and usually just returns the block page again. Ask the page
               first, then either retry or say so plainly. */
            pageLooksBlocked { blocked ->
                when {
                    blocked -> {
                        if (desktopMode) setDesktopMode(false)
                        pillLabel.text = getString(R.string.pill_label)
                        say("This site blocks the app's built-in browser (Chrome on the same phone still opens it)", 5000)
                    }
                    !desktopMode && !retriedDesktop -> {
                        retriedDesktop = true
                        pendingExtract = true
                        pillLabel.text = "Parsing…"
                        setDesktopMode(true)
                        say("No body text in the mobile page — retrying as desktop…", 4000)
                        browser.reload()
                    }
                    else -> {
                        if (desktopMode) setDesktopMode(false)
                        say("Too little body text (${stats.summary}) — the full text may be in a PDF or a separate frame")
                    }
                }
            }
            return
        }
        retriedDesktop = false
        try {
            File(filesDir, MODEL_FILE).writeText(json)
        } catch (e: Exception) {
            Log.e(TAG, "cannot cache model", e)
            say("Could not save the parse result")
            return
        }
        articleByTab[activeId] = json
        readerTab = activeId
        activeTab()?.reader = true
        reader.loadUrl(READER_URL)
        showReader()
        say(stats.summary)
    }

    private class Stats(
        val sections: Int,
        val paragraphs: Int,
        val figures: Int,
        val refs: Int,
        val warnings: Int,
        val title: String,
        val sourceUrl: String,
    ) {
        val summary: String get() = "$sections sections · $paragraphs paragraphs · $figures figures · $refs refs"
    }

    private fun parseStats(json: String): Stats? {
        val root = try {
            JSONObject(json)
        } catch (e: Exception) {
            return null
        }
        val sections = root.optJSONArray("sections") ?: org.json.JSONArray()
        var paragraphs = 0
        for (i in 0 until sections.length()) {
            val blocks = sections.optJSONObject(i)?.optJSONArray("blocks") ?: continue
            for (j in 0 until blocks.length()) {
                if (blocks.optJSONObject(j)?.optString("t") == "p") paragraphs++
            }
        }
        val sourceUrl = root.optJSONObject("source")?.optString("url").orEmpty()
        val title = root.optJSONObject("meta")?.optString("title").orEmpty()
        return Stats(
            sections = sections.length(),
            paragraphs = paragraphs,
            figures = root.optJSONArray("figures")?.length() ?: 0,
            refs = root.optJSONArray("references")?.length() ?: 0,
            warnings = root.optJSONArray("warnings")?.length() ?: 0,
            title = title,
            sourceUrl = sourceUrl,
        )
    }

    // ------------------------------------------------------------------ top bar

    private fun navigate(input: String) {
        val text = input.trim()
        if (text.isEmpty()) return
        val url = when {
            text.startsWith("http://") || text.startsWith("https://") -> text
            text.contains(".") && !text.contains(" ") -> "https://$text"
            else -> "https://scholar.google.com/scholar?q=" + Uri.encode(text)
        }
        urlEdit.clearFocus()
        hideKeyboard()
        activeTab()?.let { it.url = url; it.title = "" }
        pendingScroll = -1
        showBrowser()
        browser.loadUrl(url)
        saveTabs()
    }

    private fun updateChrome() {
        val current = browser.url.orEmpty()
        val host = runCatching { Uri.parse(current).host.orEmpty() }.getOrDefault("")
        if (!urlEdit.hasFocus()) {
            /* the address bar shows the site, not the tail of a 90-character PII URL; the
               full URL comes back the moment it is tapped for editing */
            val short = if (host.isNotEmpty()) host else current.removePrefix("https://").removePrefix("http://")
            urlEdit.setText(short)
            urlEdit.setSelection(urlEdit.text.length)
        }
        val onArticlePage = current.startsWith("http") &&
            !host.contains("scholar.google") &&
            !host.contains("accounts.google") &&
            !host.contains("google.com")
        pillHost.visibility = if (!readerShowing && !homeShowing && onArticlePage) View.VISIBLE else View.GONE

        val favUrl = normalized(articleUrl ?: current)
        starBtn.text = if (favUrl.isNotEmpty() && library.has(favUrl)) "★" else "☆"

        /* a tinted reload arrow = this site is being loaded as a desktop page */
        findViewById<TextView>(R.id.btnReload).setTextColor(
            if (desktopMode) palette.accent else palette.fgSoft,
        )

        val backBtn = findViewById<View>(R.id.btnBack)
        backBtn.alpha = if (browser.canGoBack() || readerShowing) 1f else 0.4f
        forwardBtn.alpha = if (browser.canGoForward()) 1f else 0.35f

        zoomBtn.text = "$zoom%"
        zoomBtn.setTextColor(if (zoom == 100) palette.faint else palette.accent)
        zoomValue.text = "$zoom%"
    }

    /* ---------- page zoom ----------
       Publisher pages (especially in desktop mode) are either too small or too large on a
       phone, and pinch-zooming loses the layout. CSS `zoom` on <html> scales the whole page
       like Ctrl+'+', and unlike a transform it reflows, so text stays crisp. The reader page
       has its own Aa control and is not touched. */
    private fun toggleZoomPanel() {
        urlEdit.clearFocus()
        hideKeyboard()
        if (zoomPanel.visibility == View.VISIBLE) {
            zoomPanel.visibility = View.GONE
            return
        }
        zoomPanel.visibility = View.VISIBLE
        zoomPanel.post { placeZoomPanel() }
    }

    /** The − / + strip belongs under the zoom button, not at the far left of the screen. */
    private fun placeZoomPanel() {
        val w = zoomPanel.width
        if (w <= 0) return
        val btn = IntArray(2)
        zoomBtn.getLocationInWindow(btn)
        val box = IntArray(2)
        zoomPanel.getLocationInWindow(box)
        val want = btn[0] + zoomBtn.width - w
        val maxLeft = window.decorView.width - w - dp(8)
        val target = want.coerceIn(dp(8), maxOf(dp(8), maxLeft))
        /* translationX replaces the previous offset, so add the delta instead of assigning it —
           assigning made the second open land wherever the untranslated panel happened to be */
        zoomPanel.translationX += (target - box[0]).toFloat()
    }

    private fun stepZoom(dir: Int) {
        val i = ZOOM_STEPS.indexOf(zoom).let { if (it < 0) ZOOM_STEPS.indexOf(100) else it }
        applyZoom(ZOOM_STEPS[(i + dir).coerceIn(0, ZOOM_STEPS.size - 1)])
    }

    private fun applyZoom(percent: Int) {
        zoom = percent
        prefs.edit().putInt("zoom", percent).apply()
        syncPageZoom()
        updateChrome()
        say("Page zoom $percent%", 1200)
    }

    /** re-applied after every page load: a new document has no inline zoom */
    private fun syncPageZoom() {
        val js = "(function(){try{document.documentElement.style.zoom='" +
            (if (zoom == 100) "" else (zoom / 100.0).toString()) + "';}catch(e){}})()"
        browser.evaluateJavascript(js, null)
    }

    private fun setDesktopMode(on: Boolean) {
        desktopMode = on
        browser.settings.userAgentString = if (on) desktopUa else ua
        updateChrome()
    }

    /** Is this the publisher's bot wall rather than an article? Read it, do not guess. */
    private fun pageLooksBlocked(onResult: (Boolean) -> Unit) {
        browser.evaluateJavascript(
            "(document.body ? document.body.innerText : '').slice(0, 4000)",
        ) { raw ->
            val text = (raw ?: "")
            val blocked = listOf(
                "problem providing the content",   // Elsevier / ScienceDirect
                "Access Denied",
                "are you a robot",
                "unusual traffic",
                "enable JavaScript and cookies to continue",
            ).any { text.contains(it, ignoreCase = true) }
            onResult(blocked)
        }
    }

    private fun toggleFavorite() {
        val target = normalized(if (readerShowing) articleUrl ?: "" else browser.url ?: "")
        if (target.isBlank()) {
            say("No page to save")
            return
        }
        val title = articleTitle.ifBlank { browser.title.orEmpty() }.ifBlank { target }
        val saved = library.toggle(target, title)
        say(if (saved) "Saved" else "Removed from saved")
        updateChrome()
    }

    // ------------------------------------------------------------------ library page

    private fun homeUrl(tab: String): String = when (tab) {
        "search" -> "$ASSET_ORIGIN/assets/reader/search.html"
        "settings" -> "$ASSET_ORIGIN/assets/reader/settings.html?v=" + Uri.encode(appVersion())
        else -> "$ASSET_ORIGIN/assets/reader/library.html"
    }

    private fun appVersion(): String = try {
        @Suppress("DEPRECATION")
        packageManager.getPackageInfo(packageName, 0).versionName.orEmpty()
    } catch (e: Exception) {
        ""
    }

    private fun openLibraryPage() = openHome("library")

    /** Back to the article: reader.html is re-served with the stored model inlined. */
    private fun closeLibraryPage() {
        val tab = activeTab()
        if (tab != null && resumeReader(tab)) return
        if (File(filesDir, MODEL_FILE).exists()) {
            reader.loadUrl(READER_URL)
            showReader()
        } else {
            showBrowser()
        }
    }

    private fun openArticleFromLibrary(url: String) {
        openPage(url, "library")
    }

    /** a site tapped on the Search shelf belongs to the Search section */
    private fun openFromShelf(url: String) {
        openPage(url, "search")
    }

    /** The WebView cannot download a blob, so exports go to the system share sheet. */
    private fun shareLibraryExport(name: String, text: String) {
        try {
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = if (name.endsWith(".json")) "application/json" else "text/plain"
                putExtra(Intent.EXTRA_SUBJECT, name)
                putExtra(Intent.EXTRA_TEXT, text)
            }
            startActivity(Intent.createChooser(intent, name))
        } catch (e: Exception) {
            say("Could not share $name")
        }
    }

    // ------------------------------------------------------------------ tabs

    private class BrowserTab(
        val id: Int,
        var url: String,
        var title: String,
        var scroll: Int = 0,
        var section: String? = null,
        /** last surface this tab was left on: true = the reader, false = the page */
        var reader: Boolean = false,
    )

    private fun activeTab(): BrowserTab? = tabs.firstOrNull { it.id == activeId }

    private fun displayTitle(t: BrowserTab): String = t.title.ifBlank {
        if (t.url.isBlank() || t.url == BLANK_URL) getString(R.string.tab_blank) else hostOf(t.url)
    }

    private fun hostOf(url: String): String =
        runCatching { Uri.parse(url).host.orEmpty().removePrefix("www.") }.getOrDefault("")

    private fun updateTabChrome() {
        if (!::tabsBtn.isInitialized) return
        tabsBtn.text = tabs.size.coerceAtLeast(1).toString()
        tabsBtn.setTextColor(if (tabs.size > 1) palette.accent else palette.fgSoft)
        tabsBtn.backgroundTintList = android.content.res.ColorStateList.valueOf(
            if (tabs.size > 1) palette.accent else palette.line,
        )
    }

    /**
     * Open a page. `section` is the home screen it came from (library / search) and decides what
     * the bottom bar does the next time that section is tapped: return to this page, and only the
     * second tap goes back to the shelf.
     */
    private fun openPage(url: String, section: String?, forceNewTab: Boolean = false) {
        val active = activeTab()
        val blank = active == null || active.url.isBlank() || active.url == BLANK_URL
        val tab = if (active == null || forceNewTab || !blank) newTab(url, section) else {
            active.url = url
            if (section != null) active.section = section
            active
        }
        activeId = tab.id
        if (section != null) {
            tab.section = section
            sectionTab[section] = tab.id
        }
        currentSection = tab.section
        pendingScroll = -1
        showBrowser()
        browser.loadUrl(url)
        updateTabChrome()
        saveTabs()
    }

    private fun newTab(url: String, section: String?): BrowserTab {
        if (tabs.size >= MAX_TABS) {
            /* drop the oldest tab that is not the one you are looking at */
            val victim = tabs.firstOrNull { it.id != activeId } ?: tabs.first()
            dropTab(victim.id)
        }
        val tab = BrowserTab(nextId++, url, "", 0, section)
        tabs.add(tab)
        return tab
    }

    private fun dropTab(id: Int) {
        val i = tabs.indexOfFirst { it.id == id }
        if (i < 0) return
        tabs.removeAt(i)
        for (k in sectionTab.keys.toList()) if (sectionTab[k] == id) sectionTab.remove(k)
        articleByTab.remove(id)
        if (readerTab == id) readerTab = 0
        if (activeId == id) {
            val next = tabs.getOrNull(i) ?: tabs.getOrNull(i - 1)
            activeId = next?.id ?: 0
            if (next != null) pendingScroll = next.scroll
        }
        updateTabChrome()
        saveTabs()
    }

    private fun switchTab(id: Int) {
        val tab = tabs.firstOrNull { it.id == id } ?: return
        if (id == activeId && !homeShowing && !readerShowing && browser.url == tab.url) {
            showBrowser()
            return
        }
        captureScroll {
            activeId = id
            currentSection = tab.section
            pendingScroll = tab.scroll
            updateTabChrome()
            saveTabs()
            if (!resumeReader(tab)) {
                showBrowser()
                if (tab.url.isBlank() || tab.url == BLANK_URL) loadBlank() else browser.loadUrl(tab.url)
            }
        }
    }

    /**
     * Put the reader back for a tab that was left reading it. The WebView is still holding that
     * article, so this is usually just a visibility flip (scroll position intact); only when another
     * tab has rendered in between does it re-serve the cached model.
     */
    private fun resumeReader(tab: BrowserTab): Boolean {
        if (!tab.reader) return false
        if (readerTab == tab.id) {
            showReader()
            return true
        }
        val json = articleByTab[tab.id] ?: return false
        return try {
            File(filesDir, MODEL_FILE).writeText(json)
            readerTab = tab.id
            reader.loadUrl(READER_URL)
            showReader()
            true
        } catch (e: Exception) {
            Log.w(TAG, "cannot restore the reader for tab " + tab.id, e)
            false
        }
    }

    private fun loadBlank() {
        showBrowser()
        browser.loadUrl(BLANK_URL)
        urlEdit.requestFocus()
        urlEdit.post { showKeyboard(urlEdit) }
    }

    /** Read the page's scroll position into the active tab, then run [then]. */
    private fun captureScroll(then: () -> Unit) {
        val shown = !homeShowing && browser.url != null
        if (!shown) { then(); return }
        browser.evaluateJavascript("Math.round(window.scrollY)||0") { v ->
            activeTab()?.scroll = (v ?: "").trim('"').toIntOrNull() ?: 0
            then()
        }
    }

    private fun showTabSheet() {
        renderTabs()
        tabSheet.visibility = View.VISIBLE
        pillHost.visibility = View.GONE      /* it would float over the sheet */
    }

    private fun hideTabSheet() {
        if (!::tabSheet.isInitialized) return
        tabSheet.visibility = View.GONE
        updateChrome()
    }

    private fun renderTabs() {
        tabList.removeAllViews()
        tabTitle.text = "${getString(R.string.tabs_label)} (${tabs.size})"
        for (t in tabs) {
            val on = t.id == activeId
            val row = layoutInflater.inflate(R.layout.tab_row, tabList, false)
            val gd = android.graphics.drawable.GradientDrawable().apply {
                cornerRadius = dp(12).toFloat()
                setColor(if (on) palette.accentSoft else palette.soft)
                setStroke(dp(1), if (on) palette.accent else palette.line)
            }
            row.background = gd
            row.findViewById<TextView>(R.id.tabRowTitle).apply {
                text = displayTitle(t)
                setTextColor(if (on) palette.fg else palette.fgSoft)
            }
            row.findViewById<TextView>(R.id.tabRowHost).apply {
                val host = hostOf(t.url)
                text = if (on) getString(R.string.tabs_current, host) else host
                setTextColor(palette.faint)
            }
            row.findViewById<TextView>(R.id.tabRowClose).apply {
                setTextColor(palette.faint)
                setOnClickListener { closeTabFromSheet(t.id) }
            }
            row.setOnClickListener {
                hideTabSheet()
                switchTab(t.id)
            }
            tabList.addView(row)
        }
    }

    private fun closeTabFromSheet(id: Int) {
        val wasActive = id == activeId
        dropTab(id)
        if (tabs.isEmpty()) {
            val t = newTab(BLANK_URL, null)
            activeId = t.id
            updateTabChrome()
            hideTabSheet()
            showHome("library")
            return
        }
        if (wasActive) {
            val t = activeTab() ?: tabs.first()
            activeId = t.id
            pendingScroll = t.scroll
            showBrowser()
            if (t.url.isBlank() || t.url == BLANK_URL) loadBlank() else browser.loadUrl(t.url)
        }
        renderTabs()
    }

    private fun saveTabs() {
        if (tabs.isEmpty()) return
        val arr = org.json.JSONArray()
        for (t in tabs) {
            arr.put(
                JSONObject()
                    .put("id", t.id).put("u", t.url).put("t", t.title)
                    .put("s", t.scroll).put("k", t.section ?: ""),
            )
        }
        val sec = JSONObject()
        for ((k, v) in sectionTab) sec.put(k, v)
        val where = when {
            readerShowing -> "reader"
            homeShowing -> "home:$homeTab"
            else -> "page"
        }
        prefs.edit()
            .putString("tabs", arr.toString())
            .putInt("tabActive", activeId)
            .putInt("tabNext", nextId)
            .putString("tabSections", sec.toString())
            .putString("lastView", where)
            .apply()
    }

    private fun restoreTabs() {
        try {
            val raw = prefs.getString("tabs", null)
            if (raw != null) {
                val arr = org.json.JSONArray(raw)
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i) ?: continue
                    tabs.add(
                        BrowserTab(
                            o.optInt("id", 0), o.optString("u"), o.optString("t"),
                            o.optInt("s", 0), o.optString("k").ifBlank { null },
                        ),
                    )
                }
            }
            if (tabs.isNotEmpty()) {
                activeId = prefs.getInt("tabActive", tabs.first().id)
                if (tabs.none { it.id == activeId }) activeId = tabs.first().id
                nextId = prefs.getInt("tabNext", (tabs.maxOfOrNull { it.id } ?: 0) + 1)
                val o = JSONObject(prefs.getString("tabSections", "{}"))
                for (k in o.keys()) sectionTab[k] = o.optInt(k)
            }
        } catch (e: Exception) {
            Log.w(TAG, "could not restore tabs", e)
        }
    }

    // ------------------------------------------------------------------ theme

    private class Palette(
        var bg: Int = 0xFF14130F.toInt(),
        var soft: Int = 0xFF201E19.toInt(),
        var sunk: Int = 0xFF2A2721.toInt(),
        var fg: Int = 0xFFEFE9DD.toInt(),
        var fgSoft: Int = 0xFFA89F8F.toInt(),
        var faint: Int = 0xFF6B6557.toInt(),
        var line: Int = 0xFF2F2C25.toInt(),
        var lineStrong: Int = 0xFF3A352B.toInt(),
        var accent: Int = 0xFFF7B705.toInt(),
        var accentSoft: Int = 0xFF2A2721.toInt(),
        var dark: Boolean = true,
    )

    private fun colorOf(text: String?, fallback: Int): Int =
        try {
            if (text.isNullOrBlank()) fallback else android.graphics.Color.parseColor(text)
        } catch (e: Exception) {
            fallback
        }

    /**
     * The pages report the palette they actually computed (a preset or the reader's custom
     * colours), so the native chrome — bars, address field, tab sheet — wears the same skin
     * instead of a hard-coded dark theme.
     */
    private fun applyPalette(json: String, persist: Boolean) {
        val cur = palette
        val p = Palette()
        try {
            val o = JSONObject(json)
            p.bg = colorOf(o.optString("bg"), cur.bg)
            p.soft = colorOf(o.optString("soft"), cur.soft)
            p.sunk = colorOf(o.optString("sunk"), cur.sunk)
            p.fg = colorOf(o.optString("fg"), cur.fg)
            p.fgSoft = colorOf(o.optString("fgSoft"), cur.fgSoft)
            p.faint = colorOf(o.optString("faint"), cur.faint)
            p.line = colorOf(o.optString("line"), cur.line)
            p.lineStrong = colorOf(o.optString("lineStrong"), cur.lineStrong)
            p.accent = colorOf(o.optString("accent"), cur.accent)
            p.accentSoft = colorOf(o.optString("accentSoft"), cur.accentSoft)
            p.dark = o.optBoolean("dark", cur.dark)
        } catch (e: Exception) {
            Log.w(TAG, "ignoring a palette the page could not describe", e)
            return
        }
        palette = p
        paintChrome()
        if (persist) prefs.edit().putString("palette", json).apply()
    }

    private fun paintChrome() {
        val pal = palette
        findViewById<View>(R.id.root).setBackgroundColor(pal.bg)
        topBar.setBackgroundColor(pal.bg)
        (navWrap as ViewGroup).getChildAt(0)?.setBackgroundColor(pal.line)
        (findViewById<View>(R.id.bottomNav)).setBackgroundColor(pal.bg)
        tabSheet.setBackgroundColor(pal.bg)
        (tabSheet as ViewGroup).getChildAt(1)?.setBackgroundColor(pal.line)

        for (id in intArrayOf(R.id.btnBack, R.id.btnForward, R.id.btnReload)) {
            findViewById<TextView>(id).setTextColor(pal.fg)
        }
        findViewById<TextView>(R.id.btnStar).setTextColor(pal.accent)
        zoomBtn.setTextColor(if (zoom == 100) pal.faint else pal.accent)
        urlEdit.setTextColor(pal.fg)
        urlEdit.setHintTextColor(pal.faint)
        (urlEdit.parent as? View)?.backgroundTintList =
            android.content.res.ColorStateList.valueOf(pal.soft)
        /* the − / + strip keeps its dark pill (bg_pill) in every theme, so its text stays light:
           painting it with the page colour made the percentage vanish on light skins */
        zoomValue.setTextColor(getColor(R.color.text))
        tabTitle.setTextColor(pal.fg)
        findViewById<TextView>(R.id.btnNewTab).setTextColor(pal.accent)
        findViewById<TextView>(R.id.btnTabSheetClose).setTextColor(pal.fgSoft)
        toastMsg.setTextColor(pal.fg)
        progress.progressTintList = android.content.res.ColorStateList.valueOf(pal.accent)

        window.statusBarColor = pal.bg
        window.navigationBarColor = pal.bg
        setBarsLight(!pal.dark)

        markNav()
        updateTabChrome()
    }

    /** Light system-bar icons on a dark page, dark icons on a light one. */
    private fun setBarsLight(light: Boolean) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val c = window.insetsController ?: return
            val mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
                WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            c.setSystemBarsAppearance(if (light) mask else 0, mask)
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility =
                if (light) View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR else 0
        }
    }

    // ------------------------------------------------------------------ helpers

    private fun normalized(url: String): String = url.trim().substringBefore('#')

    private fun hideKeyboard() {
        val imm = getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager
        imm.hideSoftInputFromWindow(urlEdit.windowToken, 0)
    }

    private fun showKeyboard(view: View) {
        val imm = getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager
        imm.showSoftInput(view, InputMethodManager.SHOW_IMPLICIT)
    }

    private fun say(text: String, ms: Long = 2400) {
        toastMsg.text = text
        toastMsg.visibility = View.VISIBLE
        sayToken++
        val token = sayToken
        handler.postDelayed({ if (token == sayToken) toastMsg.visibility = View.GONE }, ms)
    }

    private fun openExternal(url: String) {
        try {
            val intent = if (url.startsWith("intent:")) {
                Intent.parseUri(url, Intent.URI_INTENT_SCHEME)
            } else {
                Intent(Intent.ACTION_VIEW, Uri.parse(url))
            }
            startActivity(intent)
        } catch (e: Exception) {
            say("Could not open this link")
        }
    }

    private fun download(url: String, userAgent: String, contentDisposition: String?, mimeType: String?) {
        try {
            val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
            val request = DownloadManager.Request(Uri.parse(url))
                .setMimeType(mimeType)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, name)
            CookieManager.getInstance().getCookie(url)?.let { request.addRequestHeader("Cookie", it) }
            request.addRequestHeader("User-Agent", userAgent.ifBlank { ua })
            (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
            say("Downloading $name")
        } catch (e: Exception) {
            Log.e(TAG, "download failed", e)
            say("Download failed — try the system browser")
        }
    }

    /** `schreader://open?url=…&extract=1`, `schreader://extract?url=…` or the extra both work.
     *  The old `natureview` scheme is still accepted so existing links keep working. */
    private fun wantsExtract(intent: Intent?): Boolean {
        if (intent == null) return false
        if (intent.getBooleanExtra("extract", false)) return true
        val d = intent.data ?: return false
        val q = d.getQueryParameter("extract")
        return d.host == "extract" || q == "1" || q == "true"
    }

    private fun urlFromIntent(intent: Intent?): String? {
        if (intent == null) return null
        intent.data?.let { data ->
            if (data.scheme == "schreader" || data.scheme == "natureview") {
                data.getQueryParameter("url")?.takeIf { it.isNotBlank() }?.let { return it }
                return browser.url
            }
        }
        if (intent.action == Intent.ACTION_SEND) {
            val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: return null
            return Regex("https?://\\S+").find(text)?.value
        }
        return null
    }

    private companion object {
        /** zoom ladder for publisher pages; 100 is reset. 25% is the floor (plates and
            two-column PDF-like pages need it on a 11-inch tablet) */
        val ZOOM_STEPS = intArrayOf(25, 33, 50, 67, 75, 85, 100, 115, 130, 150, 175, 200)
        const val MAX_TABS = 8
        const val BLANK_URL = "about:blank"

        val EXTRACT_JS = """
            (function(){
              try {
                if (!window.SR || typeof window.SR.extract !== 'function') {
                  SchReader.fail('The parser did not load');
                  return 'no-extractor';
                }
                var model = window.SR.extract();
                var text = JSON.stringify(model);
                SchReader.modelStart();
                var CH = 180000;
                for (var i = 0; i < text.length; i += CH) {
                  SchReader.modelChunk(text.substr(i, CH));
                }
                SchReader.modelDone();
                return 'ok:' + text.length;
              } catch (e) {
                SchReader.fail(String((e && e.stack) || e));
                return 'err';
              }
            })()
        """.trimIndent()
    }
}

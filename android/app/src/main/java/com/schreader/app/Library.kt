package com.schreader.app

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * The app's half of the shared library store (see extension/library-store.js).
 *
 * One JSON file holds the same three sections the Chrome extension keeps in chrome.storage.local:
 * saved items, reading history and settings. Only metadata is stored — title, authors, journal,
 * year, DOI, link, tags, note, reading position — never article text.
 *
 * The reader page talks to this class through the `SchReader` bridge (libLoad / libSave), and the
 * native star button uses the small helpers below, so the phone and the browser show the same list
 * instead of two that drift apart.
 */
class Library(context: Context) {

    private val file = File(context.filesDir, "library.json")
    private val legacy = File(context.filesDir, "favorites.json")

    data class Item(val id: String, val url: String, val title: String, val ts: Long)

    /* ------------------------------------------------------------ raw store */

    private fun read(): JSONObject {
        val root = try {
            if (file.exists()) JSONObject(file.readText()) else JSONObject()
        } catch (e: Exception) {
            JSONObject()
        }
        if (!root.has("items")) root.put("items", JSONArray())
        if (!root.has("history")) root.put("history", JSONArray())
        if (!root.has("settings")) root.put("settings", JSONObject().put("history", true))
        return root
    }

    private fun write(root: JSONObject) {
        try {
            val tmp = File(file.parentFile, file.name + ".tmp")
            tmp.writeText(root.toString())
            tmp.renameTo(file)
        } catch (e: Exception) {
            // a failed save must never crash the reader
            Log.w("NVLibrary", "could not write library.json", e)
        }
    }

    /** JSON text for one section; the page reads "sr-lib", "sr-history", "sr-lib-settings",
     *  "sr-search-sites", "sr-sync". */
    @Synchronized
    fun json(key: String): String {
        migrateLegacy()
        val root = read()
        return when (key) {
            "sr-lib" -> root.optJSONArray("items")?.toString() ?: "[]"
            "sr-history" -> root.optJSONArray("history")?.toString() ?: "[]"
            "sr-lib-settings" -> root.optJSONObject("settings")?.toString() ?: "{}"
            /* the Search tab's own shortcuts. An unknown key must not fall through to "null":
               the page then keeps its list in memory only and it vanishes on the next reload. */
            "sr-search-sites" -> root.optJSONArray("searchSites")?.toString() ?: "[]"
            /* sync config (token, gist id, last merged digest) — same rule: never "null" */
            "sr-sync" -> root.optJSONObject("sync")?.toString() ?: "{}"
            else -> "null"
        }
    }

    /** Replace one section with the JSON the page sent back. */
    @Synchronized
    fun putJson(key: String, text: String) {
        migrateLegacy()
        val root = read()
        try {
            when (key) {
                "sr-lib" -> root.put("items", JSONArray(text))
                "sr-history" -> root.put("history", JSONArray(text))
                "sr-lib-settings" -> root.put("settings", JSONObject(text))
                "sr-search-sites" -> root.put("searchSites", JSONArray(text))
                "sr-sync" -> root.put("sync", JSONObject(text))
                else -> return
            }
            write(root)
        } catch (e: Exception) {
            Log.w("NVLibrary", "bad payload for $key", e)
        }
    }

    /* ------------------------------------------------------------ native star */

    fun all(): List<Item> {
        migrateLegacy()
        val arr = read().optJSONArray("items") ?: return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            val url = o.optString("url").takeIf { it.isNotBlank() } ?: return@mapNotNull null
            Item(o.optString("id"), url, o.optString("title"), o.optLong("addedAt"))
        }
    }

    /** The star compares the page URL; entries saved from the web side carry a DOI-based id. */
    fun has(url: String): Boolean = all().any { it.url == url || it.id == url }

    /** @return true when the page ended up saved, false when it was removed */
    @Synchronized
    fun toggle(url: String, title: String): Boolean {
        migrateLegacy()
        val root = read()
        val arr = root.optJSONArray("items") ?: JSONArray()
        val kept = JSONArray()
        var removed = false
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val same = o.optString("url") == url || o.optString("id") == url
            if (same && !removed) {
                removed = true          // drop the first match, keep anything else
            } else {
                kept.put(o)
            }
        }
        if (removed) {
            root.put("items", kept)
            write(root)
            return false
        }
        // newest first, matching the page's own sort
        val fresh = JSONArray()
        fresh.put(JSONObject()
            .put("id", "url:" + url)
            .put("url", url)
            .put("title", title)
            .put("authors", JSONArray())
            .put("journal", "")
            .put("year", "")
            .put("doi", "")
            .put("addedAt", System.currentTimeMillis())
            .put("lastReadAt", 0)
            .put("updatedAt", System.currentTimeMillis())
            .put("tags", JSONArray())
            .put("note", "")
            .put("progress", JSONObject.NULL))
        for (i in 0 until kept.length()) fresh.put(kept.get(i))
        root.put("items", fresh)
        write(root)
        return true
    }

    @Synchronized
    fun remove(url: String) {
        migrateLegacy()
        val root = read()
        val arr = root.optJSONArray("items") ?: return
        val kept = JSONArray()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            if (o.optString("url") != url && o.optString("id") != url) kept.put(o)
        }
        root.put("items", kept)
        write(root)
    }

    /* ------------------------------------------------------------ one-time import */

    /** v0.1.x kept a plain favourites list; fold it into the new store the first time we read. */
    private fun migrateLegacy() {
        if (!legacy.exists() || file.exists()) return
        try {
            val old = JSONArray(legacy.readText())
            val items = JSONArray()
            for (i in 0 until old.length()) {
                val o = old.optJSONObject(i) ?: continue
                val url = o.optString("url").takeIf { it.isNotBlank() } ?: continue
                items.put(JSONObject()
                    .put("id", "url:" + url)
                    .put("url", url)
                    .put("title", o.optString("title"))
                    .put("authors", JSONArray())
                    .put("journal", "")
                    .put("year", "")
                    .put("doi", "")
                    .put("addedAt", o.optLong("ts", System.currentTimeMillis()))
                    .put("lastReadAt", 0)
                    .put("tags", JSONArray())
                    .put("note", "")
                    .put("progress", JSONObject.NULL))
            }
            write(JSONObject()
                .put("items", items)
                .put("history", JSONArray())
                .put("settings", JSONObject().put("history", true)))
            Log.i("NVLibrary", "imported ${items.length()} favourites")
        } catch (e: Exception) {
            Log.w("NVLibrary", "legacy favourites could not be imported", e)
        }
    }
}

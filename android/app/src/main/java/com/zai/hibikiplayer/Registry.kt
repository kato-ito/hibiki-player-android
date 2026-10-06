package com.zai.hibikiplayer

import android.content.Context
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject

/** 音频 / 图片注册表：id ↔ SAF URI，持久化到本机 */
class Registry(private val context: Context) {

    data class Entry(val id: String, val uri: String, val name: String, val size: Long)

    private val prefs = context.getSharedPreferences("hibiki_registry", Context.MODE_PRIVATE)

    private var audioCache: MutableMap<String, Entry>? = null
    private var imageCache: MutableMap<String, Entry>? = null

    private fun loadMap(key: String): MutableMap<String, Entry> {
        val out = mutableMapOf<String, Entry>()
        val raw = prefs.getString(key, null) ?: return out
        try {
            val arr = JSONArray(raw)
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                val id = o.getString("id")
                out[id] = Entry(id, o.getString("uri"), o.optString("name"), o.optLong("size", 0L))
            }
        } catch (e: Exception) {
            // 数据损坏时忽略，不影响启动
        }
        return out
    }

    private fun saveMap(key: String, map: Map<String, Entry>) {
        val arr = JSONArray()
        for (e in map.values) {
            arr.put(
                JSONObject()
                    .put("id", e.id)
                    .put("uri", e.uri)
                    .put("name", e.name)
                    .put("size", e.size)
            )
        }
        prefs.edit().putString(key, arr.toString()).apply()
    }

    private fun audioMap(): MutableMap<String, Entry> {
        var m = audioCache
        if (m == null) {
            m = loadMap(KEY_AUDIO)
            audioCache = m
        }
        return m
    }

    private fun imageMap(): MutableMap<String, Entry> {
        var m = imageCache
        if (m == null) {
            m = loadMap(KEY_IMAGE)
            imageCache = m
        }
        return m
    }

    @Synchronized
    fun registerAudio(uri: Uri, name: String, size: Long): String {
        val id = Util.fnv1a(uri.toString())
        audioMap()[id] = Entry(id, uri.toString(), name, size)
        saveMap(KEY_AUDIO, audioMap())
        return id
    }

    @Synchronized
    fun registerImage(uri: Uri, name: String, size: Long): String {
        val id = "img_" + Util.fnv1a(uri.toString())
        imageMap()[id] = Entry(id, uri.toString(), name, size)
        saveMap(KEY_IMAGE, imageMap())
        return id
    }

    fun audio(id: String): Entry? = audioMap()[id]

    fun image(id: String): Entry? = imageMap()[id]

    fun audioListJson(): String {
        val arr = JSONArray()
        for (e in audioMap().values) {
            arr.put(JSONObject().put("id", e.id).put("name", e.name).put("size", e.size))
        }
        return arr.toString()
    }

    companion object {
        private const val KEY_AUDIO = "audio_map"
        private const val KEY_IMAGE = "image_map"
    }
}

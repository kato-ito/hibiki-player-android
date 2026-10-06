package com.zai.hibikiplayer

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * 下载曲目的标签与封面存储。
 *
 * 为什么需要它：杜比（E-AC-3）/ DTS 这类**裸流**容器装不下内嵌封面，
 * 往里写 ID3v2 又容易在不同播放器/系统组件上出现乱码与解析问题（实测过）。
 * 因此裸流文件保持**完全原始**（一个字节都不改），封面与标题 / UP主 / 专辑
 * 记在应用自己的存储里，播放界面与歌单都能正常显示。
 */
object TrackTags {

    private const val PREF = "hibiki_tags"

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREF, Context.MODE_PRIVATE)

    /** 封面文件（存应用缓存目录，随下载任务写入） */
    fun coverDir(context: Context): File {
        val d = File(context.cacheDir, "covers")
        if (!d.exists()) d.mkdirs()
        return d
    }

    fun coverFile(context: Context, id: String): File? {
        val f = File(coverDir(context), Util.fnv1a(id) + ".jpg")
        return if (f.exists() && f.length() > 0) f else null
    }

    /** 保存一首曲目的标签（cover 可为 null） */
    fun save(context: Context, id: String, title: String, artist: String, album: String, cover: ByteArray?) {
        try {
            var coverName = ""
            if (cover != null && cover.size > 100) {
                val f = File(coverDir(context), Util.fnv1a(id) + ".jpg")
                f.outputStream().use { it.write(cover) }
                coverName = f.name
            }
            val o = JSONObject()
                .put("title", title)
                .put("artist", artist)
                .put("album", album)
                .put("cover", coverName)
            prefs(context).edit().putString(id, o.toString()).apply()
        } catch (e: Exception) {
            // 标签保存失败不影响下载
        }
    }

    /** 读取标签；没有则返回 null */
    fun get(context: Context, id: String): JSONObject? {
        val raw = prefs(context).getString(id, null) ?: return null
        return try {
            JSONObject(raw)
        } catch (e: Exception) {
            null
        }
    }

    /** 补上封面 URL（供页面直接用作 <img>/background） */
    fun withCoverUrl(context: Context, id: String): JSONObject? {
        val o = get(context, id) ?: return null
        if (coverFile(context, id) != null) o.put("coverUrl", "/cover/" + id)
        return o
    }
}

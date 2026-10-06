package com.zai.hibikiplayer

/** 通用工具：扩展名识别 / 自然排序 / 哈希 */
object Util {

    private val AUDIO_EXTS = setOf(
        "mp3", "flac", "wav", "ogg", "oga", "opus", "m4a", "m4b", "mp4", "m4v",
        "aac", "wma", "aif", "aiff", "ape", "wv", "ac3", "eac3", "dts", "thd",
        "truehd", "mkv", "mka", "webm", "mid", "midi", "amr", "3gp"
    )

    fun ext(name: String): String {
        val i = name.lastIndexOf('.')
        return if (i >= 0 && i < name.length - 1) name.substring(i + 1).lowercase() else ""
    }

    fun isAudioName(name: String): Boolean = AUDIO_EXTS.contains(ext(name))

    fun isLrc(name: String): Boolean = name.lowercase().endsWith(".lrc")

    fun contentTypeFor(name: String): String = when (ext(name)) {
        "mp3" -> "audio/mpeg"
        "flac" -> "audio/flac"
        "wav" -> "audio/wav"
        "ogg", "oga" -> "audio/ogg"
        "opus" -> "audio/opus"
        "m4a", "m4b" -> "audio/mp4"
        "mp4", "m4v" -> "video/mp4"
        "aac" -> "audio/aac"
        "webm" -> "video/webm"
        "ac3" -> "audio/ac3"
        "eac3" -> "audio/eac3"
        "wma" -> "audio/x-ms-wma"
        "mid", "midi" -> "audio/midi"
        else -> "application/octet-stream"
    }

    fun imageTypeFor(name: String): String = when (ext(name)) {
        "png" -> "image/png"
        "webp" -> "image/webp"
        "gif" -> "image/gif"
        else -> "image/jpeg"
    }

    /** FNV-1a 32 位哈希：同一 URI 稳定得到同一 id */
    fun fnv1a(s: String): String {
        var h = 0x811c9dc5L
        for (b in s.toByteArray(Charsets.UTF_8)) {
            h = h xor (b.toLong() and 0xffL)
            h = (h * 0x01000193L) and 0xffffffffL
        }
        return h.toString(16)
    }

    /** 文件名自然排序（数字按数值比较，大小写不敏感） */
    fun naturalCompare(a: String, b: String): Int {
        var i = 0
        var j = 0
        while (i < a.length && j < b.length) {
            val ca = a[i]
            val cb = b[j]
            if (ca.isDigit() && cb.isDigit()) {
                var x = i
                var y = j
                while (x < a.length && a[x].isDigit()) x++
                while (y < b.length && b[y].isDigit()) y++
                val la = a.substring(i, x).trimStart('0').ifEmpty { "0" }
                val lb = b.substring(j, y).trimStart('0').ifEmpty { "0" }
                val cmp = when {
                    la.length != lb.length -> la.length - lb.length
                    else -> la.compareTo(lb)
                }
                if (cmp != 0) return cmp
                i = x
                j = y
            } else {
                val cmp = ca.lowercaseChar().compareTo(cb.lowercaseChar())
                if (cmp != 0) return cmp
                i++
                j++
            }
        }
        return (a.length - i) - (b.length - j)
    }
}

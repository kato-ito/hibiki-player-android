package com.zai.hibikiplayer

/**
 * B 站下载的**容器与命名规则**（纯函数，便于 JVM 单元测试，见 app/src/test/.../BiliNamingTest.kt）。
 *
 * 命名约定：
 *   · 单 P 视频    →  视频名.m4a
 *   · 合集 / 多 P  →  在下载文件夹里建一个以**视频名**命名的子文件夹，
 *                     子文件夹内的文件只用**分P名**（例如 `P3 正片.m4a`）
 *
 * 之所以把规则抽出来：文件名直接决定用户能不能认出来，必须有单元测试兜着。
 */
object BiliNaming {

    /** 音质编码 → 容器扩展名（只换容器，音频码流原样拷贝；杜比走 MP4 才能内嵌 covr 封面） */
    fun extFor(codec: String): String {
        val c = codec.lowercase()
        return when {
            c.contains("ec-3") || c.contains("eac3") -> "mp4"
            c.contains("flac") -> "flac"
            else -> "m4a"
        }
    }

    /** 容器扩展名 → 保存到手机时的文件名扩展名（MP4 容器统一叫 .m4a，避免 MediaStore 再补一次后缀） */
    fun displayExtFor(ext: String): String = if (ext == "mp4") "m4a" else ext

    /** 裸流容器（装不下 attached_pic 封面，封面与标签改由应用内记录） */
    private val RAW_EXTS = setOf(
        "eac3", "ac3", "dts", "dtshd", "dtsma", "thd", "truehd",
        "wma", "wmav2", "wmapro", "ape", "wv"
    )

    fun isRawStream(ext: String): Boolean = RAW_EXTS.contains(ext.lowercase())

    /** 文件名 → MediaStore MIME（必须与扩展名匹配，否则系统会再补一次后缀） */
    fun mimeFor(fileName: String): String = when {
        fileName.endsWith(".flac", true) -> "audio/flac"
        fileName.endsWith(".m4a", true) || fileName.endsWith(".mp4", true) -> "audio/mp4"
        fileName.endsWith(".eac3", true) -> "audio/eac3"
        fileName.endsWith(".ac3", true) -> "audio/ac3"
        fileName.endsWith(".dts", true) -> "audio/vnd.dts"
        else -> "audio/mpeg"
    }

    /** 去掉文件系统 / SAF 不接受的字符，压掉多余空白并限长（可返回空串） */
    fun safe(s: String, max: Int = 80): String {
        var base = s.trim()
            .replace(Regex("[\\\\/:*?\"<>|\r\n\t]"), "_")
            .replace(Regex("\\s+"), " ")
            .trim()
        if (base.length > max) base = base.substring(0, max).trim()
        return base
    }

    /**
     * 文件名主体（不含扩展名）
     * @param collection 是否合集（多 P）视频 —— 合集内只用分P名
     */
    fun baseName(title: String, part: String, page: Int, collection: Boolean): String {
        if (collection) {
            val p = safe(part, 60)
            if (p.isNotEmpty()) return p
            return "P" + (if (page > 0) page else 1)          // 分P名为空 → P1 / P2 …
        }
        var base = title.trim()
        if (part.isNotBlank() && part != title && part != "P1") base += " - " + part.trim()
        base = safe(base, 80)
        return base.ifEmpty { "bilibili_audio" }
    }

    /** 完整文件名（含扩展名） */
    fun fileName(title: String, part: String, page: Int, collection: Boolean, ext: String): String {
        val de = displayExtFor(ext)
        var base = baseName(title, part, page, collection)
        if (!base.endsWith("." + de, true)) base += "." + de
        return base
    }

    /** 合集子文件夹名；返回空字符串表示不建子文件夹 */
    fun folderName(title: String, collection: Boolean): String =
        if (collection) safe(title, 60) else ""

    /**
     * 写进文件的**标题标签**（播放器里显示的就是它）。
     * 合集内只显示分P名 —— 与文件名保持一致，播放器里不会再出现「视频名 - 分P名」这种长标题；
     * 单 P 视频保持原来的「视频名（必要时 - 分P名）」。标签不做文件系统过滤，冒号等原样保留。
     */
    fun metaTitle(title: String, part: String, page: Int, collection: Boolean): String {
        if (collection) {
            val p = part.trim()
            if (p.isNotEmpty()) return p
            return "P" + (if (page > 0) page else 1)
        }
        val t = title.trim()
        if (part.isNotBlank() && part != title && part != "P1") {
            return if (t.isEmpty()) part.trim() else t + " - " + part.trim()
        }
        return t.ifEmpty { part.trim() }
    }

    /**
     * 写进文件的**专辑标签**：合集用视频名（播放器里能把同一合集的分P归到一张专辑，
     * 标题缩短后也知道它们出自哪个合集），单 P 仍是 Bilibili。
     */
    fun metaAlbum(title: String, collection: Boolean): String =
        if (collection && title.isNotBlank()) title.trim() else "Bilibili"
}

package com.zai.hibikiplayer

import android.content.Context
import android.net.Uri
import com.arthenica.ffmpegkit.FFmpegKit
import com.arthenica.ffmpegkit.FFprobeKit
import com.arthenica.ffmpegkit.ReturnCode
import org.json.JSONObject
import java.io.File

/**
 * 杜比 / DTS 解码器：用内置 ffmpeg 把 AC-3 / E-AC-3 / TrueHD / DTS / WMA 等解码成 PCM WAV，
 * 交由页面通过本地 HTTP 服务（支持 Range）播放。
 *
 * 要点：
 *  - 结果按「文件 id + 大小 + 目标声道」缓存，240 MB 预算 LRU 淘汰（多声道 PCM 体积成倍增长）；
 *  - 输入优先使用本地副本（cache/src）：直接让 ffmpeg 读 http://127.0.0.1/audio/<id> 时，
 *    只要本地服务或 URI 读取有一点问题（MediaStore 权限 / SAF 目录 / 服务异常）就整体失败，
 *    报出来就是「HTTP 404」；复制成本地文件后解码链路只依赖应用私有目录，稳定得多；
 *  - 目标声道低于源声道时才加 -ac（否则保持原始布局直出，交给系统空间音效渲染）。
 */
class DolbyDecoder(
    private val context: Context,
    private val serverPort: Int,
    private val registry: Registry? = null
) {

    /** 解码进度回调（0~100） */
    @Volatile
    var onProgress: ((Int) -> Unit)? = null

    @Volatile
    private var cancelled = false

    /** 整体缓存预算（解码后的 PCM WAV 很占空间） */
    private val budgetBytes: Long = 240L * 1024 * 1024

    private val lock = Any()

    /** key -> 解码后的 WAV 文件（accessOrder = true，按最近使用排序） */
    private val cache = object : LinkedHashMap<String, File>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, File>): Boolean = false
    }

    /* ================= 缓存 ================= */

    fun fileFor(key: String): File? = synchronized(lock) {
        val f = cache[key]
        if (f != null && f.exists() && f.length() > 0) return f
        // 冷启动后缓存表是空的：按文件名回查一次（key 就是文件名前缀）
        val guess = File(outDir(), key + ".wav")
        if (guess.exists() && guess.length() > 0) {
            cache[key] = guess
            return guess
        }
        null
    }

    fun hasCached(id: String, size: Long, targetChannels: Int): Boolean =
        fileFor(cacheKey(id, size, targetChannels)) != null

    private fun cacheKey(id: String, size: Long, targetChannels: Int): String =
        Util.fnv1a(id + "|" + size + "|ac=" + targetChannels)

    private fun outDir(): File {
        val dir = File(context.cacheDir, "decoded")
        if (!dir.exists()) dir.mkdirs()
        return dir
    }

    /** 注册表中的文件大小（本地副本命名与缓存键都用它） */
    private fun sizeFor(id: String): Long = registry?.audio(id)?.size ?: 0L

    private fun sourceUrl(id: String) = "http://127.0.0.1:" + serverPort + "/audio/" + id

    /** 把源文件复制成本地缓存文件作为 ffmpeg 输入（失败返回 null，调用方回退到 HTTP 地址） */
    private fun localSource(id: String, size: Long): File? {
        val reg = registry?.audio(id) ?: return null
        val dir = File(context.cacheDir, "src")
        if (!dir.exists()) dir.mkdirs()
        val rawExt = reg.name.substringAfterLast('.', "bin")
        val ext = if (rawExt.length in 1..5) rawExt else "bin"
        val key = Util.fnv1a(id + "|" + (if (size > 0) size else reg.size))
        val out = File(dir, key + "." + ext)
        if (out.exists() && out.length() > 0) return out
        return try {
            context.contentResolver.openInputStream(Uri.parse(reg.uri))?.use { input ->
                out.outputStream().use { o -> input.copyTo(o) }
            } ?: return null
            if (out.length() > 0) out else null
        } catch (e: Exception) {
            try { out.delete() } catch (e2: Exception) { /* 忽略 */ }
            null
        }
    }

    /** 输入参数：本地副本优先，其次本地 HTTP 地址 */
    private fun inputOf(id: String, size: Long): String =
        localSource(id, size)?.absolutePath ?: sourceUrl(id)

    /* ================= 探测 ================= */

    /**
     * 读取音频流信息（编码 / 声道 / 声道布局 / 采样率 / 时长）。只读文件头，速度快；失败返回 null。
     */
    fun probe(id: String): JSONObject? {
        val size = sizeFor(id)
        return try {
            val session = FFprobeKit.executeWithArguments(
                arrayOf(
                    "-v", "error",
                    "-select_streams", "a:0",
                    "-show_entries", "stream=codec_name,channels,channel_layout,sample_rate,duration",
                    "-of", "json",
                    inputOf(id, size)
                )
            )
            val out = session?.output ?: return null
            val streams = JSONObject(out).optJSONArray("streams") ?: return null
            if (streams.length() == 0) return null
            val s = streams.getJSONObject(0)
            JSONObject()
                .put("codec", s.optString("codec_name"))
                .put("channels", s.optInt("channels", 0))
                .put("layout", s.optString("channel_layout"))
                .put("rate", s.optInt("sample_rate", 0))
                .put("duration", s.optDouble("duration", 0.0))
        } catch (e: Exception) {
            null
        }
    }

    /* ================= 解码 ================= */

    /**
     * 解码为 PCM WAV。
     * @param targetChannels 目标声道数；0 表示保持源布局（不降混）
     */
    fun decode(id: String, label: String, size: Long, targetChannels: Int): JSONObject {
        val key = cacheKey(id, size, targetChannels)
        fileFor(key)?.let { cached ->
            return describe(key, cached, targetChannels, probe(id))
        }

        cancelled = false
        val info = probe(id)
        val srcCh = info?.optInt("channels", 0) ?: 0
        val codec = info?.optString("codec", "") ?: ""
        val layout = info?.optString("layout", "") ?: ""

        val out = File(outDir(), key + ".wav")
        val tmp = File(outDir(), key + ".part")
        if (tmp.exists()) tmp.delete()

        // 只有目标声道低于源声道时才需要 -ac（否则保持原布局直出）
        val ac = if (targetChannels > 0 && (srcCh == 0 || targetChannels < srcCh)) targetChannels else 0

        var finished = false
        val args = ArrayList<String>(16)
        args.add("-hide_banner")
        args.add("-nostdin")
        args.add("-y")
        args.add("-i")
        args.add(inputOf(id, size))
        args.add("-map")
        args.add("0:a:0")
        args.add("-vn")
        if (ac > 0) {
            args.add("-ac")
            args.add(ac.toString())
        }
        args.add("-f")
        args.add("wav")
        args.add("-acodec")
        args.add("pcm_s16le")
        args.add(tmp.absolutePath)

        // 进度：同步 API 拿不到统计回调，改为解码期间按临时文件体积估算
        val srcRate = (info?.optInt("rate", 0) ?: 0).let { if (it > 0) it else 48000 }
        val expectBytes = (info?.optDouble("duration", 0.0) ?: 0.0) *
            (if (ac > 0) ac else (if (srcCh > 0) srcCh else 2)).toDouble() * srcRate.toDouble() * 2.0
        val monitor = Thread {
            while (!finished) {
                try {
                    if (expectBytes > 0 && tmp.exists()) {
                        val pct = (tmp.length() / expectBytes * 100).toInt().coerceIn(0, 99)
                        onProgress?.invoke(pct)
                    }
                } catch (e: Exception) { /* 忽略 */ }
                try { Thread.sleep(220) } catch (e: InterruptedException) { break }
            }
        }
        monitor.isDaemon = true
        monitor.start()
        val session = try {
            FFmpegKit.executeWithArguments(args.toTypedArray())
        } catch (e: Exception) {
            null
        } finally {
            finished = true
        }

        if (cancelled) {
            tmp.delete()
            throw IllegalStateException("已取消解码")
        }
        val rc = session?.returnCode
        if (rc == null || !ReturnCode.isSuccess(rc)) {
            tmp.delete()
            val tail = (session?.output ?: "").trim().lines().filter { it.isNotBlank() }.takeLast(2).joinToString(" / ")
            val srcNote = if (localSource(id, size) == null) "（源文件不可读）" else ""
            throw IllegalStateException("解码失败" + srcNote + "：" + (tail.ifBlank { "未知错误" }))
        }
        if (out.exists()) out.delete()
        if (!tmp.renameTo(out)) {
            tmp.delete()
            throw IllegalStateException("无法写入解码缓存")
        }
        synchronized(lock) { cache[key] = out }
        onProgress?.invoke(100)

        // 先取描述（要读文件头），再淘汰旧缓存；当前这条永不参与淘汰 ——
        // 否则单条 PCM 就超过预算时（5.1@96k 约 3.6 分钟以上）会把刚解码好的文件立刻删掉，
        // 页面随后请求 /decoded/<key> 只能拿到 404，表现为「解码失败」。
        val result = describe(key, out, targetChannels, info)
        if (codec.isNotEmpty()) result.put("codec", codec)
        if (layout.isNotEmpty()) result.put("layout", layout)
        result.put("sourceChannels", srcCh)
        result.put("target", ac)
        result.put("label", label)
        trimCache(protectedKey = key)
        return result
    }

    /** 取消进行中的解码 */
    fun cancel() {
        cancelled = true
        try { FFmpegKit.cancel() } catch (e: Exception) { /* 忽略 */ }
    }

    /* ================= 描述 / 缓存淘汰 ================= */

    private fun describe(key: String, file: File, targetChannels: Int, info: JSONObject?): JSONObject {
        val fmt = WavFmt.read(file)
        val ch = fmt?.channels ?: targetChannels
        val rate = fmt?.rate ?: (info?.optInt("rate", 0) ?: 0)
        val bytes = if (fmt != null && fmt.dataBytes > 0) fmt.dataBytes else file.length()
        val duration = if (rate > 0 && ch > 0) bytes.toDouble() / (rate.toDouble() * ch * 2) else 0.0
        return JSONObject()
            .put("key", key)
            .put("url", "/decoded/" + key)
            .put("channels", ch)
            .put("rate", rate)
            .put("bytes", bytes)
            .put("duration", duration)
            .put("file", file.absolutePath)
    }

    /** 超出预算时按最近最少使用淘汰；protectedKey（刚解码完成 / 正在播放的那条）不淘汰 */
    private fun trimCache(protectedKey: String? = null) {
        synchronized(lock) {
            var total = 0L
            for (f in cache.values) total += (if (f.exists()) f.length() else 0L)
            if (total <= budgetBytes) return
            val it = cache.entries.iterator()
            while (total > budgetBytes && it.hasNext()) {
                val e = it.next()
                if (e.key == protectedKey) continue          // 保底：绝不让当前这个文件被自己删掉
                val len = if (e.value.exists()) e.value.length() else 0L
                try { e.value.delete() } catch (ex: Exception) { /* 忽略 */ }
                total -= len
                it.remove()
            }
        }
    }
}

/** 读取 WAV 头（RIFF/fmt/data），用实际数据量推算时长 / 声道 / 采样率 */
object WavFmt {
    class Info(val channels: Int, val rate: Int, val dataBytes: Long)

    fun read(file: File): Info? {
        return try {
            val head = ByteArray(4096)
            val n = file.inputStream().use { it.read(head) }
            if (n < 44) return null
            if (String(head, 0, 4, Charsets.US_ASCII) != "RIFF") return null
            var off = 12
            var ch = 0
            var rate = 0
            while (off + 8 <= n) {
                val id = String(head, off, 4, Charsets.US_ASCII)
                val size = le32(head, off + 4)
                when (id) {
                    "fmt " -> {
                        ch = le16(head, off + 10)
                        rate = le32(head, off + 12)
                    }
                    "data" -> {
                        var dataBytes = size.toLong()
                        val actual = file.length() - (off + 8)
                        if (dataBytes <= 0 || dataBytes > actual) dataBytes = actual
                        return Info(ch, rate, dataBytes)
                    }
                }
                off += 8 + size + (size and 1)
            }
            null
        } catch (e: Exception) {
            null
        }
    }

    private fun le16(b: ByteArray, o: Int): Int =
        (b[o].toInt() and 0xff) or ((b[o + 1].toInt() and 0xff) shl 8)

    private fun le32(b: ByteArray, o: Int): Int =
        (b[o].toInt() and 0xff) or ((b[o + 1].toInt() and 0xff) shl 8) or
            ((b[o + 2].toInt() and 0xff) shl 16) or ((b[o + 3].toInt() and 0xff) shl 24)
}

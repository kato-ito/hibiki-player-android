package com.zai.hibikiplayer

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import com.arthenica.ffmpegkit.FFmpegKit
import com.arthenica.ffmpegkit.ReturnCode
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/**
 * B 站音频下载任务管理：
 *   下载 DASH 音频流 → 内置 ffmpeg 无损封装（AAC→M4A、Hi-Res→FLAC、杜比→EAC3）
 *   → 写入手机「音乐/Hibiki Player」→ 登记进文件注册表（可直接加入歌单播放）。
 *
 * 与桌面版一致：不重编码（仅流拷贝），写入 标题 / UP主 / 专辑 / 来源 标签，可选内嵌封面。
 */
class BiliDownloader(
    private val context: Context,
    private val api: BiliApi,
    private val registry: Registry
) {

    class Task(
        val id: String,
        val bvid: String,
        val cid: Long,
        val title: String,
        val part: String,
        val owner: String,
        val qualityId: Int,
        val qualityLabel: String,
        val codec: String,
        val url: String,
        val backups: List<String>,
        val referer: String,
        val pic: String,
        val dirUri: String = "",              // SAF 目录树（空 = 默认 音乐/Hibiki Player）
        val speedKbps: Int = 0,               // 限速（KB/s，0 = 不限）
        val page: Int = 0,                    // 分P序号（1 起；0 = 未知）
        val folder: String = ""               // 合集（多 P）时为视频名 → 建同名子文件夹，文件名只用分P名
    ) {
        @Volatile var state: String = "pending"     // pending|downloading|muxing|done|error|cancelled
        @Volatile var bytes: Long = 0
        @Volatile var total: Long = 0
        @Volatile var speed: Double = 0.0           // 字节/秒
        @Volatile var message: String = ""
        @Volatile var fileName: String = ""
        @Volatile var savedPath: String = ""
        @Volatile var entryId: String = ""
        @Volatile var entrySize: Long = 0
        @Volatile var cancelled: Boolean = false

        fun toJson(): JSONObject = JSONObject()
            .put("id", id)
            .put("title", title)
            .put("part", part)
            .put("owner", owner)
            .put("quality", qualityLabel)
            .put("codec", codec)
            .put("state", state)
            .put("bytes", bytes)
            .put("total", total)
            .put("speed", speed)
            .put("message", message)
            .put("fileName", fileName)
            .put("entryId", entryId)
            .put("entrySize", entrySize)
            .put("savedPath", savedPath)
            .put("entryName", fileName)
    }

    private val tasks = LinkedHashMap<String, Task>()
    private val lock = Any()
    private val pool = Executors.newFixedThreadPool(2)
    private val cacheDir: File by lazy {
        val d = File(context.cacheDir, "bili")
        if (!d.exists()) d.mkdirs()
        d
    }

    /** 任务状态变化回调（推送给页面） */
    @Volatile var onUpdate: ((Task) -> Unit)? = null

    @Volatile var activeCount: Int = 0
        private set

    fun list(): JSONArray {
        val out = JSONArray()
        synchronized(lock) {
            for (t in tasks.values) out.put(t.toJson())
        }
        return out
    }

    fun get(taskId: String): Task? = synchronized(lock) { tasks[taskId] }

    fun clearFinished() {
        synchronized(lock) {
            val it = tasks.entries.iterator()
            while (it.hasNext()) {
                val s = it.next().value.state
                if (s == "done" || s == "error" || s == "cancelled") it.remove()
            }
        }
    }

    fun cancel(taskId: String) {
        val t = get(taskId) ?: return
        t.cancelled = true
        if (t.state == "muxing") {
            try { FFmpegKit.cancel() } catch (e: Throwable) {}
        }
        if (t.state == "pending") {
            t.state = "cancelled"
            notify(t)
        }
    }

    /** 新建下载任务 */
    fun start(
        bvid: String, cid: Long, title: String, part: String, owner: String,
        qualityId: Int, qualityLabel: String, codec: String,
        url: String, backups: List<String>, pic: String,
        dirUri: String = "", speedKbps: Int = 0, page: Int = 0, folder: String = ""
    ): Task {
        val id = "t" + java.lang.Long.toString(System.currentTimeMillis(), 36) +
            java.lang.Double.toHexString(Math.random()).substring(2, 6)
        val t = Task(
            id = id, bvid = bvid, cid = cid, title = title, part = part, owner = owner,
            qualityId = qualityId, qualityLabel = qualityLabel, codec = codec,
            url = url, backups = backups, referer = "https://www.bilibili.com/video/" + bvid, pic = pic,
            dirUri = dirUri, speedKbps = speedKbps, page = page, folder = folder
        )
        synchronized(lock) { tasks[id] = t }
        notify(t)
        pool.execute { run(t) }
        return t
    }

    private fun notify(t: Task) {
        if (t.state == "downloading" || t.state == "muxing") activeCount = countActive() else activeCount = countActive()
        try { onUpdate?.invoke(t) } catch (e: Throwable) {}
    }

    private fun countActive(): Int = synchronized(lock) {
        tasks.values.count { it.state == "pending" || it.state == "downloading" || it.state == "muxing" }
    }

    /* ================= 任务执行 ================= */

    private fun run(t: Task) {
        val rawFile = File(cacheDir, t.id + ".m4s")
        val coverFile = File(cacheDir, t.id + ".jpg")
        try {
            t.state = "downloading"
            notify(t)
            val urls = ArrayList<String>()
            urls.add(t.url)
            urls.addAll(t.backups)
            var lastError: Exception? = null
            var ok = false
            for ((idx, u) in urls.withIndex()) {
                if (t.cancelled) break
                try {
                    downloadWithProgress(t, u, rawFile)
                    ok = true
                    break
                } catch (e: InterruptedException) {
                    throw e
                } catch (e: Exception) {
                    lastError = e
                    if (idx < urls.size - 1) t.message = "主线路失败，切换备用线路…"
                }
            }
            if (t.cancelled) { t.state = "cancelled"; notify(t); return }
            if (!ok) throw (lastError ?: IllegalStateException("下载失败"))

            // 封面（可选，失败不影响下载）
            if (t.pic.isNotBlank()) {
                try {
                    api.download(t.pic, t.referer, coverFile, { _, _ -> }, { t.cancelled })
                } catch (e: Exception) {
                    coverFile.delete()
                }
            }

            t.state = "muxing"
            t.message = "正在封装…"
            notify(t)

            // 合集（多 P）视频：在下载文件夹里建「视频名」子文件夹，文件名只用分P名
            val collection = t.folder.isNotBlank()
            val sub = BiliNaming.folderName(t.folder, collection)
            var ext = BiliNaming.extFor(t.codec)
            var fileName = BiliNaming.fileName(t.title, t.part, t.page, collection, ext)
            var muxed = File(cacheDir, t.id + "." + ext)
            if (BiliNaming.isRawStream(ext)) {
                // 裸流：ffmpeg 只能写单流，封面与标签记在应用内（音频码流原样不动）
                rawToRaw(t, rawFile, coverFile, muxed, ext)
            } else {
                try {
                    mux(t, rawFile, coverFile, muxed, ext)
                } catch (e: InterruptedException) {
                    throw e
                } catch (e: Exception) {
                    // MP4 容器封装失败（个别码流 / 个别机型）→ 退回裸流，保证至少能播
                    if (ext != "mp4") throw e
                    ext = "eac3"
                    fileName = BiliNaming.fileName(t.title, t.part, t.page, collection, ext)
                    muxed = File(cacheDir, t.id + "." + ext)
                    rawToRaw(t, rawFile, coverFile, muxed, ext)
                }
            }

            t.state = "muxing"
            t.message = "正在保存到手机…"
            notify(t)
            // 保存后读回 MediaStore 实际使用的文件名：个别容器类型会被系统追加一次扩展名
            //（曾出现 x.mp4.m4a / x.eac3.eac3），以实际文件名为准可避免歌单里出现重复后缀
            val saved = try {
                if (t.dirUri.isNotBlank()) publishToTree(t.dirUri, muxed, fileName, sub) else publish(muxed, fileName, sub)
            } catch (e: Exception) {
                // 公共目录写不进去或写进去读不出来（个别容器类型）→ 落到应用私有目录，保证能播
                t.message = "已改存到应用目录（" + (e.message ?: "公共目录不可用") + "）"
                publishFallback(muxed, fileName, sub)
            }
            t.savedPath = saved.displayPath

            // 登记进文件注册表 → 可直接加入歌单播放
            val realName = queryDisplayName(saved.uri) ?: fileName
            val entryId = registry.registerAudio(saved.uri, realName, saved.size)
            // 标签在应用内再存一份：裸流只能靠它；MP4 万一某些组件读不出 covr 也能照常显示
            val coverBytes = if (coverFile.exists() && coverFile.length() > 0) coverFile.readBytes() else null
            TrackTags.save(context, entryId,
                BiliNaming.metaTitle(t.title, t.part, t.page, collection),
                t.owner, BiliNaming.metaAlbum(t.title, collection), coverBytes)
            t.entryId = entryId
            t.entrySize = saved.size
            t.fileName = realName
            t.bytes = saved.size
            t.total = saved.size
            t.state = "done"
            t.message = "已保存到 " + saved.displayPath
            notify(t)
        } catch (e: InterruptedException) {
            t.state = "cancelled"
            t.message = "已取消"
            notify(t)
        } catch (e: Throwable) {
            t.state = "error"
            t.message = e.message ?: "下载失败"
            notify(t)
        } finally {
            try { rawFile.delete() } catch (e: Exception) {}
            try { coverFile.delete() } catch (e: Exception) {}
            for (e2 in arrayOf("mp4", "m4a", "flac", "eac3")) {
                try { File(cacheDir, t.id + "." + e2).delete() } catch (e: Exception) {}
            }
        }
    }

    private fun downloadWithProgress(t: Task, url: String, target: File) {
        var lastBytes = 0L
        var lastTime = System.currentTimeMillis()
        api.download(url, t.referer, target, { got, total ->
            t.bytes = got
            t.total = total
            val now = System.currentTimeMillis()
            val dt = now - lastTime
            if (dt >= 500) {
                t.speed = (got - lastBytes) * 1000.0 / dt
                lastBytes = got
                lastTime = now
            }
            notify(t)
        }, { t.cancelled }, t.speedKbps)
    }

    /**
     * 裸流封装（E-AC-3 / AC-3 / DTS …）：用 ffmpeg 只做「换封装 / 原样拷贝」拿到干净的裸流，
     * 然后把 ID3v2.3 标签（标题 / UP主 / 专辑 / 封面）前置到文件头。
     * 好处：音频码流与容器保持原始（杜比仍是 .eac3），同时带上封面与标签。
     * 实测：ffmpeg 会跳过前置 ID3v2 正常识别 eac3 流并解码（见 tests/verify-bili-pipeline.js 说明）。
     */
    private fun rawToRaw(t: Task, input: File, cover: File, output: File, ext: String) {
        if (output.exists()) output.delete()
        val args = ArrayList<String>()
        args.add("-hide_banner"); args.add("-nostdin"); args.add("-y")
        args.add("-i"); args.add(input.absolutePath)
        args.add("-map"); args.add("0:a:0")
        args.add("-c:a"); args.add("copy")
        args.add("-f"); args.add(if (ext == "eac3") "eac3" else ext)
        args.add(output.absolutePath)
        val session = FFmpegKit.executeWithArguments(args.toTypedArray())
        val rc = session?.returnCode
        if (rc == null || !ReturnCode.isSuccess(rc)) {
            if (t.cancelled) throw InterruptedException("已取消")
            val detail = (session?.output ?: "").trim().lines().lastOrNull { it.isNotBlank() } ?: "未知错误"
            throw IllegalStateException("封装失败：" + detail)
        }
        if (!output.exists() || output.length() <= 0) throw IllegalStateException("封装失败：输出为空")
        // 裸流保持**完全原始**：不写 ID3v2。
        // 理由（实测）：往裸流前置 ID3v2 后，不同系统组件读取时中文标签会出现乱码，
        // 而且文件头被改写后个别机型上还会影响读写；封面与标签改由 TrackTags 记在应用内，
        // 歌单 / 播放界面照常显示标题、UP主、专辑与封面。
    }

    /** ffmpeg 无损封装 + 标签 +（可选）内嵌封面 */
    private fun mux(t: Task, input: File, cover: File, output: File, ext: String) {
        if (output.exists()) output.delete()
        val args = ArrayList<String>()
        args.add("-hide_banner"); args.add("-nostdin"); args.add("-y")
        args.add("-i"); args.add(input.absolutePath)
        // M4A / MP4 / FLAC 支持 attached_pic（MP4 会写成 covr 封面）；裸流走 rawToRaw
        val withCover = cover.exists() && cover.length() > 0 && (ext == "m4a" || ext == "mp4" || ext == "flac")
        if (withCover) { args.add("-i"); args.add(cover.absolutePath) }
        args.add("-map"); args.add("0:a:0")
        if (withCover) {
            args.add("-map"); args.add("1:v")
            args.add("-c:v"); args.add("copy")
            args.add("-disposition:v"); args.add("attached_pic")
        }
        args.add("-c:a"); args.add("copy")
        if (ext == "eac3") { args.add("-f"); args.add("eac3") }
        // MP4 必须显式指定容器：.m4a 默认 ipod brand 不接受 ec-3（E-AC-3）
        if (ext == "mp4") { args.add("-f"); args.add("mp4") }

        // 合集内标题只用分P名（与文件名一致），专辑写视频名 —— 播放器里不再显示「视频名 - 分P名」
        val collection = t.folder.isNotBlank()
        args.add("-metadata"); args.add("title=" + BiliNaming.metaTitle(t.title, t.part, t.page, collection))
        args.add("-metadata"); args.add("artist=" + t.owner)
        args.add("-metadata"); args.add("album=" + BiliNaming.metaAlbum(t.title, collection))
        args.add("-metadata"); args.add("comment=" + t.referer)
        args.add(output.absolutePath)
        val session = FFmpegKit.executeWithArguments(args.toTypedArray())
        val rc = session?.returnCode
        if (rc == null || !ReturnCode.isSuccess(rc)) {
            if (t.cancelled) throw InterruptedException("已取消")
            val detail = (session?.output ?: "").trim().split('\n').lastOrNull { it.isNotBlank() } ?: "未知错误"
            throw IllegalStateException("封装失败：" + detail)
        }
        if (!output.exists() || output.length() <= 0) throw IllegalStateException("封装失败：输出为空")
    }

    private class Saved(val uri: Uri, val size: Long, val displayPath: String)

    /**
     * 写入用户选择的文件夹（SAF 目录树；同名时自动加序号，Android 5.0+ 通用、无需存储权限）。
     * @param sub 合集的子文件夹名（空 = 直接写在所选文件夹里）
     */
    private fun publishToTree(treeUri: String, file: File, fileName: String, sub: String): Saved {
        val tree = Uri.parse(treeUri)
        val mime = Util.contentTypeFor(fileName).substringBefore(";")
        val resolver = context.contentResolver
        var parent = tree
        if (sub.isNotBlank()) {
            // 子文件夹建不出来就退回写在所选文件夹里（不能让整个下载失败）
            val dir = ensureSubDir(tree, sub) ?: tree
            parent = dir
        }
        var name = fileName
        var created: Uri? = null
        var attempt = 0
        while (created == null && attempt < 20) {
            try {
                created = android.provider.DocumentsContract.createDocument(resolver, parent, mime, name)
            } catch (e: Exception) {
                attempt++
                val dot = fileName.lastIndexOf('.')
                name = if (dot > 0) fileName.substring(0, dot) + " (" + attempt + ")" + fileName.substring(dot)
                else fileName + " (" + attempt + ")"
            }
        }
        val uri = created ?: throw IllegalStateException("无法写入所选文件夹")
        resolver.openOutputStream(uri)?.use { out ->
            file.inputStream().use { input -> input.copyTo(out) }
        } ?: throw IllegalStateException("无法写入所选文件夹")
        val display = try {
            android.provider.DocumentsContract.getTreeDocumentId(tree).substringAfterLast(':')
        } catch (e: Exception) {
            "所选文件夹"
        }
        val prefix = if (parent === tree) "" else sub + "/"
        return Saved(uri, file.length(), display + "/" + prefix + name)
    }

    /**
     * 在 SAF 目录树里找到（或新建）名为 name 的子文件夹，返回可直接作为父目录的文档 Uri。
     * 已存在时复用：「合集名」只建一次，再下同一合集的分P不会变成「合集名 (1)」。
     */
    private fun ensureSubDir(tree: Uri, name: String): Uri? {
        val resolver = context.contentResolver
        val docs = android.provider.DocumentsContract::class.java
        return try {
            val rootDocId = android.provider.DocumentsContract.getTreeDocumentId(tree)
            val children = android.provider.DocumentsContract.buildChildDocumentsUriUsingTree(tree, rootDocId)
            val cols = arrayOf(
                android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                android.provider.DocumentsContract.Document.COLUMN_MIME_TYPE,
                android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID
            )
            resolver.query(children, cols, null, null, null)?.use { c ->
                while (c.moveToNext()) {
                    val isDir = c.getString(1) == android.provider.DocumentsContract.Document.MIME_TYPE_DIR
                    if (isDir && c.getString(0).equals(name, ignoreCase = true)) {
                        return android.provider.DocumentsContract.buildDocumentUriUsingTree(tree, c.getString(2))
                    }
                }
            }
            val parent = android.provider.DocumentsContract.buildDocumentUriUsingTree(tree, rootDocId)
            android.provider.DocumentsContract.createDocument(
                resolver, parent, android.provider.DocumentsContract.Document.MIME_TYPE_DIR, name
            )
        } catch (e: Exception) {
            null
        }
    }

    /** 写入手机音乐目录：Android 10+ 用 MediaStore（免存储权限），更低版本写公共音乐目录 */
    private fun publish(file: File, fileName: String, sub: String): Saved {
        // MediaStore 要求 DISPLAY_NAME 的扩展名与 MIME 匹配，否则会自动再补一次后缀
        //（audio/mp4 + "x.mp4" 曾被补成 "x.mp4.m4a"，文件在歌单里就认不出来了）。
        // 这里让两者严格一致，写完再读回实际文件名核对；被改写或读不回来就作废这条记录，
        // 由上层改存应用目录（publishFallback），保证歌单里的文件名永远是对的。
        val mime = BiliNaming.mimeFor(fileName)
        val wantExt = fileName.substringAfterLast('.', "").lowercase()
        val relDir = "Hibiki Player" + (if (sub.isBlank()) "" else "/" + sub)     // 合集：音乐/Hibiki Player/<视频名>/
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Audio.Media.DISPLAY_NAME, fileName)
                put(MediaStore.Audio.Media.MIME_TYPE, mime)
                put(MediaStore.Audio.Media.RELATIVE_PATH, Environment.DIRECTORY_MUSIC + "/" + relDir)
                put(MediaStore.Audio.Media.IS_MUSIC, 1)
                put(MediaStore.Audio.Media.IS_PENDING, 1)
            }
            val resolver = context.contentResolver
            val uri = resolver.insert(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, values)
                ?: throw IllegalStateException("无法写入手机音乐目录")
            try {
                resolver.openOutputStream(uri)?.use { out ->
                    file.inputStream().use { input -> input.copyTo(out) }
                } ?: throw IllegalStateException("无法写入文件")
                values.clear()
                values.put(MediaStore.Audio.Media.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
                val actual = queryDisplayName(uri) ?: fileName
                if (wantExt.isNotEmpty() && !actual.lowercase().endsWith("." + wantExt)) {
                    throw IllegalStateException("系统改写了文件名：" + actual)
                }
                if (!canRead(uri)) throw IllegalStateException("写入后无法读回")
                return Saved(uri, file.length(), "音乐/" + relDir + "/" + actual)
            } catch (e: Exception) {
                try { resolver.delete(uri, null, null) } catch (e2: Exception) {}
                throw e
            }
        }
        // Android 9 及以下：公共音乐目录（需要 WRITE_EXTERNAL_STORAGE，由 Activity 预先申请）
        var dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC), "Hibiki Player")
        if (sub.isNotBlank()) dir = File(dir, sub)
        if (!dir.exists() && !dir.mkdirs()) throw IllegalStateException("无法创建音乐目录")
        val out = File(dir, fileName)
        file.inputStream().use { input -> out.outputStream().use { o -> input.copyTo(o) } }
        return Saved(Uri.fromFile(out), out.length(), "音乐/" + relDir + "/" + fileName)
    }

    /** 读回 MediaStore 实际写入的文件名（个别容器会被系统追加一次扩展名） */
    private fun queryDisplayName(uri: Uri): String? {
        return try {
            context.contentResolver.query(uri, arrayOf(android.provider.MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0) else null
            }
        } catch (e: Exception) {
            null
        }
    }
    /** 能否读回（MediaStore 对少数容器/MIME 组合会给出打不开的 URI，表现为播放时 HTTP 404） */
    private fun canRead(uri: Uri): Boolean {
        return try {
            context.contentResolver.openInputStream(uri)?.use { input -> input.read(ByteArray(8)) >= 0 } ?: false
        } catch (e: Exception) {
            false
        }
    }

    /** 兜底保存：写进应用私有目录（无需权限、必定可读；合集照样建子文件夹） */
    private fun publishFallback(file: File, fileName: String, sub: String): Saved {
        var dir = File(context.getExternalFilesDir(null), "HibikiPlayer")
        if (sub.isNotBlank()) dir = File(dir, sub)
        if (!dir.exists() && !dir.mkdirs()) throw IllegalStateException("无法创建保存目录")
        val out = File(dir, fileName)
        file.inputStream().use { input -> out.outputStream().use { o -> input.copyTo(o) } }
        val prefix = if (sub.isBlank()) "" else sub + "/"
        return Saved(Uri.fromFile(out), out.length(), "HibikiPlayer/" + prefix + fileName)
    }
}








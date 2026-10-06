package com.zai.hibikiplayer

import android.Manifest
import android.app.Activity
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.database.Cursor
import android.os.Build
import android.view.WindowManager
import android.net.Uri
import android.os.Bundle
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.ByteArrayOutputStream
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

/**
 * Hibiki Player（安卓版）主 Activity：
 * - 本地 HTTP 服务托管页面与音频（支持 Range，进度条即时跳转）
 * - WebView + JS 桥（SAF 文件/文件夹/图片选择、歌词读取、导入列表）
 * - 麦克风权限（可视化用）、旋转不重建（播放不中断）、返回键优先关闭界面层
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var registry: Registry
    private var server: LocalHttpServer? = null
    private var bridge: Bridge? = null
    private var decoder: DolbyDecoder? = null
    private var biliApi: BiliApi? = null
    private var bili: BiliDownloader? = null
    private var lastClip: String = ""
    private var pendingLink: Pair<String, String>? = null      // (链接, 来源) 页面未就绪时暂存
    private var pendingBiliStart: Pair<String, String>? = null // 待存储权限放行的下载请求
    private var pendingQrImage: Pair<String, String>? = null   // 待存储权限放行的二维码保存请求

    private data class PendingPick(val requestId: String, val kind: String)

    private var pendingPick: PendingPick? = null
    private var pendingPermissionRequest: PermissionRequest? = null

    companion object {
        private const val REQ_FILES = 1001
        private const val REQ_FOLDER = 1002
        private const val REQ_IMAGE = 1003
        private const val REQ_TEXT = 1004
        private const val REQ_TREE = 1005
        private const val REQ_MIC = 2001
        private const val REQ_STORAGE = 2002
        private const val WWW_VERSION = "2.30.0"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        webView = findViewById(R.id.webview)
        registry = Registry(this)

        val prefs = getSharedPreferences("hibiki_http", MODE_PRIVATE)
        val preferred = prefs.getInt("port", 41421)
        val srv = LocalHttpServer(this, contentResolver, registry)
        val port = try {
            srv.start(preferred)
        } catch (e: Exception) {
            srv.start(1024 + (Math.random() * 40000).toInt())
        }
        server = srv
        prefs.edit().putInt("port", port).apply()

        // 杜比 / DTS 解码器：解码结果通过 /decoded/<key> 交给页面播放
        val dec = DolbyDecoder(this, port, registry)
        srv.decodedLookup = { key -> dec.fileFor(key) }
        decoder = dec

        // B 站音频下载：接口 + 任务管理（下载完成后自动登记，可加入歌单）
        val ba = BiliApi(this)
        biliApi = ba
        // 页面把 B 站图床的 <img> 指向本地 /biliimg/<base64url>，
        // 由原生带 UA + bilibili Referer 取图（外站 Referer 会被图床 403）
        srv.imageProxy = { key -> ba.imageFor(key) }
        // 下载曲目的封面（裸流容器装不下内嵌封面，由 TrackTags 存到应用内）
        srv.coverLookup = { id -> TrackTags.coverFile(this, id) }
        val dl = BiliDownloader(this, ba, registry)
        dl.onUpdate = { task ->
            runOnUiThread {
                try {
                    bridge?.biliTask(task.toJson().toString())
                    // 下载期间保持屏幕常亮，避免息屏后被系统回收进程
                    if (dl.activeCount > 0) {
                        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    } else {
                        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    }
                } catch (e: Exception) {
                }
            }
        }
        bili = dl

        extractWwwAssets()
        configureWebView()
        val b = Bridge(this, webView, registry)
        bridge = b
        webView.addJavascriptInterface(b, "AndroidBridge")
        webView.loadUrl("http://127.0.0.1:" + port + "/")
        handleIncomingIntent(intent)
    }

    /* ================= 外部链接（分享进入 / 剪贴板探测） ================= */

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingIntent(intent)
    }

    /** 从「B 站 App → 分享 → Hibiki Player」或 ACTION_VIEW 链接进入 */
    private fun handleIncomingIntent(intent: Intent?) {
        if (intent == null) return
        val action = intent.action ?: return
        var text: String? = null
        if (action == Intent.ACTION_SEND && intent.type != null && intent.type!!.startsWith("text/")) {
            text = intent.getStringExtra(Intent.EXTRA_TEXT)
        } else if (action == Intent.ACTION_VIEW) {
            text = intent.dataString
        }
        if (text.isNullOrBlank()) return
        val link = biliApi?.extractLink(text) ?: return
        pushLink(link, "share")
    }

    /** 页面未加载完时先暂存，加载完成后补推 */
    private fun pushLink(link: String, source: String) {
        val b = bridge
        if (b == null) {
            pendingLink = link to source
        } else {
            b.biliLink(link, source)
        }
    }

    private fun flushPendingLink() {
        val p = pendingLink ?: return
        pendingLink = null
        bridge?.biliLink(p.first, p.second)
    }

    /** 回到前台时探测剪贴板里的 B 站链接（手机常见用法：B 站复制链接 → 切回来） */
    private fun checkClipboard() {
        try {
            val cm = getSystemService(CLIPBOARD_SERVICE) as? ClipboardManager ?: return
            val clip = cm.primaryClip ?: return
            if (clip.itemCount <= 0) return
            val text = clip.getItemAt(0).coerceToText(this)?.toString() ?: return
            if (text.isBlank() || text == lastClip) return
            lastClip = text
            val link = biliApi?.extractLink(text) ?: return
            pushLink(link, "clipboard")
        } catch (e: Exception) {
            // 部分系统在后台限制读取剪贴板，忽略即可
        }
    }

    override fun onDestroy() {
        try {
            server?.stop()
        } catch (e: Exception) {
        }
        server = null
        super.onDestroy()
    }

    override fun onPause() {
        super.onPause()
        try {
            webView.onPause()
        } catch (e: Exception) {
        }
    }

    override fun onResume() {
        super.onResume()
        try {
            webView.onResume()
        } catch (e: Exception) {
        }
        bridge?.resumed()
        checkClipboard()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_MIC) {
            val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
            val req = pendingPermissionRequest
            pendingPermissionRequest = null
            if (req != null) {
                if (granted) req.grant(req.resources) else req.deny()
            }
        } else if (requestCode == REQ_STORAGE) {
            val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
            val pend = pendingBiliStart
            pendingBiliStart = null
            val pendQr = pendingQrImage
            pendingQrImage = null
            if (granted) {
                if (pendQr != null) doSaveQrImage(pendQr.first, pendQr.second)
                if (pend != null) doStartBiliDownload(pend.first, pend.second)
            } else {
                if (pendQr != null) bridge?.resolve(pendQr.first, false, "需要存储权限才能保存到相册")
                if (pend != null) bridge?.resolve(pend.first, false, "需要存储权限才能保存到手机音乐目录")
            }
        }
    }

    /* ================= 页面资源 ================= */

    private fun extractWwwAssets() {
        val prefs = getSharedPreferences("hibiki_app", MODE_PRIVATE)
        if (prefs.getString("www_version", "") == WWW_VERSION) {
            val idx = File(filesDir, "www/index.html")
            if (idx.exists() && idx.length() > 0) return
        }
        try {
            val dir = File(filesDir, "www")
            if (!dir.exists() && !dir.mkdirs()) return
            val out = File(dir, "index.html")
            assets.open("index.html").use { input ->
                out.outputStream().use { os -> input.copyTo(os) }
            }
            prefs.edit().putString("www_version", WWW_VERSION).apply()
        } catch (e: Exception) {
            Log.e("Hibiki", "extract assets failed", e)
        }
    }

    private fun configureWebView() {
        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.databaseEnabled = false

        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                flushPendingLink()
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                // 只允许本站导航；外链交给系统浏览器
                if (url.startsWith("http://127.0.0.1")) return false
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, request.url))
                } catch (e: Exception) {
                    // 无可用浏览器
                }
                return true
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                val resources = request.resources
                if (resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(resources)
                    } else {
                        pendingPermissionRequest = request
                        requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
                    }
                } else {
                    request.deny()
                }
            }

            override fun onConsoleMessage(cm: ConsoleMessage): Boolean {
                Log.d("HibikiJS", cm.message())
                return true
            }
        }
    }

    /* ================= 杜比 / DTS 解码（页面桥调用） ================= */

    /** 读取音频流信息（编码 / 声道 / 采样率 / 时长），用于界面展示与降混判断 */
    fun probeAudio(requestId: String, payload: String) {
        val dec = decoder
        if (dec == null) {
            bridge?.resolve(requestId, false, "解码器未就绪")
            return
        }
        val id = try {
            JSONObject(payload).optString("id")
        } catch (e: Exception) {
            ""
        }
        if (id.isEmpty()) {
            bridge?.resolve(requestId, false, "缺少文件 id")
            return
        }
        Thread {
            val info = dec.probe(id)
            if (info != null) bridge?.resolve(requestId, true, info.toString())
            else bridge?.resolve(requestId, false, "无法读取音频信息")
        }.start()
    }

    /** 解码为 PCM WAV；channels=0 表示保留原始声道布局 */
    fun decodeAudio(requestId: String, payload: String) {
        val dec = decoder
        if (dec == null) {
            bridge?.resolve(requestId, false, "解码器未就绪")
            return
        }
        val obj = try {
            JSONObject(payload)
        } catch (e: Exception) {
            JSONObject()
        }
        val id = obj.optString("id")
        if (id.isEmpty()) {
            bridge?.resolve(requestId, false, "缺少文件 id")
            return
        }
        val name = obj.optString("name")
        val size = obj.optLong("size", 0L)
        val channels = obj.optInt("channels", 0)
        dec.onProgress = { pct -> bridge?.progress(requestId, pct) }
        Thread {
            try {
                val res = dec.decode(id, name, size, channels)
                bridge?.resolve(requestId, true, res.toString())
            } catch (e: Exception) {
                bridge?.resolve(requestId, false, e.message ?: "解码失败")
            } finally {
                dec.onProgress = null
            }
        }.start()
    }

    /** 读取下载曲目的标签与封面（裸流文件本身不带标签，改由应用内记录） */
    fun trackTags(requestId: String, payload: String) {
        Thread {
            try {
                val obj = payloadOf(payload)
                val id = obj.optString("id")
                if (id.isBlank()) { bridge?.resolve(requestId, true, "{}"); return@Thread }
                val tags = TrackTags.withCoverUrl(this, id)
                bridge?.resolve(requestId, true, (tags ?: JSONObject()).toString())
            } catch (e: Exception) {
                bridge?.resolve(requestId, true, "{}")
            }
        }.start()
    }

    /** 取消进行中的解码（切歌 / 停止播放时调用） */
    fun cancelDecode(requestId: String) {
        decoder?.cancel()
        bridge?.resolve(requestId, true, "{}")
    }

    /* ================= B 站音频下载（页面桥调用） ================= */

    private fun payloadOf(payload: String): JSONObject =
        try {
            JSONObject(payload)
        } catch (e: Exception) {
            JSONObject()
        }

    /** 解析链接（BV / av / b23.tv 短链 / 分享文案）→ 视频信息与分 P 列表 */
    fun biliParse(requestId: String, payload: String) {
        val api = biliApi
        if (api == null) {
            bridge?.resolve(requestId, false, "下载模块未就绪")
            return
        }
        val text = payloadOf(payload).optString("text")
        Thread {
            try {
                bridge?.resolve(requestId, true, api.parse(text).toString())
            } catch (e: Exception) {
                bridge?.resolve(requestId, false, e.message ?: "解析失败")
            }
        }.start()
    }

    /** 取某个分 P 的可选音质 */
    fun biliQualities(requestId: String, payload: String) {
        val api = biliApi
        if (api == null) {
            bridge?.resolve(requestId, false, "下载模块未就绪")
            return
        }
        val obj = payloadOf(payload)
        val bvid = obj.optString("bvid")
        val cid = obj.optLong("cid", 0L)
        Thread {
            try {
                // 返回原始 DASH：音质档位（含 Hi-Res 无损 / 杜比全景声）在页面侧解析，与桌面版同一套逻辑
                bridge?.resolve(requestId, true, api.dash(bvid, cid).toString())
            } catch (e: Exception) {
                bridge?.resolve(requestId, false, e.message ?: "无法获取音质清单")
            }
        }.start()
    }

    /** 保存二维码图片到相册（同一台手机可用 B 站「扫一扫 → 相册」完成登录） */
    fun saveQrImage(requestId: String, payload: String) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q &&
            checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED
        ) {
            pendingQrImage = requestId to payload
            requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), REQ_STORAGE)
            return
        }
        doSaveQrImage(requestId, payload)
    }

    private fun doSaveQrImage(requestId: String, payload: String) {
        Thread {
            try {
                val obj = payloadOf(payload)
                val data = obj.optString("data", "")
                val rawName = obj.optString("name", "bilibili-qr.png")
                val name = rawName.replace(Regex("[\\\\/:*?\"<>|\\r\\n\\t]"), "_")
                val comma = data.indexOf(',')
                if (data.isEmpty() || comma < 0) throw IllegalStateException("二维码数据为空")
                val bytes = android.util.Base64.decode(data.substring(comma + 1), android.util.Base64.DEFAULT)
                if (bytes.isEmpty()) throw IllegalStateException("二维码数据为空")
                val path = publishQrImage(name, bytes)
                bridge?.resolve(requestId, true, JSONObject().put("path", path).toString())
            } catch (e: Exception) {
                bridge?.resolve(requestId, false, e.message ?: "保存失败")
            }
        }.start()
    }

    /** Android 10+ 走 MediaStore（免权限）；更低版本写公共图片目录 */
    private fun publishQrImage(fileName: String, bytes: ByteArray): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, fileName)
                put(MediaStore.Images.Media.MIME_TYPE, "image/png")
                put(MediaStore.Images.Media.RELATIVE_PATH, android.os.Environment.DIRECTORY_PICTURES + "/Hibiki Player")
                put(MediaStore.Images.Media.IS_PENDING, 1)
            }
            val resolver = contentResolver
            val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
                ?: throw IllegalStateException("无法写入相册")
            try {
                resolver.openOutputStream(uri)?.use { out -> out.write(bytes) }
                    ?: throw IllegalStateException("无法写入图片")
                values.clear()
                values.put(MediaStore.Images.Media.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
            } catch (e: Exception) {
                try { resolver.delete(uri, null, null) } catch (e2: Exception) {}
                throw e
            }
            return "图片/Hibiki Player/" + fileName
        }
        val dir = File(
            android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_PICTURES),
            "Hibiki Player"
        )
        if (!dir.exists() && !dir.mkdirs()) throw IllegalStateException("无法创建图片目录")
        val out = File(dir, fileName)
        out.outputStream().use { it.write(bytes) }
        android.media.MediaScannerConnection.scanFile(this, arrayOf(out.absolutePath), null, null)
        return "图片/Hibiki Player/" + fileName
    }

    /** 开始下载（Android 9 及以下先申请存储权限） */
    fun biliStart(requestId: String, payload: String) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q &&
            checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED
        ) {
            pendingBiliStart = requestId to payload
            requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), REQ_STORAGE)
            return
        }
        doStartBiliDownload(requestId, payload)
    }

    private fun doStartBiliDownload(requestId: String, payload: String) {
        val dl = bili
        if (dl == null) {
            bridge?.resolve(requestId, false, "下载模块未就绪")
            return
        }
        val obj = payloadOf(payload)
        try {
            val backups = ArrayList<String>()
            val arr = obj.optJSONArray("backups")
            if (arr != null) for (i in 0 until arr.length()) backups.add(arr.optString(i))
            val task = dl.start(
                bvid = obj.optString("bvid"),
                cid = obj.optLong("cid", 0L),
                title = obj.optString("title"),
                part = obj.optString("part"),
                owner = obj.optString("owner"),
                qualityId = obj.optInt("qualityId", 0),
                qualityLabel = obj.optString("qualityLabel"),
                codec = obj.optString("codec"),
                url = obj.optString("url"),
                backups = backups,
                pic = obj.optString("pic"),
                dirUri = obj.optString("dirUri"),
                speedKbps = obj.optInt("speedKbps", 0),
                page = obj.optInt("page", 0),
                folder = obj.optString("folder")          // 合集（多 P）：视频名 → 子文件夹
            )
            bridge?.resolve(requestId, true, JSONObject().put("task", task.toJson()).toString())
        } catch (e: Exception) {
            bridge?.resolve(requestId, false, e.message ?: "无法开始下载")
        }
    }

    fun biliTasks(requestId: String) {
        val dl = bili
        if (dl == null) {
            bridge?.resolve(requestId, false, "下载模块未就绪")
            return
        }
        bridge?.resolve(requestId, true, JSONObject().put("tasks", dl.list()).toString())
    }

    fun biliCancel(requestId: String, payload: String) {
        bili?.cancel(payloadOf(payload).optString("taskId"))
        bridge?.resolve(requestId, true, "{}")
    }

    fun biliClearFinished(requestId: String) {
        bili?.clearFinished()
        bridge?.resolve(requestId, true, "{}")
    }

    /** 账号状态（登录后可下载 Hi-Res 无损 / 杜比全景声） */
    fun biliAccount(requestId: String) {
        val api = biliApi
        if (api == null) {
            bridge?.resolve(requestId, false, "下载模块未就绪")
            return
        }
        if (!api.loggedIn) {
            bridge?.resolve(requestId, true, JSONObject().put("loggedIn", false).toString())
            return
        }
        Thread {
            val acc = api.nav()
            if (acc != null) bridge?.resolve(requestId, true, acc.toString())
            else bridge?.resolve(requestId, true, JSONObject().put("loggedIn", false).toString())
        }.start()
    }

    fun biliQrStart(requestId: String) {
        val api = biliApi
        if (api == null) {
            bridge?.resolve(requestId, false, "下载模块未就绪")
            return
        }
        Thread {
            try {
                bridge?.resolve(requestId, true, api.qrGenerate().toString())
            } catch (e: Exception) {
                bridge?.resolve(requestId, false, e.message ?: "无法获取登录二维码")
            }
        }.start()
    }

    fun biliQrPoll(requestId: String, payload: String) {
        val api = biliApi
        if (api == null) {
            bridge?.resolve(requestId, false, "下载模块未就绪")
            return
        }
        val key = payloadOf(payload).optString("key")
        Thread {
            try {
                bridge?.resolve(requestId, true, api.qrPoll(key).toString())
            } catch (e: Exception) {
                bridge?.resolve(requestId, true, JSONObject().put("state", "wait").toString())
            }
        }.start()
    }

    fun biliLogout(requestId: String) {
        biliApi?.logout()
        bridge?.resolve(requestId, true, "{}")
    }

    /** 读取剪贴板（页面侧「粘贴」按钮） */
    fun biliClipboard(requestId: String) {
        val text = try {
            val cm = getSystemService(CLIPBOARD_SERVICE) as? ClipboardManager
            cm?.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)?.toString() ?: ""
        } catch (e: Exception) {
            ""
        }
        bridge?.resolve(requestId, true, JSONObject().put("text", text).toString())
    }

    /* ================= 文件选择（页面桥调用） ================= */

    fun pickAudioFiles(requestId: String) {
        pendingPick = PendingPick(requestId, "files")
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
        try {
            startActivityForResult(intent, REQ_FILES)
        } catch (e: Exception) {
            pendingPick = null
            bridge?.resolve(requestId, false, "无法打开文件选择器：" + e.message)
        }
    }

    fun pickAudioFolder(requestId: String) {
        pendingPick = PendingPick(requestId, "folder")
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
        try {
            startActivityForResult(intent, REQ_FOLDER)
        } catch (e: Exception) {
            pendingPick = null
            bridge?.resolve(requestId, false, "无法打开文件夹选择器：" + e.message)
        }
    }

    fun pickImage(requestId: String) {
        pendingPick = PendingPick(requestId, "image")
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "image/*"
        }
        try {
            startActivityForResult(intent, REQ_IMAGE)
        } catch (e: Exception) {
            pendingPick = null
            bridge?.resolve(requestId, false, "无法打开图片选择器：" + e.message)
        }
    }

    /** 选择下载文件夹（SAF 目录树，持久授权；返回 uri + 显示名） */
    fun pickDownloadDir(requestId: String) {
        pendingPick = PendingPick(requestId, "tree")
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        }
        try {
            startActivityForResult(intent, REQ_TREE)
        } catch (e: Exception) {
            pendingPick = null
            bridge?.resolve(requestId, false, "无法打开文件夹选择器：" + e.message)
        }
    }

    /** 目录选择结果：持久授权后返回 uri + 可读的名称 */
    private fun handleTreeResult(pending: PendingPick, data: Intent) {
        val uri = data.data
        if (uri == null) { bridge?.resolve(pending.requestId, false, "已取消"); return }
        try {
            contentResolver.takePersistableUriPermission(
                uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            )
        } catch (e: Exception) { /* 某些提供方不支持持久授权 */ }
        val name = try {
            DocumentsContract.getTreeDocumentId(uri).substringAfterLast(':').substringAfterLast('/')
        } catch (e: Exception) { "" }
        bridge?.resolve(
            pending.requestId, true,
            JSONObject().put("uri", uri.toString()).put("name", name.ifBlank { "已选择文件夹" }).toString()
        )
    }

    fun pickTextFile(requestId: String) {
        pendingPick = PendingPick(requestId, "text")
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
        }
        try {
            startActivityForResult(intent, REQ_TEXT)
        } catch (e: Exception) {
            pendingPick = null
            bridge?.resolve(requestId, false, "无法打开文件选择器：" + e.message)
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        val pending = pendingPick ?: return
        pendingPick = null
        if (resultCode != RESULT_OK || data == null) {
            bridge?.resolve(pending.requestId, false, "已取消")
            return
        }
        try {
            when (requestCode) {
                REQ_FILES -> handleFilesResult(pending, data)
                REQ_FOLDER -> handleFolderResult(pending, data)
                REQ_IMAGE -> handleImageResult(pending, data)
                REQ_TEXT -> handleTextResult(pending, data)
                REQ_TREE -> handleTreeResult(pending, data)
            }
        } catch (e: Exception) {
            bridge?.resolve(pending.requestId, false, "读取失败：" + e.message)
        }
    }

    private fun persistPermission(data: Intent) {
        val flags = data.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION
        if (flags == 0) return
        val uris = ArrayList<Uri>()
        data.data?.let { uris.add(it) }
        data.clipData?.let { cd ->
            for (i in 0 until cd.itemCount) uris.add(cd.getItemAt(i).uri)
        }
        for (u in uris) {
            try {
                contentResolver.takePersistableUriPermission(u, flags)
            } catch (e: Exception) {
                // 某些提供方不支持持久授权，本次会话内仍可用
            }
        }
    }

    private fun handleFilesResult(pending: PendingPick, data: Intent) {
        persistPermission(data)
        val entries = ArrayList<Map<String, Any>>()
        val lrc = HashMap<String, String>()
        val uris = ArrayList<Uri>()
        data.data?.let { uris.add(it) }
        data.clipData?.let { cd ->
            for (i in 0 until cd.itemCount) uris.add(cd.getItemAt(i).uri)
        }
        for (uri in uris) {
            val name = queryName(uri) ?: continue
            val size = querySize(uri)
            when {
                Util.isLrc(name) -> {
                    val text = readText(uri, 1024 * 1024)
                    if (text != null) {
                        lrc[name.removeSuffix(".lrc").lowercase()] = text
                    }
                }
                Util.isAudioName(name) -> {
                    val id = registry.registerAudio(uri, name, size)
                    entries.add(mapOf("id" to id, "name" to name, "size" to size))
                }
            }
        }
        bridge?.resolve(
            pending.requestId, true,
            JSONObject()
                .put("entries", JSONArray().apply { entries.forEach { put(JSONObject(it)) } })
                .put("lrc", JSONObject(lrc))
                .toString()
        )
    }

    private fun handleFolderResult(pending: PendingPick, data: Intent) {
        val treeUri = data.data
        if (treeUri == null) {
            bridge?.resolve(pending.requestId, false, "未获取到文件夹")
            return
        }
        val flags = data.flags and
            (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        try {
            contentResolver.takePersistableUriPermission(treeUri, flags)
        } catch (e: Exception) {
            // 不支持持久授权时本次会话仍可用
        }
        val entries = ArrayList<Map<String, Any>>()
        val lrc = HashMap<String, String>()
        val rootDocId = DocumentsContract.getTreeDocumentId(treeUri)
        walkFolder(treeUri, rootDocId, 0, entries, lrc)
        entries.sortWith { a, b -> Util.naturalCompare(a["name"] as String, b["name"] as String) }
        bridge?.resolve(
            pending.requestId, true,
            JSONObject()
                .put("entries", JSONArray().apply { entries.forEach { put(JSONObject(it)) } })
                .put("lrc", JSONObject(lrc))
                .toString()
        )
    }

    private fun walkFolder(
        treeUri: Uri,
        docId: String,
        depth: Int,
        entries: MutableList<Map<String, Any>>,
        lrc: MutableMap<String, String>
    ) {
        if (depth > 10) return
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, docId)
        val cols = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME
        )
        var cursor: Cursor? = null
        try {
            cursor = contentResolver.query(childrenUri, cols, null, null, null)
            while (cursor != null && cursor.moveToNext()) {
                val childId = cursor.getString(0)
                val mime = cursor.getString(1)
                val name = cursor.getString(2) ?: continue
                if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                    walkFolder(treeUri, childId, depth + 1, entries, lrc)
                } else if (Util.isLrc(name)) {
                    val docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, childId)
                    val text = readText(docUri, 1024 * 1024)
                    if (text != null) {
                        lrc[name.removeSuffix(".lrc").lowercase()] = text
                    }
                } else if (Util.isAudioName(name)) {
                    val docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, childId)
                    val size = querySize(docUri)
                    val id = registry.registerAudio(docUri, name, size)
                    entries.add(mapOf("id" to id, "name" to name, "size" to size))
                }
            }
        } catch (e: Exception) {
            // 单个目录读取失败不致命
        } finally {
            try {
                cursor?.close()
            } catch (e: Exception) {
            }
        }
    }

    private fun handleImageResult(pending: PendingPick, data: Intent) {
        val uri = data.data
        if (uri == null) {
            bridge?.resolve(pending.requestId, false, "未获取到图片")
            return
        }
        persistPermission(data)
        val name = queryName(uri) ?: "image"
        val size = querySize(uri)
        val id = registry.registerImage(uri, name, size)
        bridge?.resolve(
            pending.requestId, true,
            JSONObject().put("id", id).put("name", name).toString()
        )
    }

    private fun handleTextResult(pending: PendingPick, data: Intent) {
        val uri = data.data
        if (uri == null) {
            bridge?.resolve(pending.requestId, false, "未获取到文件")
            return
        }
        val name = queryName(uri) ?: "lyrics.lrc"
        val text = readText(uri, 4 * 1024 * 1024)
        if (text == null) {
            bridge?.resolve(pending.requestId, false, "无法读取文件内容")
            return
        }
        bridge?.resolve(
            pending.requestId, true,
            JSONObject().put("name", name).put("content", text).toString()
        )
    }

    /* ================= 工具 ================= */

    private fun queryName(uri: Uri): String? {
        try {
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) return c.getString(0)
            }
        } catch (e: Exception) {
        }
        return uri.lastPathSegment
    }

    private fun querySize(uri: Uri): Long {
        try {
            contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val v = c.getString(0)
                    return v?.toLongOrNull() ?: 0L
                }
            }
        } catch (e: Exception) {
        }
        return 0L
    }

    private fun readText(uri: Uri, maxBytes: Int): String? {
        return try {
            contentResolver.openInputStream(uri)?.use { input ->
                val buf = ByteArray(minOf(maxBytes, 256 * 1024))
                val out = ByteArrayOutputStream()
                var total = 0
                while (total < maxBytes) {
                    val n = input.read(buf, 0, minOf(buf.size, maxBytes - total))
                    if (n < 0) break
                    out.write(buf, 0, n)
                    total += n
                }
                String(out.toByteArray(), Charsets.UTF_8)
            }
        } catch (e: Exception) {
            null
        }
    }
}




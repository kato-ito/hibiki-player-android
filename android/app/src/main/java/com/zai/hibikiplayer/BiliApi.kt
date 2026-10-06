package com.zai.hibikiplayer

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * B 站接口封装（与桌面版同一条管线）：
 *   view 取视频信息 → playurl(fnval=4048) 取 DASH 音频流 → CDN 直连下载。
 *
 * 两个经实测确认的关键点：
 *  1. 接口与 CDN 都必须使用 PC 版 User-Agent（移动 UA 访问 CDN 会返回 403）；
 *  2. 下载音频与封面必须带 Referer: https://www.bilibili.com/video/<BV>。
 */
class BiliApi(private val context: Context) {

    companion object {
        /** CDN 与接口都认这个 UA（实测：移动 UA → 403，PC UA → 200/206） */
        const val UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        private const val REFERER = "https://www.bilibili.com"
        /** 图片代理单张上限（封面/头像都在 1 MB 内，防止被当成任意大文件通道） */
        private const val MAX_IMAGE_BYTES = 6 * 1024 * 1024
        private const val PREF = "hibiki_bili"
        private const val KEY_COOKIE = "cookie"

        /** 分享文案里的链接：BV 号 / av 号 / b23.tv 短链 */
        private val LINK_RE = Regex(
            "https?://(?:b23\\.tv/[A-Za-z0-9]+|(?:www\\.)?bilibili\\.com/video/(?:BV[0-9A-Za-z]{8,12}|av\\d+))",
            RegexOption.IGNORE_CASE
        )

        /** 音频流 id → 显示名（B 站固定档位） */
        private fun qualityLabel(id: Int, codec: String): String = when (id) {
            30216 -> "64K"
            30232 -> "132K"
            30280 -> "192K"
            30250 -> "杜比全景声"
            30251 -> "Hi-Res 无损"
            else -> if (id > 0) id.toString() else codec
        }
    }

    private val prefs = context.getSharedPreferences(PREF, Context.MODE_PRIVATE)

    /** 当前登录 Cookie（游客为 null） */
    var cookie: String?
        get() = prefs.getString(KEY_COOKIE, null)
        set(value) {
            if (value.isNullOrBlank()) prefs.edit().remove(KEY_COOKIE).apply()
            else prefs.edit().putString(KEY_COOKIE, value).apply()
        }

    val loggedIn: Boolean get() = !cookie.isNullOrBlank()

    /* ================= HTTP 基础 ================= */

    private fun open(url: String, referer: String?, accept: String?): HttpURLConnection {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 15000
        conn.readTimeout = 30000
        conn.instanceFollowRedirects = false
        conn.setRequestProperty("User-Agent", UA)
        conn.setRequestProperty("Referer", referer ?: REFERER)
        conn.setRequestProperty("Accept", accept ?: "application/json, text/plain, */*")
        conn.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9")
        val ck = cookie
        if (!ck.isNullOrBlank()) conn.setRequestProperty("Cookie", ck)
        return conn
    }

    private fun readAll(conn: HttpURLConnection): String {
        val stream = try {
            conn.inputStream
        } catch (e: Exception) {
            conn.errorStream ?: return ""
        }
        return BufferedReader(InputStreamReader(stream, Charsets.UTF_8)).use { it.readText() }
    }

    /** GET 并解析 JSON（code != 0 时抛错，消息可直接展示给用户） */
    fun getJson(url: String, referer: String? = null): JSONObject {
        val conn = open(url, referer, null)
        try {
            val code = conn.responseCode
            val body = readAll(conn)
            if (body.isBlank()) throw IllegalStateException("接口无响应（HTTP " + code + "）")
            val json = JSONObject(body)
            if (json.optInt("code", 0) != 0) {
                val msg = json.optString("message").ifBlank { "接口错误 code=" + json.optInt("code") }
                throw IllegalStateException(msg)
            }
            return json
        } finally {
            try { conn.disconnect() } catch (e: Exception) {}
        }
    }

    /** GET 文本 */
    fun getText(url: String, referer: String? = null): String {
        val conn = open(url, referer, null)
        try {
            return readAll(conn)
        } finally {
            try { conn.disconnect() } catch (e: Exception) {}
        }
    }

    /** 读取响应头 Location（短链 302） */
    private fun locationOf(url: String): String? {
        val conn = open(url, REFERER, null)
        try {
            if (conn.responseCode in 300..399) return conn.getHeaderField("Location")
            return null
        } finally {
            try { conn.disconnect() } catch (e: Exception) {}
        }
    }

    /* ================= 链接解析 ================= */

    /** 从任意文本（分享文案 / 剪贴板）里提取 B 站链接 */
    fun extractLink(text: String?): String? {
        if (text.isNullOrBlank()) return null
        return LINK_RE.find(text)?.value
    }

    /** 短链 → 真实链接（b23.tv 302） */
    fun expandLink(link: String): String {
        if (!link.contains("b23.tv", ignoreCase = true)) return link
        return try {
            var loc = locationOf(link)
            var guard = 0
            while (loc != null && loc.contains("b23.tv", ignoreCase = true) && guard++ < 3) {
                loc = locationOf(loc)
            }
            loc ?: link
        } catch (e: Exception) {
            link
        }
    }

    private fun bvidOf(link: String): String? =
        Regex("(BV[0-9A-Za-z]{8,12})").find(link)?.value

    private fun aidOf(link: String): String? =
        Regex("av(\\d+)", RegexOption.IGNORE_CASE).find(link)?.groupValues?.get(1)

    /* ================= 视频信息 ================= */

    /** 解析链接 → 视频信息（含全部分 P） */
    fun parse(text: String): JSONObject {
        val raw = extractLink(text) ?: throw IllegalStateException("没有找到 B 站链接")
        val link = expandLink(raw)
        val bvid = bvidOf(link)
        val aid = aidOf(link)
        if (bvid == null && aid == null) throw IllegalStateException("无法识别的链接：" + link)
        val q = if (bvid != null) "bvid=" + bvid else "aid=" + aid
        val json = getJson("https://api.bilibili.com/x/web-interface/view?" + q)
        val d = json.getJSONObject("data")
        val pages = JSONArray()
        val arr = d.optJSONArray("pages") ?: JSONArray()
        for (i in 0 until arr.length()) {
            val p = arr.getJSONObject(i)
            pages.put(
                JSONObject()
                    .put("cid", p.optLong("cid"))
                    .put("page", p.optInt("page", i + 1))
                    .put("part", p.optString("part", "P" + (i + 1)))
                    .put("duration", p.optInt("duration", 0))
            )
        }
        val owner = d.optJSONObject("owner")
        return JSONObject()
            .put("bvid", d.optString("bvid"))
            .put("aid", d.optLong("aid"))
            .put("title", d.optString("title"))
            .put("owner", if (owner != null) owner.optString("name") else "")
            .put("pic", d.optString("pic"))
            .put("duration", d.optInt("duration", 0))
            .put("desc", d.optString("desc").take(120))
            .put("pages", pages)
            .put("link", "https://www.bilibili.com/video/" + d.optString("bvid"))
    }

    /* ================= 音质清单 ================= */

    /**
     * 取 DASH 原始信息：音频档位在页面侧解析（与桌面版同一套逻辑）。
     * dash.audio = AAC 档位；dash.flac.audio = Hi-Res 无损；dash.dolby.audio = 杜比全景声。
     * 未登录时后两者为 null（需大会员 + 登录 Cookie），因此这里只做 null 安全的透传。
     */
    fun dash(bvid: String, cid: Long): JSONObject {
        val url = "https://api.bilibili.com/x/player/playurl?bvid=" + bvid + "&cid=" + cid +
            "&fourk=1&fnver=0&fnval=4048"
        val json = getJson(url, "https://www.bilibili.com/video/" + bvid)
        val code = json.optInt("code", -1)
        if (code != 0) {
            val msg = json.optString("message")
            throw IllegalStateException(if (msg.isBlank()) "接口返回 code=" + code else msg)
        }
        val data = json.optJSONObject("data") ?: throw IllegalStateException("接口没有返回数据")
        val dash = data.optJSONObject("dash") ?: throw IllegalStateException("该视频没有可下载的音频流")
        return JSONObject()
            .put("dash", dash)
            .put("quality", data.optInt("quality", 0))
            .put("support", data.optJSONArray("support_formats") ?: JSONArray())
    }

    /* ================= 图片代理（B 站图床防盗链：外站 Referer 会 403） ================= */

    private val imageCache = object : LinkedHashMap<String, Pair<ByteArray, String>>(8, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Pair<ByteArray, String>>): Boolean =
            size > 40
    }

    /**
     * 页面把 <img> 指向本地 /biliimg/<base64url>，由这里带 UA + bilibili Referer 取图。
     * 这样既避开「外站 Referer → 403」，也不受 WebView 对远程图片的限制。
     */
    fun imageFor(key: String): Pair<ByteArray, String>? {
        synchronized(imageCache) { imageCache[key]?.let { return it } }
        val url = try {
            String(
                android.util.Base64.decode(
                    key,
                    android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING
                ),
                Charsets.UTF_8
            )
        } catch (e: Exception) {
            return null
        }
        if (!url.startsWith("http://") && !url.startsWith("https://")) return null
        // 只允许 B 站图床：避免本地页面把这个代理当成任意 URL 的取数通道
        if (!isBiliHost(url)) return null
        val got = try {
            fetchImageBytes(url)
        } catch (e: Exception) {
            null
        } ?: return null
        if (got.first.size > MAX_IMAGE_BYTES) return null
        if (got.first.isEmpty()) return null
        synchronized(imageCache) { imageCache[key] = got }
        return got
    }

    /** 图床白名单：hdslb.com / bilibili.com / bilivideo.com 及其子域 */
    private fun isBiliHost(url: String): Boolean {
        val host = try {
            java.net.URI(url).host?.lowercase() ?: return false
        } catch (e: Exception) {
            return false
        }
        return host == "hdslb.com" || host.endsWith(".hdslb.com") ||
            host == "bilibili.com" || host.endsWith(".bilibili.com") ||
            host == "bilivideo.com" || host.endsWith(".bilivideo.com")
    }

    private fun fetchImageBytes(url: String): Pair<ByteArray, String> {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 15000
        conn.readTimeout = 20000
        conn.instanceFollowRedirects = true
        conn.setRequestProperty("User-Agent", UA)
        conn.setRequestProperty("Referer", REFERER)
        conn.setRequestProperty("Accept", "image/avif,image/webp,image/apng,image/*,*/*;q=0.8")
        try {
            val code = conn.responseCode
            if (code < 200 || code >= 300) throw IllegalStateException("HTTP " + code)
            val type = (conn.contentType ?: "image/jpeg").substringBefore(";").trim()
            val declared = conn.contentLengthLong
            if (declared > MAX_IMAGE_BYTES) throw IllegalStateException("图片过大")
            val buf = java.io.ByteArrayOutputStream()
            conn.inputStream.use { input ->
                val chunk = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(chunk)
                    if (n < 0) break
                    if (buf.size() + n > MAX_IMAGE_BYTES) throw IllegalStateException("图片过大")
                    buf.write(chunk, 0, n)
                }
            }
            val bytes = buf.toByteArray()
            return bytes to (if (type.startsWith("image/")) type else "image/jpeg")
        } finally {
            conn.disconnect()
        }
    }

    /* ================= 账号 ================= */

    fun nav(): JSONObject? {
        return try {
            val json = getJson("https://api.bilibili.com/x/web-interface/nav")
            val d = json.optJSONObject("data") ?: return null
            if (!d.optBoolean("isLogin")) return null
            val level = d.optJSONObject("level_info")
            JSONObject()
                .put("loggedIn", true)
                .put("name", d.optString("uname"))
                .put("face", d.optString("face"))
                .put("vip", d.optInt("vipStatus", 0) == 1)
                .put("level", if (level != null) level.optInt("current_level", 0) else 0)
        } catch (e: Exception) {
            null
        }
    }

    fun qrGenerate(): JSONObject {
        val json = getJson("https://passport.bilibili.com/x/passport-login/web/qrcode/generate")
        val d = json.getJSONObject("data")
        return JSONObject().put("url", d.optString("url")).put("key", d.optString("qrcode_key"))
    }

    /**
     * 轮询扫码状态；成功时保存 Cookie。
     * state：wait 等待扫码 / scanned 已扫待确认 / expired 已失效 / ok / error
     */
    fun qrPoll(key: String): JSONObject {
        val conn = open(
            "https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=" + key,
            REFERER, null
        )
        try {
            val body = readAll(conn)
            val json = JSONObject(body)
            val d = json.optJSONObject("data")
            val code = if (d != null) d.optInt("code", -1) else -1
            val state = when (code) {
                0 -> "ok"
                86038 -> "expired"
                86090 -> "scanned"
                else -> "wait"
            }
            val result = JSONObject().put("state", state).put("code", code)
            if (state == "ok") {
                var ck = cookieFromHeaders(conn)
                if (ck.isNullOrBlank() && d != null) ck = cookieFromCallback(d.optString("url"))
                if (!ck.isNullOrBlank()) {
                    cookie = ck
                    val acc = nav()
                    result.put("account", if (acc != null) acc else JSONObject().put("loggedIn", true))
                } else {
                    result.put("state", "error").put("message", "登录成功但未取到 Cookie，请重试")
                }
            }
            return result
        } finally {
            try { conn.disconnect() } catch (e: Exception) {}
        }
    }

    /** 从响应头收集 Set-Cookie */
    private fun cookieFromHeaders(conn: HttpURLConnection): String? {
        val fields = conn.headerFields ?: return null
        val sb = StringBuilder()
        for ((k, v) in fields) {
            if (k == null || !k.equals("Set-Cookie", ignoreCase = true) || v == null) continue
            for (raw in v) {
                val pair = raw.substringBefore(";").trim()
                if (pair.startsWith("SESSDATA=") || pair.startsWith("bili_jct=") ||
                    pair.startsWith("DedeUserID=") || pair.startsWith("DedeUserID__ckMd5=") ||
                    pair.startsWith("sid=")
                ) {
                    if (sb.isNotEmpty()) sb.append("; ")
                    sb.append(pair)
                }
            }
        }
        return sb.toString().ifBlank { null }
    }

    /** 从回调 URL 的查询参数里取 Cookie（经典流程兜底） */
    private fun cookieFromCallback(url: String): String? {
        if (url.isBlank()) return null
        val idx = url.indexOf('?')
        if (idx < 0) return null
        val sb = StringBuilder()
        for (kv in url.substring(idx + 1).split("&")) {
            val eq = kv.indexOf('=')
            if (eq <= 0) continue
            val k = kv.substring(0, eq)
            val v = kv.substring(eq + 1)
            if (k == "SESSDATA" || k == "bili_jct" || k == "DedeUserID" ||
                k == "DedeUserID__ckMd5" || k == "sid"
            ) {
                if (sb.isNotEmpty()) sb.append("; ")
                sb.append(k).append('=').append(v)
            }
        }
        return sb.toString().ifBlank { null }
    }

    fun logout() {
        cookie = null
    }

    /* ================= 下载 ================= */

    /** 下载二进制到文件（带进度与取消），返回写入字节数 */
    fun download(
        url: String,
        referer: String,
        target: java.io.File,
        onProgress: (Long, Long) -> Unit,
        isCancelled: () -> Boolean,
        speedKbps: Int = 0            // 限速（KB/s，0 = 不限）
    ): Long {
        val conn = open(url, referer, "*/*")
        return try {
            val code = conn.responseCode
            if (code < 200 || code > 299) throw IllegalStateException("下载失败 HTTP " + code)
            val total = conn.contentLengthLong
            var got = 0L
            val startedAt = System.currentTimeMillis()
            conn.inputStream.use { input ->
                target.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    var last = 0L
                    while (true) {
                        if (isCancelled()) throw InterruptedException("已取消")
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        got += n
                        val now = System.currentTimeMillis()
                        if (now - last > 300) {
                            last = now
                            onProgress(got, total)
                        }
                        // 限速：按「已用时间 vs 应下载字节数」睡眠，保持平均速率
                        if (speedKbps > 0) {
                            val targetMs = got * 1000.0 / (speedKbps * 1024.0)
                            val elapsed = System.currentTimeMillis() - startedAt
                            val waitMs = (targetMs - elapsed).toLong()
                            if (waitMs > 5) {
                                try { Thread.sleep(minOf(waitMs, 500L)) } catch (e: InterruptedException) {
                                    throw InterruptedException("已取消")
                                }
                            }
                        }
                    }
                }
            }
            onProgress(got, if (total > 0) total else got)
            got
        } finally {
            try { conn.disconnect() } catch (e: Exception) {}
        }
    }
}

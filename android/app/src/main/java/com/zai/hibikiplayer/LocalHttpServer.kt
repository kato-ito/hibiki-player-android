package com.zai.hibikiplayer

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * 本地 HTTP 服务：只监听 127.0.0.1。
 * - 页面资源：filesDir/www（首次启动从 assets 解包）
 * - 音频 / 图片：按注册表中的 SAF URI 流式提供，支持 HTTP Range（拖动进度条即时响应）
 */
/** HTTP 响应换行（避免在 Kotlin 源里写真实换行导致字符串断裂） */
private const val CRLF = "\r\n"
class LocalHttpServer(
    private val context: Context,
    private val resolver: ContentResolver,
    private val registry: Registry
) {

    @Volatile
    var port: Int = -1
        private set

    /** 解码结果查询（key -> PCM WAV 文件）；由 MainActivity 注入 */
    var decodedLookup: ((String) -> File?)? = null

    /** 下载曲目封面文件查询（id -> 文件）；由 MainActivity 注入 */
    var coverLookup: ((String) -> File?)? = null
    /** B 站图片代理（key -> (字节, MIME)）；由 MainActivity 注入（外站 Referer 会被图床拒绝） */
    var imageProxy: ((String) -> Pair<ByteArray, String>?)? = null

    private var serverSocket: ServerSocket? = null
    private var running = false
    private val pool: ExecutorService = Executors.newFixedThreadPool(4)

    /** 优先使用上次的端口，被占用则顺延重试 */
    fun start(preferredPort: Int): Int {
        var candidate = preferredPort
        var bound = false
        for (attempt in 0 until 40) {
            try {
                val ss = ServerSocket()
                ss.reuseAddress = true
                ss.bind(InetSocketAddress("127.0.0.1", candidate))
                serverSocket = ss
                bound = true
                break
            } catch (e: IOException) {
                candidate = if (attempt < 10) candidate + 1 else 20000 + (Math.random() * 30000).toInt()
            }
        }
        if (!bound) throw IOException("无法绑定本地端口")
        port = candidate
        running = true
        Thread({ acceptLoop() }, "hibiki-http").apply { isDaemon = true }.start()
        return candidate
    }

    fun stop() {
        running = false
        try {
            serverSocket?.close()
        } catch (e: Exception) {
        }
        pool.shutdown()
    }

    private fun acceptLoop() {
        while (running) {
            try {
                val client = serverSocket?.accept() ?: continue
                pool.execute { handle(client) }
            } catch (e: Exception) {
                if (!running) break
                try {
                    Thread.sleep(100)
                } catch (e2: InterruptedException) {
                    break
                }
            }
        }
    }

    private fun handle(client: Socket) {
        client.soTimeout = 15000
        try {
            val input = BufferedInputStream(client.getInputStream())
            val output = BufferedOutputStream(client.getOutputStream())
            val requestLine = readLine(input) ?: return
            if (requestLine.isEmpty()) return
            val parts = requestLine.split(" ")
            if (parts.size < 3) {
                writeError(output, "HTTP/1.1", 400, "Bad Request")
                return
            }
            val method = parts[0]
            val pathRaw = parts[1].substringBefore("?")
            val headers = HashMap<String, String>()
            while (true) {
                val line = readLine(input) ?: break
                if (line.isEmpty()) break
                val idx = line.indexOf(':')
                if (idx > 0) {
                    headers[line.substring(0, idx).trim().lowercase()] = line.substring(idx + 1).trim()
                }
            }
            if (method != "GET" && method != "HEAD") {
                writeError(output, parts[2], 405, "Method Not Allowed")
                return
            }
            val path = try {
                URLDecoder.decode(pathRaw, "UTF-8")
            } catch (e: Exception) {
                pathRaw
            }
            route(output, parts[2], path, headers, method == "HEAD")
        } catch (e: Exception) {
            // 连接中途断开等：忽略
        } finally {
            try {
                client.close()
            } catch (e: Exception) {
            }
        }
    }

    private fun route(
        output: OutputStream,
        protocol: String,
        path: String,
        headers: Map<String, String>,
        headOnly: Boolean
    ) {
        when {
            path == "/" || path == "/index.html" -> {
                val f = File(context.filesDir, "www/index.html")
                if (!f.exists() || f.length() <= 0) {
                    writeError(output, protocol, 404, "Not Found")
                    return
                }
                serveFile(output, protocol, f, "text/html; charset=utf-8", headers, headOnly)
            }

            path == "/favicon.ico" -> writeError(output, protocol, 404, "Not Found")

            path.startsWith("/audio/") -> {
                val id = path.removePrefix("/audio/")
                val entry = registry.audio(id)
                if (entry == null) {
                    writeError(output, protocol, 404, "Not Found")
                    return
                }
                serveUri(output, protocol, Uri.parse(entry.uri), entry.size, Util.contentTypeFor(entry.name), headers, headOnly)
            }

            path.startsWith("/image/") -> {
                val id = path.removePrefix("/image/")
                val entry = registry.image(id)
                if (entry == null) {
                    writeError(output, protocol, 404, "Not Found")
                    return
                }
                serveUri(output, protocol, Uri.parse(entry.uri), entry.size, Util.imageTypeFor(entry.name), headers, headOnly)
            }

            // 下载曲目保存的封面（裸流容器装不下内嵌封面，改存应用内）
            path.startsWith("/cover/") -> {
                val id = path.removePrefix("/cover/")
                val f = coverLookup?.invoke(id)
                if (f == null || !f.exists() || f.length() <= 0) {
                    writeError(output, protocol, 404, "Not Found")
                    return
                }
                serveFile(output, protocol, f, "image/jpeg", headers, headOnly)
            }
            // B 站图床代理：/biliimg/<base64url(原始地址)>（封面、UP 主头像等）
            path.startsWith("/biliimg/") -> {
                val key = path.removePrefix("/biliimg/")
                val hit = imageProxy?.invoke(key)
                if (hit == null || hit.first.isEmpty()) {
                    writeError(output, protocol, 404, "Not Found")
                    return
                }
                writeBytes(output, protocol, hit.first, hit.second, headOnly)
            }

            // 杜比 / DTS 解码后的 PCM WAV（同样支持 Range，拖动进度条即时响应）
            path.startsWith("/decoded/") -> {
                val key = path.removePrefix("/decoded/")
                val file = decodedLookup?.invoke(key)
                if (file == null || !file.exists() || file.length() <= 0) {
                    writeError(output, protocol, 404, "Not Found")
                    return
                }
                serveFile(output, protocol, file, "audio/wav", headers, headOnly)
            }

            else -> writeError(output, protocol, 404, "Not Found")
        }
    }

    private fun serveFile(
        output: OutputStream,
        protocol: String,
        file: File,
        contentType: String,
        headers: Map<String, String>,
        headOnly: Boolean
    ) {
        val size = file.length()
        var start = 0L
        var end = size - 1
        var partial = false
        val range = headers["range"]
        if (range != null && range.startsWith("bytes=") && size > 0) {
            val parsed = parseRange(range, size)
            if (parsed == null) {
                writeError(output, protocol, 416, "Range Not Satisfiable")
                return
            }
            start = parsed.first
            end = parsed.second
            partial = true
        }
        var fis: FileInputStream? = null
        try {
            fis = FileInputStream(file)
            fis.channel.position(start)
            writeHeaders(output, protocol, partial, contentType, size, start, end)
            if (!headOnly) streamBody(output, fis, end - start + 1)
        } catch (e: Exception) {
            // 客户端中断
        } finally {
            try {
                fis?.close()
            } catch (e: Exception) {
            }
        }
    }

    private fun serveUri(
        output: OutputStream,
        protocol: String,
        uri: Uri,
        size: Long,
        contentType: String,
        headers: Map<String, String>,
        headOnly: Boolean
    ) {
        val pfd = try {
            resolver.openFileDescriptor(uri, "r")
        } catch (e: Exception) {
            null
        }
        if (pfd == null) {
            writeError(output, protocol, 404, "Not Found")
            return
        }
        var fis: FileInputStream? = null
        try {
            if (size > 0) {
                var start = 0L
                var end = size - 1
                var partial = false
                val range = headers["range"]
                if (range != null && range.startsWith("bytes=")) {
                    val parsed = parseRange(range, size)
                    if (parsed == null) {
                        writeError(output, protocol, 416, "Range Not Satisfiable")
                        return
                    }
                    start = parsed.first
                    end = parsed.second
                    partial = true
                }
                fis = FileInputStream(pfd.fileDescriptor)
                fis.channel.position(start)
                writeHeaders(output, protocol, partial, contentType, size, start, end)
                if (!headOnly) streamBody(output, fis, end - start + 1)
            } else {
                // 尺寸未知：整体发送（关闭分隔）
                val sb = StringBuilder()
                sb.append(protocol).append(" 200 OK\r\n")
                sb.append("Content-Type: ").append(contentType).append("\r\n")
                sb.append("Cache-Control: no-store\r\n")
                sb.append("Connection: close\r\n")
                sb.append("Access-Control-Allow-Origin: *\r\n")
                sb.append("\r\n")
                output.write(sb.toString().toByteArray(Charsets.US_ASCII))
                output.flush()
                if (!headOnly) {
                    fis = FileInputStream(pfd.fileDescriptor)
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = fis.read(buf)
                        if (n < 0) break
                        output.write(buf, 0, n)
                    }
                    output.flush()
                }
            }
        } catch (e: Exception) {
            // 客户端中断
        } finally {
            try {
                fis?.close()
            } catch (e: Exception) {
            }
            try {
                pfd.close()
            } catch (e: Exception) {
            }
        }
    }

    /** 直接回一段字节（图片代理用；带缓存头，避免同一张图反复取） */
    private fun writeBytes(
        output: OutputStream,
        protocol: String,
        bytes: ByteArray,
        contentType: String,
        headOnly: Boolean
    ) {
        val head = StringBuilder()
        head.append(protocol).append(" 200 OK").append(CRLF)
        head.append("Content-Type: ").append(contentType).append(CRLF)
        head.append("Content-Length: ").append(bytes.size).append(CRLF)
        head.append("Cache-Control: public, max-age=86400").append(CRLF)
        head.append("Access-Control-Allow-Origin: *").append(CRLF)
        head.append("Connection: close").append(CRLF)
        head.append(CRLF)
        try {
            output.write(head.toString().toByteArray(Charsets.US_ASCII))
            if (!headOnly) output.write(bytes)
            output.flush()
        } catch (e: Exception) {
            // 客户端中断
        }
    }
    private fun writeHeaders(
        output: OutputStream,
        protocol: String,
        partial: Boolean,
        contentType: String,
        totalSize: Long,
        start: Long,
        end: Long
    ) {
        val status = if (partial) "206 Partial Content" else "200 OK"
        val length = if (partial) end - start + 1 else totalSize
        val sb = StringBuilder()
        sb.append(protocol).append(" ").append(status).append("\r\n")
        sb.append("Content-Type: ").append(contentType).append("\r\n")
        sb.append("Accept-Ranges: bytes\r\n")
        sb.append("Content-Length: ").append(length).append("\r\n")
        if (partial) {
            sb.append("Content-Range: bytes ").append(start).append("-").append(end)
                .append("/").append(totalSize).append("\r\n")
        }
        sb.append("Cache-Control: no-store\r\n")
        sb.append("Connection: close\r\n")
        sb.append("Access-Control-Allow-Origin: *\r\n")
        sb.append("\r\n")
        output.write(sb.toString().toByteArray(Charsets.US_ASCII))
        output.flush()
    }

    private fun streamBody(output: OutputStream, input: InputStream, length: Long) {
        val buf = ByteArray(64 * 1024)
        var remaining = length
        while (remaining > 0) {
            val n = input.read(buf, 0, Math.min(buf.size.toLong(), remaining).toInt())
            if (n < 0) break
            output.write(buf, 0, n)
            remaining -= n
        }
        output.flush()
    }

    private fun parseRange(header: String, size: Long): Pair<Long, Long>? {
        val spec = header.removePrefix("bytes=").substringBefore(",").trim()
        if (spec.isEmpty()) return null
        val dash = spec.indexOf('-')
        if (dash < 0) return null
        val s = spec.substring(0, dash).trim()
        val e = spec.substring(dash + 1).trim()
        var start = 0L
        var end = size - 1
        if (s.isNotEmpty()) {
            start = s.toLongOrNull() ?: return null
            if (e.isNotEmpty()) {
                end = e.toLongOrNull()?.coerceAtMost(size - 1) ?: return null
            }
            if (start > end || start >= size) return null
        } else if (e.isNotEmpty()) {
            val n = e.toLongOrNull() ?: return null
            if (n <= 0) return null
            start = (size - n).coerceAtLeast(0)
        } else {
            return null
        }
        return Pair(start, end)
    }

    private fun readLine(input: InputStream): String? {
        val sb = StringBuilder()
        while (true) {
            val b = input.read()
            if (b < 0) return if (sb.isEmpty()) null else sb.toString()
            if (b == '\n'.code) return sb.toString().trimEnd('\r')
            if (sb.length < 8192) sb.append(b.toChar())
        }
    }

    private fun writeError(output: OutputStream, protocol: String, code: Int, message: String) {
        try {
            val body = message
            val sb = StringBuilder()
            sb.append(protocol).append(" ").append(code).append(" ").append(message).append("\r\n")
            sb.append("Content-Type: text/plain; charset=utf-8\r\n")
            sb.append("Content-Length: ").append(body.toByteArray(Charsets.UTF_8).size).append("\r\n")
            sb.append("Connection: close\r\n\r\n")
            sb.append(body)
            output.write(sb.toString().toByteArray(Charsets.UTF_8))
            output.flush()
        } catch (e: Exception) {
        }
    }
}



package com.zai.hibikiplayer

import java.io.ByteArrayOutputStream
import java.io.File

/**
 * ID3v2.3 标签写入（前置到裸流文件头）。
 *
 * 用途：E-AC-3 / AC-3 / DTS 等**裸流**容器装不下 attached_pic 视频流，
 * ffmpeg 也拒绝给它们写封面；但绝大多数播放器（含本项目内置 ffmpeg 解码链路）
 * 都能识别文件头的 ID3v2 标签，因此这里手工写入 TIT2 / TPE1 / TALB / APIC，
 * 让「原始音频格式」也能带上 B 站视频封面与标签。
 *
 * 实测（见 Windows 端同款实现）：前置 ID3v2 后 ffmpeg 仍能正常识别 eac3 流、
 * 读出 title/artist/album 元数据并解码为 PCM。
 */
object Id3Tag {

    /** 在文件头写入（或替换）ID3v2.3 标签；cover 为 null 时只写文本标签 */
    fun prepend(file: File, title: String, artist: String, album: String, comment: String, cover: ByteArray?) {
        if (!file.exists() || file.length() <= 0) return
        val frames = ByteArrayOutputStream()
        writeText(frames, "TIT2", title)
        writeText(frames, "TPE1", artist)
        writeText(frames, "TALB", album)
        writeText(frames, "TSSE", "Hibiki Player")
        if (comment.isNotBlank()) writeText(frames, "COMM", comment, isComment = true)
        if (cover != null && cover.size > 100) writePicture(frames, cover)
        val body = frames.toByteArray()

        val head = ByteArrayOutputStream()
        head.write(byteArrayOf(0x49, 0x44, 0x33))      // "ID3"
        head.write(byteArrayOf(0x03, 0x00))            // v2.3.0
        head.write(0x00)                               // flags
        val size = body.size
        head.write((size shr 21) and 0x7f)             // syncsafe 长度
        head.write((size shr 14) and 0x7f)
        head.write((size shr 7) and 0x7f)
        head.write(size and 0x7f)

        val original = file.readBytes()
        val start = skipExistingTag(original)
        val tmp = File(file.parentFile, file.name + ".id3tmp")
        tmp.outputStream().use { out ->
            out.write(head.toByteArray())
            out.write(body)
            out.write(original, start, original.size - start)
        }
        if (!tmp.renameTo(file)) {
            tmp.copyTo(file, overwrite = true)
            tmp.delete()
        }
    }

    /** 跳过已有 ID3v2 标签，避免重复写入 */
    private fun skipExistingTag(data: ByteArray): Int {
        if (data.size < 10) return 0
        if (data[0] != 0x49.toByte() || data[1] != 0x44.toByte() || data[2] != 0x33.toByte()) return 0
        val size = ((data[6].toInt() and 0x7f) shl 21) or ((data[7].toInt() and 0x7f) shl 14) or
            ((data[8].toInt() and 0x7f) shl 7) or (data[9].toInt() and 0x7f)
        val total = 10 + size + (if (data[5].toInt() and 0x10 != 0) 10 else 0)
        return if (total in 10 until data.size) total else 0
    }

    private fun writeText(out: ByteArrayOutputStream, id: String, text: String, isComment: Boolean = false) {
        if (text.isBlank()) return
        val payload = ByteArrayOutputStream()
        payload.write(0x03)                            // 编码：UTF-8
        if (isComment) {
            payload.write(byteArrayOf(0x00, 0x00, 0x00))  // 语言
            payload.write(0x00)                            // 描述结束
        }
        payload.write(text.toByteArray(Charsets.UTF_8))
        writeFrame(out, id, payload.toByteArray())
    }

    private fun writePicture(out: ByteArrayOutputStream, cover: ByteArray) {
        val mime = when {
            cover.size > 8 && cover[0] == 0x89.toByte() && cover[1] == 0x50.toByte() -> "image/png"
            cover.size > 3 && cover[0] == 0x47.toByte() && cover[1] == 0x49.toByte() -> "image/gif"
            else -> "image/jpeg"
        }
        val payload = ByteArrayOutputStream()
        payload.write(0x00)                            // 编码：Latin-1
        payload.write(mime.toByteArray(Charsets.ISO_8859_1))
        payload.write(0x00)
        payload.write(0x03)                            // 图片类型：front cover
        payload.write(0x00)                            // 描述结束
        payload.write(cover)
        writeFrame(out, "APIC", payload.toByteArray())
    }

    private fun writeFrame(out: ByteArrayOutputStream, id: String, data: ByteArray) {
        out.write(id.toByteArray(Charsets.US_ASCII))
        val n = data.size
        out.write(byteArrayOf(((n shr 24) and 0xff).toByte(), ((n shr 16) and 0xff).toByte(),
            ((n shr 8) and 0xff).toByte(), (n and 0xff).toByte()))   // ID3v2.3 用普通 32 位长度
        out.write(data)
    }
}

package com.zai.hibikiplayer

import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject

/** JS 桥：页面侧通过 window.AndroidBridge.call(method, requestId, payload) 调用 */
class Bridge(
    private val activity: MainActivity,
    private val webView: WebView,
    private val registry: Registry
) {

    @JavascriptInterface
    fun call(method: String, requestId: String, payload: String) {
        try {
            when (method) {
                "pickAudioFiles" -> activity.runOnUiThread { activity.pickAudioFiles(requestId) }
                "pickAudioFolder" -> activity.runOnUiThread { activity.pickAudioFolder(requestId) }
                "pickImage" -> activity.runOnUiThread { activity.pickImage(requestId) }
                "pickDownloadDir" -> activity.runOnUiThread { activity.pickDownloadDir(requestId) }
                "readTextFile" -> activity.runOnUiThread { activity.pickTextFile(requestId) }
                "importedAudio" -> activity.runOnUiThread { resolve(requestId, true, registry.audioListJson()) }
                // 杜比 / DTS 解码（在后台线程执行，完成后回调）
                "probeAudio" -> activity.probeAudio(requestId, payload)
                "decodeAudio" -> activity.decodeAudio(requestId, payload)
                "cancelDecode" -> activity.cancelDecode(requestId)
                // B 站音频下载
                "biliParse" -> activity.biliParse(requestId, payload)
                "biliQualities" -> activity.biliQualities(requestId, payload)
                "biliStart" -> activity.biliStart(requestId, payload)
                "biliTasks" -> activity.biliTasks(requestId)
                "biliCancel" -> activity.biliCancel(requestId, payload)
                "biliClearFinished" -> activity.biliClearFinished(requestId)
                "biliAccount" -> activity.biliAccount(requestId)
                "biliQrStart" -> activity.biliQrStart(requestId)
                "saveQrImage" -> activity.saveQrImage(requestId, payload)
                "trackMeta" -> activity.trackTags(requestId, payload)
                "biliQrPoll" -> activity.biliQrPoll(requestId, payload)
                "biliLogout" -> activity.biliLogout(requestId)
                "biliClipboard" -> activity.biliClipboard(requestId)
                else -> activity.runOnUiThread { resolve(requestId, false, "unknown method: " + method) }
            }
        } catch (e: Exception) {
            activity.runOnUiThread { resolve(requestId, false, "bridge error: " + e.message) }
        }
    }

    /** 下载任务状态推送（页面侧 window.__hbdBiliTask(task)） */
    fun biliTask(taskJson: String) {
        activity.runOnUiThread {
            webView.evaluateJavascript(
                "window.__hbdBiliTask && window.__hbdBiliTask(" + taskJson + ")",
                null
            )
        }
    }

    /** 外部链接推送（分享进入 / 剪贴板探测）：window.__hbdBiliLink(text, source) */
    fun biliLink(text: String, source: String) {
        activity.runOnUiThread {
            val t = JSONObject.quote(text)
            val s = JSONObject.quote(source)
            webView.evaluateJavascript(
                "window.__hbdBiliLink && window.__hbdBiliLink(" + t + "," + s + ")",
                null
            )
        }
    }

    /** 回到前台（页面侧刷新剪贴板与任务列表） */
    fun resumed() {
        activity.runOnUiThread {
            webView.evaluateJavascript("window.__hbdResume && window.__hbdResume()", null)
        }
    }

    /** 解码进度推送（页面侧 window.__hbdDecodeProgress(requestId, percent)） */
    fun progress(requestId: String, percent: Int) {
        activity.runOnUiThread {
            webView.evaluateJavascript(
                "window.__hbdDecodeProgress && window.__hbdDecodeProgress('" + requestId + "'," + percent + ")",
                null
            )
        }
    }

    fun resolve(requestId: String, ok: Boolean, json: String) {
        activity.runOnUiThread {
            val safe = JSONObject.quote(json ?: "")
            webView.evaluateJavascript(
                "window.__hbpBridgeResult('" + requestId + "'," + ok + "," + safe + ")",
                null
            )
        }
    }
}


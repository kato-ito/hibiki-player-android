package com.zai.hibikiplayer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Base64
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.concurrent.Executors

/**
 * 后台播放服务（Poweramp 风格）：
 * - 页面在开始 / 暂停 / 切歌时把状态推过来（Bridge 的 playerState），这里用前台服务 + 通知栏保活，
 *   并显示锁屏 / 通知栏播放控制（封面、标题、艺人、进度）；
 * - 通知栏、锁屏、耳机线控 / 蓝牙按键上的播放 / 暂停 / 上一首 / 下一首，以及锁屏进度条拖动，
 *   都会通过 window.__hbdPlayerCmd 回传给页面执行；
 * - 播放期间持有 PARTIAL_WAKE_LOCK、申请音频焦点：熄屏不会被系统冻结，来电 / 其它播放器
 *   接管时自动暂停、让出结束后自动继续。
 * 真正的解码与播放仍在页面（WebView）里，这里只负责「别被杀掉 + 系统级控制」。
 */
class PlaybackService : Service() {

    companion object {
        private const val CHANNEL_ID = "hibiki_playback"
        private const val NOTIFY_ID = 2001
        const val ACTION_UPDATE = "com.zai.hibikiplayer.PLAYER_UPDATE"
        const val ACTION_CMD = "com.zai.hibikiplayer.PLAYER_CMD"
        const val ACTION_STOP = "com.zai.hibikiplayer.PLAYER_STOP"
        const val EXTRA_CMD = "cmd"

        /** 页面回调：由 MainActivity 注入（把命令送回 WebView） */
        @Volatile
        var commandSink: ((String) -> Unit)? = null

        @Volatile
        private var instance: PlaybackService? = null

        /**
         * 页面推来的播放状态：驱动前台服务与通知栏 / 锁屏。
         * 服务已经在跑时就地更新——不要每次都 startForegroundService：Android 12+ 从后台
         * 启动前台服务会被系统拒绝，8~11 还要求被拉起的服务在 5 秒内调用 startForeground()，
         * 暂停态的更新走启动路径会把应用搞崩。由 Bridge 保证在主线程调用。
         */
        fun update(
            ctx: Context,
            title: String,
            artist: String,
            album: String,
            playing: Boolean,
            cover: String,
            coverData: String,
            position: Double,
            duration: Double
        ) {
            val svc = instance
            if (svc != null) {
                svc.applyState(title, artist, album, playing, cover, coverData, position, duration, false)
                return
            }
            // 服务不在跑：只有真的开始播放才需要建立它（暂停态没有可显示的东西）
            if (!playing) return
            val i = Intent(ctx, PlaybackService::class.java)
            i.action = ACTION_UPDATE
            i.putExtra("title", title)
            i.putExtra("artist", artist)
            i.putExtra("album", album)
            i.putExtra("playing", playing)
            i.putExtra("cover", cover)
            i.putExtra("coverData", coverData)
            i.putExtra("position", position)
            i.putExtra("duration", duration)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
                else ctx.startService(i)
            } catch (e: Exception) {
                // 后台启动前台服务被系统限制时忽略：页面里的播放不受影响
            }
        }

        fun stop(ctx: Context) {
            try {
                ctx.stopService(Intent(ctx, PlaybackService::class.java))
            } catch (e: Exception) {
            }
        }
    }

    private var session: MediaSession? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var audioManager: AudioManager? = null
    private var focusRequest: AudioFocusRequest? = null
    private val io = Executors.newSingleThreadExecutor()
    private var title = ""
    private var artist = ""
    private var album = ""
    private var coverUrl = ""            // 当前封面地址（也用于判断是否换歌）
    private var coverData = ""           // 页面下采样后直传的封面（data URL），比地址优先
    private var cover: Bitmap? = null
    private var playing = false
    private var foreground = false       // 是否已进入前台服务状态
    private var pausedByFocus = false    // 因音频焦点临时丢失而暂停（焦点回来自动继续）
    private var positionMs = 0L
    private var durationMs = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannel()
        audioManager = getSystemService(AUDIO_SERVICE) as? AudioManager
        val s = MediaSession(this, "HibikiPlayer")
        s.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS or MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS)
        s.setSessionActivity(contentIntent())   // 点锁屏 / 通知上的封面可以回到应用
        s.setCallback(object : MediaSession.Callback() {
            override fun onPlay() = sendUser("play")
            override fun onPause() = sendUser("pause")
            override fun onStop() = sendUser("stop")
            override fun onSkipToNext() = sendUser("next")
            override fun onSkipToPrevious() = sendUser("prev")
            // 锁屏进度条：拖到指定位置（真正的跳转由页面执行）
            override fun onSeekTo(pos: Long) {
                sendUser("seek:" + String.format(Locale.US, "%.3f", pos / 1000.0))
                positionMs = pos
                updateSession()
            }
        })
        s.isActive = true
        session = s
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "hibiki:playback")
        wakeLock?.setReferenceCounted(false)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_CMD -> {
                val cmd = intent.getStringExtra(EXTRA_CMD) ?: ""
                if (cmd == "__dismiss__") {          // 暂停态通知被划掉：收工（页面保持暂停）
                    releaseAll()
                    stopSelf()
                } else sendUser(cmd)
            }
            ACTION_STOP -> {
                releaseAll()
                stopSelf()
            }
            null -> {                                // 服务被系统重新拉起（页面已不在）：收尾退出
                releaseAll()
                stopSelf()
            }
            else -> applyState(
                intent.getStringExtra("title") ?: "",
                intent.getStringExtra("artist") ?: "",
                intent.getStringExtra("album") ?: "",
                intent.getBooleanExtra("playing", false),
                intent.getStringExtra("cover") ?: "",
                intent.getStringExtra("coverData") ?: "",
                intent.getDoubleExtra("position", 0.0),
                intent.getDoubleExtra("duration", 0.0),
                true
            )
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        releaseAll()
        if (instance === this) instance = null
        super.onDestroy()
    }

    /** 任务被划掉：页面（WebView）与本地服务随之消失，通知 / 唤醒锁一并收尾，避免僵尸通知 */
    override fun onTaskRemoved(rootIntent: Intent?) {
        releaseAll()
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    private fun releaseAll() {
        try {
            session?.isActive = false
            session?.release()
        } catch (e: Exception) {
        }
        session = null
        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
        } catch (e: Exception) {
        }
        abandonFocus()
        io.shutdown()
    }

    /** 通知栏 / 锁屏 / 耳机按键 → 页面（属于用户操作，清掉「焦点暂停」标记） */
    private fun sendUser(cmd: String) {
        pausedByFocus = false
        send(cmd)
    }

    private fun send(cmd: String) {
        if (cmd.isEmpty()) return
        commandSink?.invoke(cmd)
    }

    /**
     * 应用一份播放状态。`fromStart` 表示这次是被 startForegroundService 拉起来的：
     * 此时必须调用过 startForeground()（5 秒规则），暂停态也要先进入前台再降级。
     */
    private fun applyState(
        newTitle: String,
        newArtist: String,
        newAlbum: String,
        newPlaying: Boolean,
        newCover: String,
        newCoverData: String,
        position: Double,
        duration: Double,
        fromStart: Boolean
    ) {
        title = newTitle
        artist = newArtist
        album = newAlbum
        positionMs = (position * 1000).toLong()
        durationMs = (duration * 1000).toLong()
        updateCover(newCover, newCoverData)
        val wasPlaying = playing
        playing = newPlaying
        if (playing) pausedByFocus = false
        // 先更新媒体会话（锁屏 / 蓝牙据此显示），再决定前台状态
        updateSession()
        syncForeground(fromStart && !playing)
        if (playing) requestFocus()
        else if (!pausedByFocus) abandonFocus()
        updateWakeLock()
        if (!playing && wasPlaying) refreshNotification()
    }

    /** 播放 → 进入前台（系统不回收）；暂停 → 降级为可划掉的通知，点播放会再次进入前台 */
    private fun syncForeground(ensureStarted: Boolean) {
        try {
            if (playing || ensureStarted) {
                startForeground(NOTIFY_ID, buildNotification())
                foreground = true
            }
            if (!playing && foreground) {
                stopForeground(STOP_FOREGROUND_DETACH)   // 保留通知，用户可划掉
                foreground = false
                refreshNotification()
            }
        } catch (e: Exception) {
            // 后台启动前台服务被系统拦下：至少把通知刷出来（页面里的播放不受影响）
            refreshNotification()
        }
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        val ch = NotificationChannel(CHANNEL_ID, "播放控制", NotificationManager.IMPORTANCE_LOW)
        ch.description = "显示正在播放的歌曲与控制按钮"
        ch.setShowBadge(false)
        nm.createNotificationChannel(ch)
    }

    /* ================= 音频焦点（来电 / 其它播放器） ================= */

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                // 临时让出（来电 / 导航播报）：暂停，焦点回来自动继续
                if (playing) {
                    pausedByFocus = true
                    send("pause")
                }
            }
            AudioManager.AUDIOFOCUS_LOSS -> {
                pausedByFocus = false
                if (playing) send("pause")
            }
            AudioManager.AUDIOFOCUS_GAIN -> {
                if (pausedByFocus) {
                    pausedByFocus = false
                    send("play")
                }
            }
            // AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK：不打断播放（页面只有一个总音量，保持原样）
        }
    }

    private fun requestFocus() {
        val am = audioManager ?: return
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                var req = focusRequest
                if (req == null) {
                    req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                        .setAudioAttributes(
                            AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_MEDIA)
                                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                                .build()
                        )
                        .setOnAudioFocusChangeListener(focusListener)
                        .build()
                    focusRequest = req
                }
                am.requestAudioFocus(req)
            } else {
                @Suppress("DEPRECATION")
                am.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
            }
        } catch (e: Exception) {
        }
    }

    private fun abandonFocus() {
        val am = audioManager ?: return
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                focusRequest?.let { am.abandonAudioFocusRequest(it) }
            } else {
                @Suppress("DEPRECATION")
                am.abandonAudioFocus(focusListener)
            }
        } catch (e: Exception) {
        }
    }

    private fun updateWakeLock() {
        val wl = wakeLock ?: return
        try {
            // 播放期间一直持有（进程退出系统会自动释放），熄屏不会被冻结
            if (playing && !wl.isHeld) wl.acquire()
            else if (!playing && wl.isHeld) wl.release()
        } catch (e: Exception) {
        }
    }

    /* ================= 通知栏 / 锁屏 ================= */

    private fun pending(cmd: String): PendingIntent {
        val i = Intent(this, PlaybackService::class.java)
        i.action = ACTION_CMD
        i.putExtra(EXTRA_CMD, cmd)
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags = flags or PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getService(this, cmd.hashCode(), i, flags)
    }

    private fun contentIntent(): PendingIntent {
        val i = Intent(this, MainActivity::class.java)
        i.flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags = flags or PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getActivity(this, 0, i, flags)
    }

    private fun buildNotification(): Notification {
        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, CHANNEL_ID) else Notification.Builder(this)
        b.setSmallIcon(android.R.drawable.ic_media_play)
        b.setContentTitle(title.ifEmpty { "Hibiki Player" })
        b.setContentText(if (artist.isNotEmpty()) artist else album)
        b.setContentIntent(contentIntent())
        b.setOngoing(playing)
        b.setShowWhen(false)
        if (cover != null) b.setLargeIcon(cover)
        b.addAction(android.R.drawable.ic_media_previous, "上一首", pending("prev"))
        b.addAction(
            if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
            if (playing) "暂停" else "播放", pending("toggle")
        )
        b.addAction(android.R.drawable.ic_media_next, "下一首", pending("next"))
        val style = Notification.MediaStyle()
        style.setShowActionsInCompactView(0, 1, 2)
        session?.let { style.setMediaSession(it.sessionToken) }
        b.setStyle(style)
        b.setVisibility(Notification.VISIBILITY_PUBLIC)
        // 暂停态通知被划掉 = 收工（服务停掉，页面保持暂停）
        b.setDeleteIntent(pending("__dismiss__"))
        return b.build()
    }

    private fun refreshNotification() {
        try {
            val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(NOTIFY_ID, buildNotification())
        } catch (e: Exception) {
        }
    }

    private fun updateSession() {
        val s = session ?: return
        val meta = MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, title)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
            .putString(MediaMetadata.METADATA_KEY_ALBUM, album)
            .putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs)
        cover?.let { meta.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, it) }
        s.setMetadata(meta.build())
        val state = PlaybackState.Builder()
            .setActions(
                PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
                    PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_STOP or
                    PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS or
                    PlaybackState.ACTION_SEEK_TO
            )
            .setState(
                if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
                positionMs, if (playing) 1f else 0f
            )
            .build()
        s.setPlaybackState(state)
    }

    /* ================= 封面 ================= */

    /**
     * 封面有两个来源：
     * - coverData：页面把内嵌封面下采样后直传（本地导入的文件只有页面读得到内嵌图）；
     * - coverUrl：本地服务的 /cover/<id>（B 站下载的曲目把封面存在应用内）。
     * 换歌（地址变化）时清掉旧图，避免上一首的封面留在通知栏。
     */
    private fun updateCover(url: String, data: String) {
        if (data.isNotEmpty() && data != coverData) {
            coverData = data
            coverUrl = url
            val bmp = decodeDataUrl(data)
            if (bmp != null) {
                cover = bmp
                refreshNotification()
                updateSession()
                return
            }
        }
        if (url != coverUrl) {
            coverUrl = url
            coverData = ""
            cover = null
            if (url.isNotEmpty()) loadCover(url) else refreshNotification()
        }
    }

    private fun decodeDataUrl(data: String): Bitmap? {
        return try {
            val comma = data.indexOf(',')
            if (comma < 0) return null
            val bytes = Base64.decode(data.substring(comma + 1), Base64.DEFAULT)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        } catch (e: Exception) {
            null
        }
    }

    /** 通知栏封面：从本地服务 /cover/<id> 取图（失败就退回纯文字通知） */
    private fun loadCover(url: String) {
        try {
            io.execute {
                val bmp = try {
                    val conn = URL(url).openConnection() as HttpURLConnection
                    conn.connectTimeout = 4000
                    conn.readTimeout = 6000
                    conn.inputStream.use { BitmapFactory.decodeStream(it) }
                } catch (e: Exception) {
                    null
                }
                if (bmp == null) return@execute
                if (url != coverUrl || coverData.isNotEmpty()) return@execute   // 已换歌 / 页面已直传封面
                cover = bmp
                refreshNotification()
                updateSession()
            }
        } catch (e: Exception) {
            // 服务正在收尾（线程池已关闭）：忽略
        }
    }
}

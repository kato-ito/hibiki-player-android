<script>
"use strict";
/* ============================================================
   音频引擎 / 元数据 / 歌词
   ============================================================ */

/* ================= 采样率探测（移植桌面版） ================= */
function wavFmt(buf) {
  try {
    var dv = buf instanceof ArrayBuffer ? new DataView(buf)
      : new DataView(buf.buffer, buf.byteOffset, Math.min(buf.byteLength, 4096));
    if (dv.byteLength < 16 || dv.getUint32(0, true) !== 0x46464952) return null;
    var off = 12;
    while (off + 8 <= dv.byteLength) {
      var id = dv.getUint32(off, true), size = dv.getUint32(off + 4, true);
      if (id === 0x20746D66)
        return { ch: dv.getUint16(off + 10, true), rate: dv.getUint32(off + 12, true) };
      off += 8 + size + (size & 1);
    }
  } catch (e) { /* 非 WAV */ }
  return null;
}
function detectRate(head, name) {
  if (!head || head.byteLength < 16) return 0;
  var u8 = head instanceof ArrayBuffer ? new Uint8Array(head)
    : new Uint8Array(head.buffer, head.byteOffset, head.byteLength);
  var ascii = function (o, s) {
    for (var i = 0; i < s.length; i++) if (u8[o + i] !== s.charCodeAt(i)) return false;
    return true;
  };
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) {
    var f = wavFmt(head);
    return f ? f.rate : 0;
  }
  if (ascii(0, "fLaC") && u8.length >= 21) {
    var v = (u8[18] << 12) | (u8[19] << 4) | (u8[20] >> 4);
    return (v >= 3000 && v <= 768000) ? v : 0;
  }
  if (ascii(0, "OggS")) {
    for (var i = 0; i + 16 <= Math.min(u8.length, 4096); i++) {
      if (ascii(i, "OpusHead")) return 48000;
      if (ascii(i, "\x01vorbis")) {
        var vv = (u8[i + 15] << 24) | (u8[i + 14] << 16) | (u8[i + 13] << 8) | u8[i + 12];
        return (vv >= 3000 && vv <= 768000) ? vv : 0;
      }
    }
    return 0;
  }
  if (extOf(name || "") === "mp3" || ascii(0, "ID3") || u8[0] === 0xFF) {
    var off = 0;
    if (ascii(0, "ID3"))
      off = 10 + (((u8[6] & 127) << 21) | ((u8[7] & 127) << 14) | ((u8[8] & 127) << 7) | (u8[9] & 127));
    for (var j = off; j < Math.min(u8.length - 4, off + 8192); j++) {
      var ver = (u8[j + 1] >> 3) & 3, idx = (u8[j + 2] >> 2) & 3;
      var T = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }[ver];
      if ((u8[j] === 0xFF && (u8[j + 1] & 0xE0) === 0xE0) && ver !== 1 && idx < 3 &&
          ((u8[j + 1] >> 1) & 3) !== 0 && ((u8[j + 2] >> 4) & 15) !== 15)
        return T[idx];
    }
    return 0;
  }
  if (/\.(mp4|m4a|m4b|m4v|mov|3gp)$/i.test(name || "")) {
    var be32 = function (o) { return ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0; };
    var type = function (o) { return String.fromCharCode(u8[o + 4], u8[o + 5], u8[o + 6], u8[o + 7]); };
    var walk = function (s, e, fn) {
      for (var o = s; o + 8 <= e; ) {
        var sz = be32(o);
        if (sz < 8) break;
        var r = fn(o + 8, Math.min(e, o + sz), type(o));
        if (r) return r;
        o += sz;
      }
      return 0;
    };
    return walk(0, u8.length, function (bs, be, ty) {
      return ty !== "moov" ? 0 : walk(bs, be, function (s1, e1, t1) {
        if (t1 !== "trak") return 0;
        return walk(s1, e1, function (s2, e2, t2) {
          if (t2 !== "mdia") return 0;
          var isSound = 0, ts = 0;
          walk(s2, e2, function (s3, e3, t3) {
            if (t3 === "hdlr") isSound = ascii(s3 + 8, "soun") ? 1 : 0;
            if (t3 === "mdhd") ts = u8[s3] === 1 ? be32(s3 + 20) : be32(s3 + 12);
            return 0;
          });
          return (isSound && ts) ? ts : 0;
        });
      });
    });
  }
  return 0;
}
async function probeRate(id) {
  try {
    var head = await readBytes(id, 0, 65536);
    return detectRate(head, trackNameOf(id));
  } catch (e) { return 0; }
}

/* ================= AudioContext ================= */
function newCtx(rate) {
  var AC = window.AudioContext || window.webkitAudioContext;
  return rate ? new AC({ sampleRate: rate }) : new AC();
}
function ensureCtx(rate) {
  rate = rate || 0;
  if (rate) rate = Math.min(CTX_RATE_MAX, Math.max(CTX_RATE_MIN, rate));
  if (audioCtx && audioCtx.sampleRate === rate) {
    if (audioCtx.state === "suspended") { try { audioCtx.resume(); } catch (e) {} }
    return audioCtx;
  }
  var nc = null;
  try { nc = newCtx(rate); } catch (e) { nc = null; }
  if (!nc) {
    if (audioCtx) return audioCtx;
    try { nc = newCtx(0); } catch (e2) { return null; }
  }
  var old = audioCtx;
  audioCtx = nc;
  if (old && old !== nc) { try { old.close(); } catch (e3) {} }
  if (audioCtx.state === "suspended") { try { audioCtx.resume(); } catch (e4) {} }
  return audioCtx;
}
function viewMaxHz() {
  return audioCtx ? audioCtx.sampleRate / 2 : 24000;
}
function fmtKhzVal(hz) {
  var k = hz / 1000;
  return (Number.isInteger(k) ? k : +k.toFixed(2)) + " kHz";
}
function updateVizAxis() {
  el("np-viz-axis").textContent = "0–" + fmtKhzVal(viewMaxHz());
}

/* ================= 可视化连接 ================= */
var vizRaf = 0;
function stopVisualizing() {
  if (vizRaf) { cancelAnimationFrame(vizRaf); vizRaf = 0; }
}
var lastLayoutNote = "";   // 本次播放的声道去向说明（状态栏 / 音频数据用）
function connectAnalyser(src, toSpeakers, ch) {
  stopVisualizing();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  analyser.smoothingTimeConstant = 0.72;
  analyser.minDecibels = -90;
  analyser.maxDecibels = -20;
  src.connect(analyser);
  gainNode = null;
  if (toSpeakers) {
    gainNode = audioCtx.createGain();
    gainNode.gain.value = muted ? 0 : volumeVal;
    analyser.connect(gainNode);
    gainNode.connect(audioCtx.destination);
  }
  srcNode = src;
  freqBuf = new Uint8Array(analyser.frequencyBinCount);
  waveBuf = new Uint8Array(analyser.fftSize);

  // 多声道输出：destination 为显式声道数（默认 2）。源多于 2 声道且设备支持时原样直出
  // （5.1 / 7.1 交给系统空间音效渲染）；设备仅立体声时由系统按标准系数下混。
  ch = ch || 2;
  var maxCh = audioCtx.destination.maxChannelCount || 2;
  var outCh = ch > 2 ? Math.min(ch, maxCh) : 2;
  try { audioCtx.destination.channelCount = outCh; } catch (e) { /* 保持默认 */ }
  lastLayoutNote = ch <= 2 ? "" : (outCh >= ch
    ? " · " + layoutName(ch) + " 多声道直出（可由系统空间音效渲染）"
    : " · " + layoutName(ch) + " 已下混为 " + layoutName(outCh) + "（输出设备 " + maxCh + " 声道）");
  updateVizAxis();
}

/* ================= 播放控制 ================= */
function plModeName() {
  for (var i = 0; i < PL_MODES.length; i++) if (PL_MODES[i][0] === plMode) return PL_MODES[i][1];
  return "";
}
function setPlayMode(mode) {
  plMode = mode;
  savePrefs();
  if (media)
    media.loop = (plMode === "one") || (pl.length === 1 && plMode !== "seq");
  renderPlayModeUI();
}
function cyclePlayMode() {
  var i = 0;
  for (; i < PL_MODES.length; i++) if (PL_MODES[i][0] === plMode) break;
  setPlayMode(PL_MODES[(i + 1) % PL_MODES.length][0]);
  showToast("播放模式：" + plModeName());
}
function renderPlayModeUI() {
  el("set-mode-val").textContent = plModeName();
  el("queue-mode").textContent =
    { all: "🔁", one: "🔂", seq: "➡️", shuffle: "🔀" }[plMode] || "";
}
function seekTo(t) {
  if (!media || !isFinite(media.duration) || media.duration <= 0) return;
  media.currentTime = Math.min(media.duration - 0.05, Math.max(0, t));
  updateProgressUI();
  // 暂停状态下拖动进度条也要同步歌词高亮（播放中由每帧循环负责）
  if (npOpen && lyricsOn) syncLyrics(media.currentTime);
}
function seekBy(dt) {
  if (!media || !isFinite(media.duration)) return;
  seekTo(media.currentTime + dt);
}
function togglePlayPause() {
  if (micOn) return;
  if (!media) {
    if (pl.length) playIndex(plIndex);
    return;
  }
  if (media.paused) { media.play().catch(function () {}); }
  else media.pause();
}
function applyVolume() {
  var g = muted ? 0 : volumeVal;
  if (gainNode) gainNode.gain.value = g;
  el("np-vol").value = String(volumeVal);
  el("np-vol-label").textContent = Math.round(g * 100) + "%";
  el("np-mute").textContent = g === 0 ? "🔇" : "🔊";
  savePrefs();
}
function setVolume(v) {
  volumeVal = Math.min(1, Math.max(0, v));
  if (volumeVal > 0) muted = false;
  applyVolume();
}
function toggleMute() {
  muted = !muted;
  applyVolume();
}

/* ================= 播放建立 / 停止 ================= */
async function startTrack(id) {
  // 杜比 / DTS 等特殊编码：交给内置 ffmpeg 解码为 PCM 后播放
  if (isSpecialTrack(id)) return startSpecialTrack(id);
  // .mp4/.m4a 容器里可能是 E-AC-3（B 站杜比下载就是这种）：先按原生探测确认编码再决定
  var preToken = ++startToken;
  var preName = trackNameOf(id) || "";
  if (/^(mp4|m4a|m4b|m4v|mov)$/.test(extOf(preName)) && !codecName(id)) {
    await ensureCodec(id, preName);
    if (preToken !== startToken) return;
    if (isSpecialTrack(id)) return startSpecialTrack(id);
  }
  var token = ++startToken;
  var url = sourceURL(id);
  if (!url || !trackAvailable(id)) return;
  var rate = 0, ch = 2;
  try {
    var head = await readBytes(id, 0, 4096);
    var f = wavFmt(head);
    if (f) { ch = f.ch || 2; rate = f.rate || 0; }
  } catch (e) { /* 按默认处理 */ }
  if (!rate) rate = await probeRate(id);
  if (token !== startToken) return;
  await beginPlayback(url, id, rate, ch);
}

/** 解码后的 PCM 播放：source 为本地服务的 /decoded/<key> 地址 */
async function startDecodedTrack(id, src) {
  await beginPlayback(src.url, id, src.rate, src.channels);
}

/** 真正建立播放：source 为可播放地址（文件 URL / 解码后的 PCM URL） */
async function beginPlayback(url, id, rate, ch) {
  // 先停掉上一首：stopPlayback 内部会递增 startToken（作废更早的播放任务），
  // 因此本次播放的代数号必须在它「之后」取 —— 之前先取会导致下面 error 回调里的
  // token 校验永远不成立，文件读不出来时既不提示也不自动跳下一首。
  stopPlayback(true);
  var token = startToken;
  curKey = id;
  var ctx = ensureCtx(rate);
  if (!ctx) { showToast("无法创建音频上下文"); return; }
  var elm = new Audio(url);
  media = elm;
  media.loop = (plMode === "one") || (pl.length === 1 && plMode !== "seq");
  media.addEventListener("ended", onEnded);
  media.addEventListener("play", syncPlayState);
  media.addEventListener("pause", syncPlayState);
  media.addEventListener("loadedmetadata", function () {
    if (media !== elm) return;
    if (isFinite(elm.duration) && elm.duration > 0) {
      setItemDur(id, elm.duration);
      saveLib();
      renderDetail();
      renderLibrary();
      renderQueue();
    }
  });
  media.addEventListener("error", function () {
    if (media !== elm) return;
    if (token !== startToken) return;
    goneIds.add(id);
    renderDetail(); renderQueue();
    showToast("⚠️ 无法播放（文件不可读或编码不受支持）：" + trackNameOf(id));
    autoNextOnError();
  });
  try { connectAnalyser(ctx.createMediaElementSource(elm), true, ch || 2); }
  catch (e) {
    showToast("音频连接失败：" + (e.message || e));
    stopPlayback();
    return;
  }
  media.play().catch(function () {});
  el("mini-player").classList.remove("gone");
  syncPlayState();
  applyNowMeta();
  updateProgressUI();
  syncMediaSession();
}

/* ---------- 杜比 / DTS 解码播放（内置 ffmpeg） ---------- */
function setRowBusy(id, on) {
  if (on) busyIds[id] = true; else delete busyIds[id];
  renderDetail();
  renderQueue();
}

/** 解码一次并返回可直接播放的地址信息 */
async function decodeSpecial(id, targetChannels, label) {
  var name = trackNameOf(id);
  var size = (registry.get(id) && registry.get(id).size) || 0;
  var info = await bridgeCall("decodeAudio", { id: id, name: name, size: size, channels: targetChannels },
    function (pct) {
      if (decodingId === id) showToast("\uD83C\uDF00 " + label + " 解码中 " + pct + "%", 900);
    });
  var url = decodedURL(info.key);
  // 以实际生成的 WAV 头为准（声道 / 采样率）
  var head = await fetchRange(url, 0, 4096);
  var fmt = wavFmt(head);
  var rate = (fmt && fmt.rate) || info.rate || 0;
  var ch = (fmt && fmt.ch) || info.channels || 2;
  var bytes = info.bytes || 0;
  var dur = (rate > 0 && ch > 0 && bytes > 0) ? bytes / (rate * ch * 2) : (info.duration || 0);
  return {
    url: url, key: info.key, rate: rate, channels: ch, bytes: bytes, duration: dur,
    codec: info.codec || extOf(name), layout: info.layout || "",
    sourceChannels: info.sourceChannels || ch, target: targetChannels
  };
}

/**
 * 特殊编码曲目的播放流程（与桌面版一致）：
 *   1. 先按原始声道布局解码（保留 5.1 / 7.1）；
 *   2. 选择「重编码适配设备」且设备声道不足时，再按设备布局解码一次（多声道降混）；
 *   3. 结果按「文件 + 目标声道」缓存，切回同一首秒开。
 */
async function startSpecialTrack(id) {
  var token = ++startToken;
  var name = trackNameOf(id);
  var ext = extOf(name).toUpperCase();
  if (!NATIVE) {
    showToast("\u26A0\uFE0F " + ext + " 编码需要安卓版内置解码器（当前为浏览器模式），已跳过");
    renderDetail(); renderQueue();
    // 整列表都跳过时必须停下，否则 playIndex ↔ startSpecialTrack 会无限递归（实测栈溢出）
    if (goneNextTries + 1 >= pl.length) { goneNextTries = 0; stopPlayback(); return; }
    return playIndex(plIndex + 1, ++goneNextTries);
  }
  var cacheKey = id + "|" + dolbyMode;   // 输出模式不同 → 结果不同（与桌面版一致）
  var cached = decodedCache.get(cacheKey);
  if (!cached) {
    // 切歌时取消上一个仍在解码的任务
    if (decodingId && decodingId !== id) { try { bridgeCall("cancelDecode", {}); } catch (e) {} }
    decodingId = id;
    setRowBusy(id, true);
    syncPlayState();
    try {
      var first = await decodeSpecial(id, 0, name);
      if (token !== startToken) { decodingId = null; setRowBusy(id, false); return; }
      // 设备声道不足且选择了「重编码适配设备」→ 按设备布局再解码一次
      var ctx = ensureCtx(first.rate);
      var maxCh = (ctx && ctx.destination.maxChannelCount) || 2;
      if (dolbyMode === "device" && first.channels > maxCh) {
        var second = await decodeSpecial(id, maxCh, name);
        if (token !== startToken) { decodingId = null; setRowBusy(id, false); return; }
        second.note = "已由 " + ext + " 解码为 PCM，并重编码为 " + layoutName(second.channels) + "（适配设备）";
        first = second;
      } else {
        first.note = "已由 " + ext + " 解码为 PCM" +
          (first.channels > 2 ? "，" + layoutName(first.channels) + " 原始声道布局" : "");
      }
      cached = first;
      decodedCache.set(cacheKey, cached);
      if (cached.duration > 0) {
        setItemDur(id, cached.duration);   // PCM 体积换算的精确时长
        saveLib();
      }
      showToast("\u2705 " + ext + " 解码完成 · " + (cached.codec || ext) + " " +
        layoutName(cached.channels) + " " + cached.rate + " Hz");
    } catch (err) {
      decodingId = null;
      setRowBusy(id, false);
      if (token !== startToken) return;
      showToast("\u274C 解码失败：" + name + " — " + (err.message || err));
      renderDetail(); renderQueue();
      if (goneNextTries + 1 >= pl.length) { goneNextTries = 0; stopPlayback(); return; }
      return playIndex(plIndex + 1, ++goneNextTries);
    }
    decodingId = null;
    setRowBusy(id, false);
    renderDetail(); renderLibrary(); renderQueue();
  }
  if (token !== startToken) return;
  await startDecodedTrack(id, cached);
}

var goneNextTries = 0;
function autoNextOnError() {
  goneNextTries++;
  if (goneNextTries >= pl.length + 1) { goneNextTries = 0; stopPlayback(); return; }
  playIndex(plIndex + 1, goneNextTries);
}
function stopPlayback(keepMedia) {
  stopVisualizing();
  startToken++;
  // 停止/切歌时取消仍在进行的解码任务，并清除「解码中」标记
  if (decodingId) {
    try { bridgeCall("cancelDecode", {}); } catch (e) { /* 桥不可用则忽略 */ }
    busyIds[decodingId] = false;
    delete busyIds[decodingId];
    decodingId = null;
  }
  if (micStream) {
    micStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    micStream = null;
  }
  if (media) {
    try { media.pause(); } catch (e) {}
    if (!keepMedia) media = null;
  }
  micOn = false;
  goneNextTries = 0;
  el("np-viz-mic").classList.remove("mic-on");
  if (srcNode) { try { srcNode.disconnect(); } catch (e) {} srcNode = null; }
  if (analyser) { try { analyser.disconnect(); } catch (e) {} analyser = null; }
  if (gainNode) { try { gainNode.disconnect(); } catch (e) {} gainNode = null; }
  freqBuf = null; waveBuf = null;
  curKey = null;
  el("mini-player").classList.add("gone");
  el("np-viz-note").textContent = "";
  syncPlayState();
}
function stop() {
  stopPlayback();
  if (npOpen) applyNowMeta();
  renderDetail();
  renderQueue();
  renderLibrary();
}

async function playIndex(i, tries) {
  if (!pl.length) return;
  i = ((i % pl.length) + pl.length) % pl.length;
  plIndex = i;
  lastIdx = i;
  savePrefs();
  var id = pl[i];
  if (!registry.has(id) || goneIds.has(id)) {
    showToast("⚠️ 文件不可读（可能已被移动或删除）：" + itemNameOf(id));
    renderDetail(); renderQueue();
    if ((tries || 0) + 1 >= pl.length) { stopPlayback(); return; }
    return playIndex(i + 1, (tries || 0) + 1);
  }
  await startTrack(id);
}
function onEnded() {
  if (plMode === "shuffle") {
    var n = 0;
    if (pl.length > 1)
      do { n = Math.floor(Math.random() * pl.length); } while (n === plIndex);
    playIndex(n);
  } else if (plMode === "all") {
    playIndex(plIndex + 1);
  } else {
    if (plIndex < pl.length - 1) playIndex(plIndex + 1);
    else stop();
  }
}
function setPlAndPlay(plId, index) {
  var plObj = plById(plId);
  if (!plObj || !plObj.items.length) { showToast("歌单是空的"); return; }
  curPlId = plId;
  pl = plObj.items.map(function (it) { return it.id; });
  saveLib();
  playIndex(index == null ? 0 : index);
}
function playFromItems(plId, trackId) {
  var plObj = plById(plId);
  if (!plObj) return;
  curPlId = plId;
  pl = plObj.items.map(function (it) { return it.id; });
  var idx = pl.indexOf(trackId);
  if (idx < 0) { setPlAndPlay(plId, 0); return; }
  plIndex = idx;
  saveLib();
  playIndex(idx);
}

/* ================= 进度与状态同步 ================= */
function updateProgressUI() {
  var cur = 0, dur = 0;
  if (media && isFinite(media.duration) && media.duration > 0) {
    cur = media.currentTime;
    dur = media.duration;
  }
  el("np-cur").textContent = fmtTime(cur);
  el("np-dur").textContent = media ? fmtTime(dur) : "-:--";
  var frac = dur > 0 ? cur / dur : 0;
  el("np-seek-fill").style.width = (frac * 100) + "%";
  el("np-seek-knob").style.left = (frac * 100) + "%";
  el("mini-progress-fill").style.width = (frac * 100) + "%";
}
function syncPlayState() {
  var playing = !!(media && !media.paused);
  el("mini-play").innerHTML = playing ? svgPause() : svgPlay();
  el("np-play").innerHTML = playing ? svgPause() : svgPlay();
  var miniEq = el("mini-eq");        // 迷你条封面不再叠加播放标识，这里做兼容处理
  var eqs = miniEq ? [miniEq] : [];
  // 队列 / 分类列表（歌曲 · 专辑 · 艺人）的当前曲目高亮随播放状态刷新
  ["detail-list", "queue-list", "group-list", "lib-songs"].forEach(function (bid) {
    var box = el(bid);
    if (!box) return;
    var rows = box.querySelectorAll("li[data-id]");
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle("current", !!curKey && rows[i].dataset.id === curKey);
    }
  });
  eqs.forEach(function (eq) { if (eq) eq.classList.toggle("stopped", !playing); });
  // 正在播放那一行的标题跑马灯（切歌 / 播放暂停都会走到这里）
  if (typeof rowMarqueeSync === "function") rowMarqueeSync();
}
var tickRaf = 0;
function tickLoop() {
  tickRaf = requestAnimationFrame(tickLoop);
  if (media && !media.paused && isFinite(media.duration) && media.duration > 0) {
    updateProgressUI();
    if (npOpen && lyricsOn) syncLyrics(media.currentTime);
  }
  if (npOpen && (vizUIOpen || micOn) && analyser) drawVizFrame();
}

/* ================= MediaSession ================= */
function syncMediaSession() {
  if (!("mediaSession" in navigator)) return;
  try {
    var t = curKey ? itemOf(curKey) : null;
    var meta = t ? metaCache.get(t.id) : null;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t ? ((meta && meta.title) || t.name.replace(/\.[^.]+$/, "")) : "Hibiki Player",
      artist: meta ? (meta.artist || "") : "",
      album: meta ? (meta.album || "") : "",
      artwork: meta && meta.cover ? [{ src: meta.cover, sizes: "512x512" }] : []
    });
    navigator.mediaSession.setActionHandler("play", function () {
      if (!micOn && media && media.paused) media.play().catch(function () {});
    });
    navigator.mediaSession.setActionHandler("pause", function () { if (media) media.pause(); });
    navigator.mediaSession.setActionHandler("previoustrack", function () { if (!micOn && pl.length) playIndex(plIndex - 1); });
    navigator.mediaSession.setActionHandler("nexttrack", function () { if (!micOn && pl.length) playIndex(plIndex + 1); });
  } catch (e) { /* 不支持则忽略 */ }
}

/* ================= 麦克风 ================= */
async function startMic() {
  try {
    stopPlayback();
    micOn = true;
    var ctx = ensureCtx(0);
    if (!ctx) { micOn = false; throw new Error("无法创建音频上下文"); }
    var stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    if (!micOn) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
    micStream = stream;
    connectAnalyser(ctx.createMediaStreamSource(stream), false);
    el("mini-player").classList.add("gone");
    el("np-title").textContent = "🎤 麦克风实时输入";
    el("np-artist").textContent = "";
    showNPArt(null, "🎤");
    el("np-viz-mic").classList.add("mic-on");
    el("np-viz-note").textContent = "实时分析中";
    setNpVizVisible(true);
    showToast("🎤 麦克风输入中（采样率 " + audioCtx.sampleRate + " Hz）");
  } catch (err) {
    micOn = false;
    el("np-viz-mic").classList.remove("mic-on");
    el("np-viz-note").textContent = "";
    showToast("无法访问麦克风：" + (err && err.message ? err.message : err));
  }
}

/* ================= 元数据 / 封面（移植桌面版） ================= */
function latin1(u8) {
  var s = "";
  for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s;
}
function decodeUtf8(u8) {
  try {
    var s = new TextDecoder("utf-8").decode(u8);
    if (s.indexOf("�") < 0) return s;
  } catch (e) {}
  return latin1(u8);
}
function decodeTagText(u8, enc) {
  try {
    if (enc === 1) {
      if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder("utf-16le").decode(u8.subarray(2));
      if (u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder("utf-16be").decode(u8.subarray(2));
      return new TextDecoder("utf-16le").decode(u8);
    }
    if (enc === 2) return new TextDecoder("utf-16be").decode(u8);
    if (enc === 3) return new TextDecoder("utf-8").decode(u8);
  } catch (e) { /* 落到 Latin1 */ }
  return latin1(u8);
}
function sniffMime(u8) {
  if (u8.length > 3 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) return "image/png";
  if (u8.length > 2 && u8[0] === 0xFF && u8[1] === 0xD8) return "image/jpeg";
  if (u8.length > 3 && u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) return "image/gif";
  if (u8.length > 11 && u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 &&
      u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) return "image/webp";
  return "image/jpeg";
}
function bytesToDataURL(u8, mime) {
  var s = "";
  for (var i = 0; i < u8.length; i += 32768)
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768));
  return "data:" + (mime || "image/jpeg") + ";base64," + btoa(s);
}
async function parseID3(f) {
  var head = new Uint8Array(await f.slice(0, 10));
  if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return null;
  var ver = head[3];
  var tagSize = ((head[6] & 127) << 21) | ((head[7] & 127) << 14) | ((head[8] & 127) << 7) | (head[9] & 127);
  // 不依赖外部报告的 size：读取端（HTTP 服务器 / Blob）会自动在文件末尾截断
  var end = Math.min(10 + tagSize, 16 * 1024 * 1024);
  if (end <= 10) return null;
  var buf = new Uint8Array(await f.slice(10, end));
  var dv = new DataView(buf.buffer);
  var out = { title: "", artist: "", album: "", cover: null };
  var hdLen = ver === 2 ? 6 : 10;
  var off = 0;
  while (off + hdLen <= buf.length) {
    var id, fsz;
    if (ver === 2) {
      id = latin1(buf.subarray(off, off + 3));
      fsz = (buf[off + 3] << 16) | (buf[off + 4] << 8) | buf[off + 5];
    } else if (ver === 3) {
      id = latin1(buf.subarray(off, off + 4));
      fsz = dv.getUint32(off + 4);
    } else {
      id = latin1(buf.subarray(off, off + 4));
      fsz = ((buf[off + 4] & 127) << 21) | ((buf[off + 5] & 127) << 14) | ((buf[off + 6] & 127) << 7) | (buf[off + 7] & 127);
    }
    if (!/^[A-Z0-9]{3,4}$/.test(id) || fsz <= 0 || off + hdLen + fsz > buf.length) break;
    var body = buf.subarray(off + hdLen, off + hdLen + fsz);
    var text = function () {
      return body.length
        ? decodeTagText(body.subarray(1), body[0]).replace(/\0+$/g, "").replace(/\0/g, " / ").trim() : "";
    };
    if (id === "TIT2" || id === "TT2") out.title = text();
    else if (id === "TPE1" || id === "TP1") out.artist = text();
    else if (id === "TALB" || id === "TAL") out.album = text();
    else if ((id === "APIC" || id === "PIC") && !out.cover) {
      try {
        var enc = body[0];
        var p = 1, mime = "image/jpeg";
        if (ver === 2) {
          mime = "image/" + latin1(body.subarray(p, p + 3)).toLowerCase();
          p += 3;
        } else {
          var z = p;
          while (z < body.length && body[z] !== 0) z++;
          var m = latin1(body.subarray(p, z)).trim().toLowerCase();
          if (m) mime = m.indexOf("image/") === 0 ? m : "image/" + m;
          p = z + 1;
        }
        if (mime === "image/jpg" || mime === "image/-->" || mime.indexOf("image/") !== 0) mime = "image/jpeg";
        p += 1;
        if (enc === 1 || enc === 2) {
          while (p + 1 < body.length && !(body[p] === 0 && body[p + 1] === 0)) p += 2;
          p += 2;
        } else {
          while (p < body.length && body[p] !== 0) p++;
          p += 1;
        }
        var data = body.subarray(p);
        if (data.length > 100) out.cover = bytesToDataURL(data, sniffMime(data));
      } catch (e2) { /* 封面解析失败不致命 */ }
    }
    off += hdLen + fsz;
  }
  return (out.title || out.artist || out.album || out.cover) ? out : null;
}
function be32at(u8, o) {
  return ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
}
function le32at(u8, o) {
  return (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0;
}
async function parseFLAC(f) {
  var head = new Uint8Array(await f.slice(0, 42));
  if (head.length < 4 || !(head[0] === 0x66 && head[1] === 0x4C && head[2] === 0x61 && head[3] === 0x43)) return null;
  var out = { title: "", artist: "", album: "", cover: null };
  // 不依赖外部报告的 size：读取端会在文件末尾截断
  var headLen = 24 * 1024 * 1024;
  var buf = new Uint8Array(await f.slice(0, headLen));
  var pos = 4, last = false;
  while (pos + 4 <= buf.length && !last) {
    last = !!(buf[pos] & 0x80);
    var type = buf[pos] & 0x7F;
    var len = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
    var body = pos + 4;
    if (body + len > buf.length) break;
    if (type === 4) {
      // VORBIS_COMMENT：vendor 长度 + vendor + 注释条数 + 注释
      // 注意：Vorbis 注释内部字段是小端序（与 FLAC 图片块的大端序不同）
      var vlen = le32at(buf, body);
      var p2 = body + 4 + vlen;
      if (p2 + 4 <= body + len) {
        var count = le32at(buf, p2);
        p2 += 4;
        for (var ci = 0; ci < count && p2 + 4 <= body + len; ci++) {
          var l2 = le32at(buf, p2);
          var s2 = decodeUtf8(buf.subarray(p2 + 4, Math.min(p2 + 4 + l2, body + len)));
          var eq = s2.indexOf("=");
          if (eq > 0) {
            var k = s2.slice(0, eq).toUpperCase(), v2 = s2.slice(eq + 1);
            if (k === "TITLE" && !out.title) out.title = v2;
            else if (k === "ARTIST" && !out.artist) out.artist = v2;
            else if (k === "ALBUM" && !out.album) out.album = v2;
          }
          p2 += 4 + l2;
        }
      }
    } else if (type === 6 && !out.cover) {
      // FLAC 图片块：类型(4) + MIME长度(4) + MIME + 描述长度(4) + 描述 + 宽高深色(16) + 数据长度(4) + 数据
      // 各写入器对「MIME 的 NUL 是否计入长度」并不一致（实测 ffmpeg 不计入），
      // 逐个字段偏移很容易差 1 字节导致封面无法解码 —— 这里直接在块内按图片签名定位，
      // 数据一定在块尾，因此从签名处取到块尾即可，不依赖任何长度字段。
      var start = -1, mime = "";
      var scanEnd = Math.min(body + 64, body + len);
      for (var s = body; s + 3 < scanEnd; s++) {
        if (buf[s] === 0xFF && buf[s + 1] === 0xD8 && buf[s + 2] === 0xFF) { start = s; mime = "image/jpeg"; break; }
        if (buf[s] === 0x89 && buf[s + 1] === 0x50 && buf[s + 2] === 0x4E) { start = s; mime = "image/png"; break; }
        if (buf[s] === 0x47 && buf[s + 1] === 0x49 && buf[s + 2] === 0x46) { start = s; mime = "image/gif"; break; }
      }
      if (start > 0) {
        var img = buf.subarray(start, body + len);
        if (img.length > 100) out.cover = bytesToDataURL(img, mime);
      }
    }
    pos = body + len;
  }
  return (out.title || out.artist || out.album || out.cover) ? out : null;
}
async function parseMP4(f) {
  var out = { title: "", artist: "", album: "", cover: null };
  // vfileOf().slice 的语义是 (offset, length)；这里统一按「起止偏移」封装，避免多读整文件
  var readAt = async function (start, end) {
    var len = Math.max(0, Math.floor(end - start));
    if (!len) return new Uint8Array(0);
    return new Uint8Array(await f.slice(start, len));
  };
  var head = await readAt(0, 8);
  if (head.length < 8) return null;
  var be32 = function (u8, o) { return ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0; };
  var fourcc = function (u8, o) { return String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]); };
  if (fourcc(head, 4) !== "ftyp") return null;
  var ftyp = await readAt(8, Math.min(f.size || 4096, 4096));
  var ok = false;
  for (var b = 0; b + 4 <= ftyp.length; b += 4) {
    var bt = fourcc(ftyp, b);
    if (bt === "M4A " || bt === "M4B " || bt === "isom" || bt === "iso2" ||
        bt === "mp41" || bt === "mp42" || bt === "M4V " || bt === "qt  ") ok = true;
  }
  if (!ok) return null;
  var readIlst = async function (start, end) {
    var off = start;
    while (off + 8 <= end) {
      var h = await readAt(off, off + 8);
      if (h.length < 8) break;
      var sz = be32(h, 0);
      var ty = fourcc(h, 4);
      if (sz < 8 || off + sz > end) break;
      var bs = off + 8, be = off + sz;
      var txt = null;
      if ((ty === "©nam" || ty === "©ART" || ty === "©alb" || ty === "covr") && bs + 8 <= be) {
        var dh = await readAt(bs, bs + 8);
        var dsz = be32(dh, 0);
        if (fourcc(dh, 4) === "data" && dsz >= 16 && bs + dsz <= be) {
          var p = bs + 16;
          if (ty === "covr") {
            var img = await readAt(p, bs + dsz);
            if (img.length > 100) out.cover = bytesToDataURL(img, sniffMime(img));
          } else {
            // 文本载荷：最多读 512 字节，遇 NUL 截断（data 原子长度为准）
            var tb = await readAt(p, Math.min(bs + dsz, p + 512));
            txt = decodeUtf8(tb).replace(/\0[\s\S]*$/, "").trim();
          }
        }
      }
      if (ty === "©nam" && txt && !out.title) out.title = txt;
      else if (ty === "©ART" && txt && !out.artist) out.artist = txt;
      else if (ty === "©alb" && txt && !out.album) out.album = txt;
      off += sz;
    }
  };
  var walk = async function (start, end, depth) {
    var off = start;
    while (off + 8 <= end && depth < 8) {
      var h = await readAt(off, off + 8);
      if (h.length < 8) break;
      var sz = be32(h, 0);
      var ty = fourcc(h, 4);
      var hd = 8;
      if (sz === 1) {
        var ext = await readAt(off + 8, off + 16);
        if (ext.length < 8) break;
        var hi = 0, lo = 0;
        for (var k = 0; k < 4; k++) { hi = hi * 256 + ext[k]; lo = lo * 256 + ext[k + 4]; }
        sz = hi * 4294967296 + lo;
        hd = 16;
      } else if (sz === 0) {
        sz = end - off;
      }
      if (sz < hd || off + sz > end) break;
      if (ty === "moov" || ty === "udta" || ty === "trak" || ty === "mdia") {
        await walk(off + hd, off + sz, depth + 1);
      } else if (ty === "meta") {
        await walk(off + hd + 4, off + sz, depth + 1);
      } else if (ty === "ilst") {
        await readIlst(off + hd, off + sz);
      }
      off += sz;
    }
  };
  // 不依赖外部报告的 size：读取端会在文件末尾截断
  await walk(0, 128 * 1024 * 1024, 0);
  return (out.title || out.artist || out.album || out.cover) ? out : null;
}
// 裸流容器：封面/标签由前置 ID3v2 携带（下载时写入，见 Id3Tag.kt）
var RAW_ID3_EXTS = ["ac3", "eac3", "dts", "dtshd", "dtsma", "thd", "truehd", "wma", "wmav2", "wmapro", "ape", "wv"];
async function readTags(f) {
  try {
    var ext = extOf(f.name || "");
    if (ext === "mp3" || ext === "aac") return await parseID3(f);
    if (RAW_ID3_EXTS.indexOf(ext) >= 0) return await parseID3(f);   // 无 ID3 时 parseID3 会返回 null
    if (ext === "flac") return await parseFLAC(f);
    if (["m4a", "m4b", "m4v", "mp4", "mov"].indexOf(ext) >= 0) return await parseMP4(f);
  } catch (e) { /* 无标签 */ }
  return null;
}
/**
 * 标签文本清洗：去掉控制字符；若替换字符（U+FFFD）比例过高说明编码解析失败，
 * 直接判为空 —— 让界面回退到文件名，避免歌单里出现乱码标题。
 */
function cleanTagText(s) {
  var t = String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  if (!t) return "";
  var bad = (t.match(/\ufffd/g) || []).length;
  if (bad && bad / t.length > 0.2) return "";       // 编码声明与实际不符：大量替换字符
  // 经典 mojibake：按 Latin-1 误读 UTF-8 得到的字符（几乎全是 U+00A0–U+00FF，且没有任何正常字符）
  var latin1 = (t.match(/[\u00a0-\u00ff]/g) || []).length;
  var normal = (t.match(/[\u4e00-\u9fff\u3040-\u30ffA-Za-z0-9]/g) || []).length;
  if (t.length >= 4 && latin1 / t.length > 0.5 && normal === 0) return "";
  return t.length > 80 ? t.slice(0, 80) : t;
}
var metaWaiters = new Map();   // trackId -> [resolve...]（元数据解析完成通知）
function metaSettle(id, meta) {
  meta.loaded = true;
  var ws = metaWaiters.get(id);
  if (ws) {
    metaWaiters.delete(id);
    for (var i = 0; i < ws.length; i++) { try { ws[i](meta); } catch (e) { /* 忽略 */ } }
  }
}
function trackMeta(id) {
  var meta = metaCache.get(id);
  if (meta) return meta;
  meta = { title: "", artist: "", album: "", cover: null, loaded: false };
  // 冷启动时本机音频库可能尚未注册完成：此时不写入缓存，留待注册后重试，
  // 否则空元数据会被永久缓存，导致专辑 / 艺人归类错误。
  if (!trackAvailable(id)) { meta.loaded = true; return meta; }
  metaCache.set(id, meta);
  var name = trackNameOf(id);
  var vf;
  try { vf = vfileOf(id); } catch (e) { metaCache.delete(id); metaSettle(id, meta); return meta; }
  vf.name = name;
  tagQueue.push(function () {
    return readTags(vf).then(function (m) {
      if (m) {
        meta.title = cleanTagText(m.title);
        meta.artist = cleanTagText(m.artist);
        meta.album = cleanTagText(m.album);
        meta.cover = m.cover || null;
      }
      if (!meta.title && !meta.cover) return askStoredTags(id, meta);   // 裸流：标签存在应用内
      metaSettle(id, meta);
      scheduleMetaRefresh();
    }).catch(function () {
      // 读不到标签（例如裸流容器没有标签、或文件暂时读不到）→ 再问一次应用内记录
      return askStoredTags(id, meta);
    });
  });
  pumpTagQueue();
  return meta;
}
/* 标签到达后的刷新合并：几十上百首陆续解析完时，逐个 renderDetail/Library 会
   反复重建整个列表（既卡顿，也会让正在点击的行被替换掉），这里合并成一次刷新。 */
var metaRefreshTimer = 0;
function scheduleMetaRefresh() {
  if (metaRefreshTimer) return;
  metaRefreshTimer = setTimeout(function () {
    metaRefreshTimer = 0;
    applyNowMeta();
    renderDetail();
    renderLibrary();
    renderQueue();
    if (typeof scheduleBrowseRefresh === "function") scheduleBrowseRefresh();
  }, 120);
}

/**
 * 裸流（E-AC-3 / AC-3 / DTS …）容器装不下封面与标签，下载时由原生把标题 / UP主 / 专辑 / 封面
 * 记在应用内（TrackTags）。这里在文件本身没有标签时向原生要一次，并写入 metaCache。
 */
var storedTagAsked = new Set();
function askStoredTags(id, meta) {
  if (!NATIVE || storedTagAsked.has(id)) { metaSettle(id, meta); return Promise.resolve(meta); }
  storedTagAsked.add(id);
  return bridgeCall("trackMeta", { id: id }).then(function (r) {
    if (r) {
      if (r.title) meta.title = cleanTagText(r.title);
      if (r.artist) meta.artist = cleanTagText(r.artist);
      if (r.album) meta.album = cleanTagText(r.album);
      if (r.coverUrl) meta.cover = r.coverUrl;
    }
    metaSettle(id, meta);
    scheduleMetaRefresh();
    return meta;
  }).catch(function () {
    metaSettle(id, meta);
    return meta;
  });
}

/* 标签读取并发限制：歌单里几十上百首时若一次性全部发起 Range 请求，
   本地服务与 WebView 都会排队/超时，结果是「只有一小部分封面能显示出来」。 */
var tagQueue = [], tagRunning = 0, TAG_CONC = 3;
function pumpTagQueue() {
  while (tagRunning < TAG_CONC && tagQueue.length) {
    var job = tagQueue.shift();
    tagRunning++;
    Promise.resolve()
      .then(job)
      .catch(function () {})
      .then(function () { tagRunning--; pumpTagQueue(); });
  }
}
// 元数据解析完成后的 Promise（已解析则立即兑现）
function ensureMeta(id) {
  var meta = metaCache.get(id);
  if (meta && meta.loaded) return Promise.resolve(meta);
  if (!meta) meta = trackMeta(id);
  return new Promise(function (res) {
    if (meta.loaded) { res(meta); return; }
    var ws = metaWaiters.get(id);
    if (!ws) { ws = []; metaWaiters.set(id, ws); }
    ws.push(res);
  });
}

/* ================= 歌词 ================= */
function parseLRC(text) {
  var out = [];
  var tagRe = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  var lines = String(text || "").split(/\r\n|\n|\r/);
  for (var i = 0; i < lines.length; i++) {
    var raw = lines[i];
    var times = [];
    var m, end = 0;
    tagRe.lastIndex = 0;
    while ((m = tagRe.exec(raw)) && m.index === end) {
      times.push(+m[1] * 60 + +m[2] + (m[3] ? parseFloat("0." + m[3]) : 0));
      end = tagRe.lastIndex;
    }
    var txt = raw.slice(end).replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, "").trim();
    if (times.length && txt)
      for (var j = 0; j < times.length; j++) out.push({ t: times[j], text: txt });
  }
  out.sort(function (a, b) { return a.t - b.t; });
  return out;
}
var lrcLines = [], lrcLineEls = [], lrcIdx = -1;
var lrcFollowPauseUntil = 0;
function setLyricsFor(id, text) {
  if (id) lrcLib.set(id, text);
  saveLrc();
  renderNpLyrics();
}
function renderNpLyrics() {
  var text = curKey ? lrcLib.get(curKey) : null;
  lrcLines = text ? parseLRC(text) : [];
  lrcIdx = -1;
  lrcLineEls = [];
  var inner = el("np-lyrics-inner");
  inner.innerHTML = "";
  inner.style.transform = "";
  el("np-lyrics").classList.toggle("empty", !lrcLines.length);
  for (var i = 0; i < lrcLines.length; i++) {
    var div = document.createElement("div");
    div.className = "np-line";
    div.textContent = lrcLines[i].text;
    (function (t) {
      div.addEventListener("click", function (ev) {
        ev.stopPropagation();
        if (!media || micOn) return;
        seekTo(t);
      });
    })(lrcLines[i].t);
    inner.appendChild(div);
    lrcLineEls.push(div);
  }
  if (media) syncLyrics(media.currentTime);
}
function syncLyrics(t) {
  if (!lrcLines.length) return;
  var idx = -1;
  var lo = 0, hi = lrcLines.length - 1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    if (lrcLines[mid].t <= t) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (idx !== lrcIdx) {
    lrcIdx = idx;
    for (var i = 0; i < lrcLineEls.length; i++)
      lrcLineEls[i].classList.toggle("cur", i === idx);
    if (idx >= 0 && Date.now() >= lrcFollowPauseUntil) {
      var c = el("np-lyrics");
      var line = lrcLineEls[idx];
      var offset = c.clientHeight / 2 - (line.offsetTop + line.offsetHeight / 2);
      el("np-lyrics-inner").style.transform = "translateY(" + offset + "px)";
    }
  }
}
</script>

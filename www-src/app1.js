<script>
"use strict";
/* ============================================================
   Hibiki Player（安卓版）核心引擎
   ============================================================ */

/* ================= 常量 ================= */
var APP_VERSION = "2.30.0";   // 与 android/app/build.gradle.kts 的 versionName 保持一致
var IMPORT_EXTS = new Set(["mp3","flac","wav","ogg","oga","opus","m4a","m4b","mp4","m4v","aac","wma","aif","aiff","ape","wv","ac3","eac3","dts","thd","truehd","mkv","mka","webm","mid","midi","amr"]);
var FFMPEG_EXTS = new Set(["ac3","eac3","thd","truehd","dts","dtsma","dtshd","wma","wmav2","wmapro","aif","aiff","ape","wv","mka"]);
var VIDEO_EXTS = new Set(["mp4","m4v","mkv","webm","mov","avi"]);
var PL_MODES = [
  ["all", "列表循环"],
  ["one", "单曲循环"],
  ["seq", "顺序播放"],
  ["shuffle", "随机播放"]
];
var THEMES = [
  { key: "green", name: "暗夜绿", sw: "#37d67a" },
  { key: "white", name: "白色",   sw: "#fa2d48" },
  { key: "sony",  name: "复古",   sw: "#00dfc9" }
];
var CTX_RATE_MIN = 8000, CTX_RATE_MAX = 96000;
var DRAG_HOLD_MS = 350, DRAG_SLOP_PX = 7;
var FFT_SIZE = 2048;

/* ================= 工具 ================= */
function extOf(name) {
  var m = /\.([^.]+)$/.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}
function fmtTime(t) {
  if (!isFinite(t) || t < 0) return "-:--";
  t = Math.round(t);
  var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? h + ":" + (m < 10 ? "0" : "") : "") + m + ":" + (s < 10 ? "0" : "") + s;
}
function fmtTimeShort(t) {
  return fmtTime(t);
}
function hashStr(s) {
  var h = 2166136261 >>> 0;
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16) + "_" + s.length.toString(16);
}
function isAudioFile(f) {
  return (f.type && (f.type.indexOf("audio/") === 0 || f.type.indexOf("video/") === 0)) ||
         IMPORT_EXTS.has(extOf(f.name));
}
function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), "zh-Hans-CN", { numeric: true });
}
function el(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function svgNote() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>';
}
function svgPlay() {
  return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>';
}
function svgPause() {
  return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
}

/* ================= 提示 ================= */
var toastTimer = 0;
function showToast(text, ms) {
  var t = el("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.remove("show"); }, ms || 2400);
}

/* ================= 跑马灯引擎（超出即滚动，一轮后停 6 秒） ================= */
var marqueeList = [];
function Marq(container, opt) {
  this.c = container; this.raf = 0; this.span = null; this.phase = "idle";
  this.holdUntil = 0; this.t0 = 0; this.dx = 0; this.dur = 0; this.x = 0;
  this._text = null;
  // 节奏可调（默认与迷你播放条一致：首轮停 6s、两轮之间停 6s）
  this.hold1 = (opt && opt.hold1) || 6000;     // 首次滚动前停留
  this.hold2 = (opt && opt.hold2) || 6000;     // 两轮之间停留
  this.speed = (opt && opt.speed) || 0.045;    // 滚动速度 px/ms
}
Marq.prototype.setText = function (text) {
  if (text === this._text) return;
  this._text = text;
  this.stop();
  this.c.innerHTML = "";
  if (!text) return;
  var span = document.createElement("span");
  span.className = "mq";
  span.textContent = text;
  this.c.appendChild(span);
  this.span = span;
  this.x = 0;
  span.style.transform = "";
  this.measure();
};
Marq.prototype.measure = function () {
  var self = this;
  requestAnimationFrame(function () {
    if (!self.span || !self.span.parentNode) return;
    var overflow = self.span.scrollWidth - self.c.clientWidth;
    if (overflow > 2) {
      self.dx = overflow + 24;
      self.dur = Math.max(1800, self.dx / self.speed);
      self.phase = "hold1";
      self.holdUntil = Date.now() + self.hold1;
      if (!self.raf) self.raf = requestAnimationFrame(marqTick);
    } else {
      self.phase = "idle";
    }
  });
};
function marqTick() {
  var i, m, now = Date.now(), any = false;
  for (i = 0; i < marqueeList.length; i++) {
    m = marqueeList[i];
    if (!m.span || !m.span.parentNode) { m.raf = 0; continue; }
    if (m.phase === "idle") { continue; }
    any = true;
    if (m.phase === "hold1") {
      if (now >= m.holdUntil) { m.phase = "go"; m.t0 = now; }
    } else if (m.phase === "go") {
      var p = (now - m.t0) / m.dur;
      if (p >= 1) { m.x = -m.dx; m.span.style.transform = "translateX(" + m.x + "px)"; m.phase = "hold2"; m.holdUntil = now + m.hold2; }
      else {
        p = 1 - Math.pow(1 - p, 3);
        m.x = -m.dx * p;
        m.span.style.transform = "translateX(" + m.x + "px)";
      }
    } else if (m.phase === "hold2") {
      if (now >= m.holdUntil) { m.phase = "go"; m.t0 = now; m.x = 0; m.span.style.transform = ""; }
    }
  }
  var next = false;
  for (i = 0; i < marqueeList.length; i++) if (marqueeList[i].phase !== "idle" && marqueeList[i].raf !== 0) next = true;
  if (next) requestAnimationFrame(marqTick);
}
Marq.prototype.stop = function () {
  this.phase = "idle";
  if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
};
function makeMarquee(elId) {
  var m = new Marq(el(elId));
  marqueeList.push(m);
  return m;
}

/* ================= 封面占位渐变 ================= */
function coverGradient(name) {
  var h = 0, i;
  for (i = 0; i < (name || "").length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  var a = h % 360, b = (a + 40 + ((h >> 4) % 80)) % 360;
  var light = document.body.getAttribute("data-theme") === "white";
  return light
    ? "linear-gradient(135deg, hsl(" + a + ",44%,64%), hsl(" + b + ",46%,78%))"
    : "linear-gradient(135deg, hsl(" + a + ",58%,42%), hsl(" + b + ",52%,18%))";
}
function phHTML() { return svgNote(); }

/* ================= 状态 ================= */
var lib = [];                 // { id, name, coverMode, coverImageId, items: [{id,name,dur}] }
var curPlId = null;           // 当前打开的歌单 id
var registry = new Map();     // trackId -> { id, name, size, source }
var metaCache = new Map();    // trackId -> { title, artist, album, cover }
var lrcLib = new Map();       // trackId -> lrc 文本
var goneIds = new Set();      // 本次会话中确认已不可读的 trackId
var pl = [];                  // 当前播放歌单的曲目 id 列表
var plIndex = 0;
var curKey = null;            // 正在播放曲目 id
var plMode = "all";
var media = null, mediaURL = null;
var audioCtx = null, analyser = null, gainNode = null, srcNode = null;
var startToken = 0;
var micStream = null, micOn = false;
var volumeVal = 1, muted = false;
var vizOn = false, vizTab = "spec";
var npOpen = false, lyricsOn = false, vizUIOpen = false;
var probeGen = 0;
var freqBuf = null, waveBuf = null;

/* ================= 持久化 ================= */
function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function lsSet(key, val) { try { localStorage.setItem(key, val); return true; } catch (e) { return false; } }
function lsDel(key) { try { localStorage.removeItem(key); } catch (e) {} }

function saveLib() {
  // songs = 资料库歌曲（导入过的歌），与歌单无关：删歌单不会删歌
  var data = { v: 1, curPlId: curPlId, playlists: lib, songs: libSongs };
  lsSet("hpa.lib.v1", JSON.stringify(data));
}
function loadLib() {
  var raw = lsGet("hpa.lib.v1");
  if (!raw) return;
  try {
    var data = JSON.parse(raw);
    if (!data || data.v !== 1 || !Array.isArray(data.playlists)) return;
    lib = data.playlists.filter(function (p) {
      return p && typeof p.id === "string" && typeof p.name === "string" && Array.isArray(p.items);
    }).map(function (p) {
      return {
        id: p.id, name: p.name,
        coverMode: p.coverMode === "last" || p.coverMode === "custom" ? p.coverMode : "first",
        coverImageId: typeof p.coverImageId === "string" ? p.coverImageId : null,
        items: p.items.filter(function (it) { return it && typeof it.id === "string"; })
          .map(function (it) {
            var o = { id: it.id, name: it.name || "", dur: typeof it.dur === "number" ? it.dur : null };
            if (typeof it.codec === "string" && it.codec) o.codec = it.codec;   // 容器内的音频编码（如 .mp4 里的 ec-3）
            return o;
          })
      };
    });
    if (typeof data.curPlId === "string" && lib.some(function (p) { return p.id === data.curPlId; }))
      curPlId = data.curPlId;
    else curPlId = lib.length ? lib[0].id : null;
    // 资料库歌曲（老版本没有这个字段 → 用各歌单里的歌兜底，保证升级后不丢）
    libSongs = Array.isArray(data.songs) ? data.songs.filter(function (s) {
      return s && typeof s.id === "string";
    }).map(function (s) {
      var o = { id: s.id, name: s.name || "", dur: typeof s.dur === "number" ? s.dur : null };
      if (typeof s.codec === "string" && s.codec) o.codec = s.codec;
      return o;
    }) : [];
    libGone = Array.isArray(data.songsGone) ? data.songsGone.filter(function (x) { return typeof x === "string"; }) : [];
    if (!libSongs.length) {
      var seen0 = {};
      lib.forEach(function (p) { p.items.forEach(function (it) { if (!seen0[it.id] && libGone.indexOf(it.id) < 0) { seen0[it.id] = 1; libSongs.push(it); } }); });
    }
  } catch (e) { lib = []; curPlId = null; }
}
function savePrefs() {
  lsSet("hpa.prefs.v1", JSON.stringify({
    v: 1, mode: plMode, volume: volumeVal, muted: muted,
    theme: document.body.getAttribute("data-theme") || "green",
    bg: bgStore, bgDim: bgDim,
    viz: vizOn, vizTab: vizTab, mic: micOn, lastIdx: plIndex,
    dolbyMode: dolbyMode,
    libTab: (typeof libTab === "string" ? libTab : "lists"),
    biliDir: (typeof biliDirUri === "string" ? biliDirUri : ""),
    biliDirName: (typeof biliDirName === "string" ? biliDirName : ""),
    biliSpeed: (typeof biliSpeed === "number" ? biliSpeed : 0),
    biliPl: (typeof biliPl === "string" ? biliPl : ""),          // B 站下载放入的歌单 id（空 = 默认「B站下载」）
    songsGone: (typeof libGone !== "undefined" ? libGone : []),  // 被「从资料库移除」过的曲目 id（重启后不再自动加回）
    songSort: (typeof songSort === "string" ? songSort : "default"),
    sortDir: (typeof sortDir === "string" ? sortDir : "asc")
  }));
}
function loadPrefs() {
  var raw = lsGet("hpa.prefs.v1");
  if (!raw) return;
  try {
    var p = JSON.parse(raw);
    if (!p || p.v !== 1) return;
    if (PL_MODES.some(function (m) { return m[0] === p.mode; })) plMode = p.mode;
    if (typeof p.volume === "number") volumeVal = Math.min(1, Math.max(0, p.volume));
    muted = !!p.muted;
    if (typeof p.bgDim === "number") bgDim = Math.min(0.92, Math.max(0.1, p.bgDim));
    bgStore = (typeof p.bg === "string" && p.bg) ? p.bg : null;
    vizOn = !!p.viz;
    vizTab = p.vizTab === "wave" ? "wave" : "spec";
    dolbyMode = p.dolbyMode === "device" ? "device" : "native";
    if (typeof libTab === "string" && ["lists", "songs", "albums", "artists"].indexOf(p.libTab) >= 0)
      libTab = p.libTab;
    if (typeof p.biliDir === "string") biliDirUri = p.biliDir;
    if (typeof p.biliDirName === "string") biliDirName = p.biliDirName;
    if (typeof p.biliSpeed === "number") biliSpeed = Math.max(0, p.biliSpeed);
    if (typeof p.biliPl === "string") biliPl = p.biliPl;
    if (SONG_SORTS.indexOf(p.songSort) >= 0) songSort = p.songSort;
    if (p.sortDir === "desc" || p.sortDir === "asc") sortDir = p.sortDir;
    micOn = !!p.mic;
    lastIdx = typeof p.lastIdx === "number" ? p.lastIdx : 0;
  } catch (e) { /* 忽略 */ }
}
var lastIdx = 0;
function saveLrc() {
  var out = {};
  lrcLib.forEach(function (v, k) { out[k] = v; });
  var json = JSON.stringify(out);
  if (json.length > 400000) { showToast("歌词数据过大，仅保留本次会话"); return; }
  lsSet("hpa.lrc.v1", json);
}
function loadLrc() {
  var raw = lsGet("hpa.lrc.v1");
  if (!raw) return;
  try {
    var o = JSON.parse(raw);
    for (var k in o) if (typeof o[k] === "string") lrcLib.set(k, o[k]);
  } catch (e) { /* 忽略 */ }
}

/* ================= 主题与背景 ================= */
function applyTheme(key) {
  if (!THEMES.some(function (t) { return t.key === key; })) key = "green";
  document.body.setAttribute("data-theme", key);
  renderSwatches();
  savePrefs();
  refreshAllCovers();
}
function refreshAllCovers() {
  renderLibrary();
  renderDetail();
  applyNowMeta();
  if (npOpen) renderQueue();
}
var bgStore = null, bgDim = 0.55;
function applyBG(val) {
  bgStore = val;
  if (val) {
    var css = val.indexOf("id:") === 0
      ? "url(" + imageURL(val.slice(3)) + ")"
      : "url(" + val + ")";
    document.body.classList.add("has-bg");
    document.body.style.setProperty("--bg-img", css);
  } else {
    document.body.classList.remove("has-bg");
    document.body.style.setProperty("--bg-img", "none");
  }
  document.body.style.setProperty("--bg-dim", String(bgDim));
  savePrefs();
}
function applyBGDim(v) {
  bgDim = v;
  document.body.style.setProperty("--bg-dim", String(v));
  savePrefs();
}
function imageURL(id) {
  return BOOT ? BOOT.base + "/image/" + encodeURIComponent(id) : id;
}

/* ================= 文件层（安卓桥 / 浏览器回退） ================= */
// 安卓版由本地 HTTP 服务托管（http://127.0.0.1:端口/）：base 即当前 origin
var BOOT = window.__HIBIKI_BOOT__ ||
  ((location.protocol === "http:" || location.protocol === "https:") ? { base: location.origin } : null);
var NATIVE = !!(window.AndroidBridge && typeof window.AndroidBridge.call === "function");

// 杜比 / DTS 输出模式：native 原生多声道直出 | device 重编码适配设备
var dolbyMode = "native";
// 解码结果缓存：trackId -> { url, channels, rate, bytes, duration, codec, layout, note }
var decodedCache = new Map();
// 正在解码中的曲目（界面显示「解码中…」）
var busyIds = {};
var decodingId = null;
function decodedURL(key) { return BOOT.base + "/decoded/" + encodeURIComponent(key); }
// 读取远端（本地服务）文件片段：解码后的 PCM 不在文件注册表里，直接按 Range 取
async function fetchRange(url, offset, length) {
  var res = await fetch(url, { headers: { Range: "bytes=" + offset + "-" + (offset + length - 1) } });
  if (res.status === 206 || res.status === 200) return res.arrayBuffer();
  throw new Error("http " + res.status);
}
// 声道布局名称（与桌面版一致）
var LAYOUT_NAMES = { 1: "单声道", 2: "立体声", 3: "3.0", 4: "4.0", 5: "5.0", 6: "5.1", 7: "6.1", 8: "7.1" };
function layoutName(ch) { return LAYOUT_NAMES[ch] || (ch + " 声道"); }

var bridgeSeq = 0;
var bridgePending = {};
var bridgeProgress = {};   // requestId -> fn(percent)，解码进度用
window.__hbpBridgeResult = function (id, ok, json) {
  var p = bridgePending[id];
  if (!p) return;
  delete bridgePending[id];
  delete bridgeProgress[id];
  clearTimeout(p.timer);
  if (ok) p.resolve(json == null ? null : JSON.parse(json));
  else p.reject(new Error(json || "bridge error"));
};
// 原生解码进度回调（Bridge.progress 调用）
window.__hbdDecodeProgress = function (id, percent) {
  var fn = bridgeProgress[id];
  if (fn) { try { fn(percent); } catch (e) { /* 忽略 */ } }
};
function bridgeCall(method, payload, onProgress) {
  if (!NATIVE) return Promise.reject(new Error("no native bridge"));
  return new Promise(function (resolve, reject) {
    var id = "b" + (++bridgeSeq) + "_" + Date.now();
    // 解码整轨可能较慢（多声道 PCM 体积大），超时放宽到 5 分钟
    var timer = setTimeout(function () {
      if (bridgePending[id]) {
        delete bridgePending[id];
        delete bridgeProgress[id];
        reject(new Error("bridge timeout"));
      }
    }, 300000);
    bridgePending[id] = { resolve: resolve, reject: reject, timer: timer };
    if (typeof onProgress === "function") bridgeProgress[id] = onProgress;
    try {
      window.AndroidBridge.call(method, id, payload == null ? "" : JSON.stringify(payload));
    } catch (e) {
      clearTimeout(timer);
      delete bridgePending[id];
      delete bridgeProgress[id];
      reject(e);
    }
  });
}

function registerHttp(id, name, size) {
  registry.set(id, { id: id, name: name, size: size, source: { kind: "http", url: BOOT.base + "/audio/" + encodeURIComponent(id) } });
}
function registerBlob(id, name, size, blob) {
  registry.set(id, { id: id, name: name, size: size, source: { kind: "blob", blob: blob } });
}

function sourceURL(id) {
  var e = registry.get(id);
  if (!e) return null;
  if (e.source.kind === "http") return e.source.url;
  if (!e.source.url) e.source.url = URL.createObjectURL(e.source.blob);
  return e.source.url;
}
function blobURLRevoke(id) {
  var e = registry.get(id);
  if (e && e.source.kind === "blob" && e.source.url) {
    URL.revokeObjectURL(e.source.url);
    e.source.url = null;
  }
}
async function readBytes(id, offset, length) {
  var e = registry.get(id);
  if (!e) throw new Error("file missing");
  if (e.source.kind === "blob") {
    var end = Math.min(e.source.blob.size, offset + length);
    if (offset >= e.source.blob.size) return new ArrayBuffer(0);
    return e.source.blob.slice(offset, end).arrayBuffer();
  }
  // 读到文件末尾之后（解析器探测「还有没有下一个 box」时一定会发生）→ 返回空，
  // 不能抛错：一次越界读取会让整份标签解析失败（标题/封面全丢）
  if (e.size && offset >= e.size) return new ArrayBuffer(0);
  var end2 = offset + length - 1;
  if (e.size && end2 > e.size - 1) end2 = e.size - 1;
  var res;
  try {
    res = await fetch(e.source.url, { headers: { Range: "bytes=" + offset + "-" + end2 } });
  } catch (err) { throw new Error("network"); }
  if (res.status === 206 || res.status === 200) return res.arrayBuffer();
  if (res.status === 416) return new ArrayBuffer(0);      // 服务端认为越界：同样按空处理
  throw new Error("http " + res.status);
}
function vfileOf(id) {
  var e = registry.get(id);
  if (!e) throw new Error("file missing");
  return {
    size: e.size,
    slice: function (off, len) { return readBytes(id, off, len); }
  };
}
function trackNameOf(id) {
  var e = registry.get(id);
  return e ? e.name : itemNameOf(id);
}
function itemNameOf(id) {
  var it = itemOf(id);
  return it ? (it.name || "") : "";
}
/** 曲目条目：先找歌单里的，再回落到资料库（删掉歌单后仍能拿到名称 / 时长 / 编码） */
function itemOf(id) {
  for (var i = 0; i < lib.length; i++)
    for (var j = 0; j < lib[i].items.length; j++)
      if (lib[i].items[j].id === id) return lib[i].items[j];
  if (typeof libSongs !== "undefined") {
    for (var k = 0; k < libSongs.length; k++) if (libSongs[k].id === id) return libSongs[k];
  }
  return null;
}
/* ---------- 特殊音频编码（容器无关） ----------
   杜比全景声下载会封装成 .mp4（E-AC-3 + 内嵌封面），此时仅看扩展名无法判断，
   需要按原生探测到的编码决定是否走内置解码器。 */
var SPECIAL_CODEC_RE = /^(ac-?3|eac-?3|ec-3|dts|dca|dtshd|dtsma|truehd|mlp|wmapro|wmav2|wmav1|ape|tta)$/;
var codecCache = new Map();          // trackId -> 编码（原生探测 / 下载时写入）
function normCodec(c) {
  var s = String(c || "").toLowerCase().split(/[ ,]/)[0];
  if (s === "ec-3") return "eac3";
  if (s === "ac-3") return "ac3";
  if (s === "dca") return "dts";
  return s;
}
function markCodec(id, codec) {
  var c = normCodec(codec);
  if (id && c) codecCache.set(id, c);
  return c;
}
function codecName(id) {
  var it = itemOf(id);
  if (it && it.codec) return normCodec(it.codec);
  return codecCache.get(id) || "";
}
function isSpecialCodec(codec) {
  return SPECIAL_CODEC_RE.test(normCodec(codec));
}
/** 是否需要内置解码器：扩展名已知是特殊格式，或容器内音频编码是特殊格式 */
function isSpecialTrack(id) {
  var name = trackNameOf(id) || itemNameOf(id) || "";
  var ext = extOf(name);
  if (FFMPEG_EXTS.has(ext)) return true;
  return isSpecialCodec(codecName(id));
}
/** 播放前确保已知编码（仅对可能内嵌特殊音频的容器探测一次，结果会缓存） */
function ensureCodec(id, name) {
  name = name || trackNameOf(id) || itemNameOf(id) || "";
  var ext = extOf(name);
  if (!/^(mp4|m4a|m4b|m4v|mov)$/.test(ext)) return Promise.resolve("");
  if (codecName(id)) return Promise.resolve(codecName(id));
  if (!NATIVE) return Promise.resolve("");
  var reg = registry.get(id);
  return bridgeCall("probeAudio", { id: id, name: name, size: reg ? reg.size : 0 })
    .then(function (r) {
      if (r && r.codec) markCodec(id, r.codec);
      return codecName(id);
    })
    .catch(function () { return ""; });
}
function itemDurOf(id) {
  var it = itemOf(id);
  return it ? it.dur : null;
}
var durSaveTimer = 0;
function setItemDur(id, dur) {
  var it = itemOf(id);
  if (it && (it.dur == null || dur != null)) it.dur = dur;
  // 资料库里的歌没有歌单条目，时长探测完要单独落库（合并成一次写入）
  if (typeof libSongHas === "function" && libSongHas(id) && !durSaveTimer) {
    durSaveTimer = setTimeout(function () { durSaveTimer = 0; saveLib(); }, 1200);
  }
}
function plById(id) {
  for (var i = 0; i < lib.length; i++) if (lib[i].id === id) return lib[i];
  return null;
}
function trackAvailable(id) {
  return registry.has(id) && !goneIds.has(id);
}

/* ---------- 浏览器回退：IndexedDB ---------- */
var idb = null, idbBroken = false;
function idbOpen() {
  return new Promise(function (resolve, reject) {
    if (!window.indexedDB) { reject(new Error("no idb")); return; }
    var req = indexedDB.open("hibiki-player-files", 1);
    req.onupgradeneeded = function () {
      var db = req.result;
      if (!db.objectStoreNames.contains("files"))
        db.createObjectStore("files", { keyPath: "id" });
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}
function idbGetAll() {
  return new Promise(function (resolve, reject) {
    try {
      var tx = idb.transaction("files", "readonly");
      var req = tx.objectStore("files").getAll();
      req.onsuccess = function () { resolve(req.result || []); };
      req.onerror = function () { reject(req.error); };
    } catch (e) { reject(e); }
  });
}
function idbPut(rec) {
  return new Promise(function (resolve, reject) {
    try {
      var tx = idb.transaction("files", "readwrite");
      tx.objectStore("files").put(rec);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    } catch (e) { reject(e); }
  });
}
function idbDelete(id) {
  return new Promise(function (resolve) {
    try {
      var tx = idb.transaction("files", "readwrite");
      tx.objectStore("files").delete(id);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { resolve(); };
    } catch (e) { resolve(); }
  });
}

/* ---------- 导入 ---------- */
function ingestEntries(entries, lrcMap) {
  var added = [], skipped = 0;
  entries.forEach(function (en) {
    if (!registry.has(en.id)) {
      registry.set(en.id, { id: en.id, name: en.name, size: en.size, source: en.source });
    }
  });
  var plObj = plById(curPlId);
  var seen = plObj ? new Set(plObj.items.map(function (it) { return it.id; })) : new Set();
  entries.forEach(function (en) {
    if (seen.has(en.id)) { skipped++; return; }
    seen.add(en.id);
    var it = { id: en.id, name: en.name, dur: null };
    if (plObj) plObj.items.push(it);
    libSongAdd(it);                      // 记进资料库：以后删掉歌单，歌还在
    added.push(it);
  });
  if (lrcMap) {
    Object.keys(lrcMap).forEach(function (base) {
      entries.forEach(function (en) {
        if (en.name.replace(/\.[^.]+$/, "").toLowerCase() === base) {
          lrcLib.set(en.id, lrcMap[base]);
        }
      });
    });
    saveLrc();
  }
  if (plObj) saveLib();
  if (added.length) probeDurations(added);
  return { added: added, skipped: skipped };
}

function naturalSortEntries(entries) {
  entries.sort(function (a, b) { return naturalCompare(a.name, b.name); });
  return entries;
}

/* 浏览器：多文件 / 文件夹 */
function browserImportFiles(fileList) {
  var files = [], lrcReads = [];
  var lrc = {};
  for (var i = 0; i < fileList.length; i++) {
    var f = fileList[i];
    if (/\.lrc$/i.test(f.name)) {
      var base = f.name.replace(/\.lrc$/i, "").toLowerCase();
      if (!(base in lrc)) {
        lrc[base] = "";
        lrcReads.push(new Promise(function (resolve) {
          var fr = new FileReader();
          fr.onload = function (ev) {
            if (typeof ev.target.result === "string") lrc[base] = ev.target.result;
            resolve();
          };
          fr.onerror = function () { resolve(); };
          fr.readAsText(f);
        }));
      }
      continue;
    }
    if (isAudioFile(f)) files.push(f);
  }
  if (!files.length) {
    return Promise.all(lrcReads).then(function () {
      return { added: [], skipped: 0, none: true };
    });
  }
  var entries = files.map(function (f) {
    var id = hashStr(f.name + "|" + f.size + "|" + f.lastModified);
    registerBlob(id, f.name, f.size, f);
    return { id: id, name: f.name, size: f.size, source: { kind: "blob", blob: f } };
  });
  if (idb && !idbBroken) {
    entries.forEach(function (en) {
      idbPut({ id: en.id, name: en.name, size: en.size, blob: en.source.blob }).catch(function () { idbBroken = true; });
    });
  }
  return Promise.all(lrcReads).then(function () {
    return ingestEntries(entries, lrc);
  });
}

/* 安卓：桥导入 */
async function nativeImportFiles() {
  var data = await bridgeCall("pickAudioFiles");
  if (!data || !Array.isArray(data.entries) || !data.entries.length)
    return { added: [], skipped: 0, none: true };
  var entries = data.entries.map(function (en) {
    return { id: en.id, name: en.name, size: en.size, source: { kind: "http" } };
  });
  entries.forEach(function (en) { registerHttp(en.id, en.name, en.size); });
  return ingestEntries(entries, data.lrc || null);
}
async function nativeImportFolder() {
  var data = await bridgeCall("pickAudioFolder");
  if (!data || !Array.isArray(data.entries) || !data.entries.length)
    return { added: [], skipped: 0, none: true };
  var entries = data.entries.map(function (en) {
    return { id: en.id, name: en.name, size: en.size, source: { kind: "http" } };
  });
  naturalSortEntries(entries);
  entries.forEach(function (en) { registerHttp(en.id, en.name, en.size); });
  return ingestEntries(entries, data.lrc || null);
}

/* 统一入口 */
function ensureImportTarget() {
  if (curPlId && plById(curPlId)) return true;
  if (lib.length) { openDetail(lib[0].id); return true; }
  promptNewPlaylist();
  return false;
}
function doImportFiles() {
  if (!ensureImportTarget()) return;
  if (NATIVE) {
    nativeImportFiles().then(afterImport, function (err) { showToast("导入失败：" + (err.message || err)); });
  } else {
    el("pick-files").click();
  }
}
function doImportFolder() {
  if (!ensureImportTarget()) return;
  if (NATIVE) {
    nativeImportFolder().then(afterImport, function (err) { showToast("导入失败：" + (err.message || err)); });
  } else {
    el("pick-dir").click();
  }
}
function afterImport(res) {
  // 首页 ＋ 的流程：导入结果决定新歌单的去留
  var mark = (typeof pendingNewPl !== "undefined") ? pendingNewPl : null;
  if (mark && !mark.done) {
    if (!res || res.none) { showToast("没有找到音频文件"); settleNewPlImport(mark); return; }
    if (!res.added.length) {
      showToast(res.skipped ? "所选音频已在歌单中（跳过 " + res.skipped + " 首）" : "没有导入文件");
      settleNewPlImport(mark);
      return;
    }
    mark.done = true;
    pendingNewPl = null;
    var np = mark.pl;
    openDetail(np.id);
    showToast("已新建歌单「" + np.name + "」，导入 " + res.added.length + " 首" +
      (res.skipped ? "（跳过重复 " + res.skipped + " 首）" : ""));
    renderDetail();
    renderLibrary();
    renderQueue();
    return;
  }
  if (res.none) { showToast("没有找到音频文件"); return; }
  if (!res.added.length && res.skipped) { showToast("所选音频已在歌单中（跳过 " + res.skipped + " 首）"); return; }
  var plObj = plById(curPlId);
  var total = plObj ? plObj.items.length : 0;
  showToast("已追加 " + res.added.length + " 首" + (res.skipped ? "（跳过重复 " + res.skipped + " 首）" : "") + " · 共 " + total + " 首");
  renderDetail();
  renderLibrary();
  renderQueue();
}

/* ================= 时长探测 ================= */
var probeQueue = [], probing = false;
function probeDurations(items) {
  (items || []).forEach(function (it) {
    if (it && it.dur == null && probeQueue.indexOf(it.id) < 0 && trackAvailable(it.id)) probeQueue.push(it.id);
  });
  pumpProbe();
}
var prober = null;
function probeOne(id) {
  return new Promise(function (resolve) {
    var url = sourceURL(id);
    if (!url) { resolve(); return; }
    var done = false, a = new Audio();
    a.preload = "metadata";
    a.muted = true;
    var finish = function (dur) {
      if (done) return;
      done = true;
      try { a.removeAttribute("src"); a.load(); } catch (e) {}
      resolve(dur);
    };
    a.onloadedmetadata = function () {
      var d = a.duration;
      if (!isFinite(d) || d <= 0) d = null;
      finish(d);
    };
    a.onerror = function () { finish(null); };
    setTimeout(function () { finish(null); }, 12000);
    a.src = url;
    try { a.load(); } catch (e) { finish(null); }
  });
}
function pumpProbe() {
  if (probing) return;
  probing = true;
  var gen = probeGen;
  (async function () {
    while (probeQueue.length && gen === probeGen) {
      var id = probeQueue.shift();
      if (!trackAvailable(id)) continue;
      var dur = await probeOne(id);
      if (gen !== probeGen) break;
      if (dur != null) {
        setItemDur(id, dur);
        if (media && curKey === id && isFinite(media.duration)) { /* 以实际播放为准 */ }
        saveLib();
        renderDetail();
        renderLibrary();
        renderQueue();
      }
    }
    probing = false;
    if (probeQueue.length && gen === probeGen) pumpProbe();
  })();
}
</script>

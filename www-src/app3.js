<script>
"use strict";
/* ============================================================
   UI 渲染与交互
   ============================================================ */

var cssAccent = "#37d67a";
function refreshAccent() {
  var v = getComputedStyle(document.body).getPropertyValue("--accent").trim();
  if (v) cssAccent = v;
}

/* ================= 皮肤 ================= */
function renderSwatches() {
  var row = el("swatch-row");
  if (!row.childNodes.length) {
    THEMES.forEach(function (t) {
      var b = document.createElement("button");
      b.className = "swatch";
      b.dataset.key = t.key;
      b.style.setProperty("--sw", t.sw);
      b.innerHTML = '<span class="swatch-name">' + esc(t.name) + "</span>";
      b.addEventListener("click", function () {
        applyTheme(t.key);
        showToast("皮肤：" + t.name);
      });
      row.appendChild(b);
    });
  }
  var cur = document.body.getAttribute("data-theme") || "green";
  row.querySelectorAll(".swatch").forEach(function (b) {
    b.classList.toggle("active", b.dataset.key === cur);
  });
  refreshAccent();
}

/* ================= 歌单封面 ================= */
var plCoverCache = new Map();
function plCoverCSS(p) {
  if (p.coverMode === "custom" && p.coverImageId) return "url(" + imageURL(p.coverImageId) + ")";
  var item = p.coverMode === "last" ? p.items[p.items.length - 1] : p.items[0];
  if (item) {
    var meta = metaCache.get(item.id);
    if (meta && meta.cover) return "url(" + meta.cover + ")";
    return "gradient:" + coverGradient(item.name);
  }
  return "gradient:" + coverGradient(p.name);
}
function applyCoverCSS(el, css) {
  // 内联 background 简写会把 background-size 重置为 auto（只显示图片一角），
  // 所以这里显式声明 cover / center
  el.style.backgroundSize = "cover";
  el.style.backgroundPosition = "center";
  el.style.backgroundRepeat = "no-repeat";
  if (css.indexOf("gradient:") === 0) {
    el.style.backgroundImage = "";
    el.style.background = css.slice(9);
    el.style.backgroundSize = "cover";
    el.style.backgroundPosition = "center";
    el.innerHTML = '<span class="ph">' + svgNote() + "</span>";
  } else {
    el.style.background = "";
    el.style.backgroundImage = css;
    el.style.backgroundSize = "cover";
    el.style.backgroundPosition = "center";
    el.innerHTML = "";
  }
}
/**
 * 歌单封面：
 *   1) 先看首/尾曲目的缓存封面（按歌单设置的第一首 / 最后一首）；
 *   2) 缓存里没有就异步读标签；
 *   3) 首/尾都拿不到封面时，继续往后试其它曲目 —— 只要歌单里任意一首有内嵌封面就能显示，
 *      而不是整张歌单都退回渐变占位（原来只看首/尾两首，命中率很低）。
 */
function plCover(p, node, metaName) {
  var css = plCoverCSS(p);
  applyCoverCSS(node, css);
  if (p.coverMode === "custom" && p.coverImageId) return;   // 自定义封面优先，不做自动候选
  var order = plCoverOrder(p);
  if (!order.length) return;
  var covered = order.filter(function (id) { var m = metaCache.get(id); return m && m.cover; })[0];
  if (covered) { applyCoverCSS(node, "url(" + metaCache.get(covered).cover + ")"); return; }
  // 依次尝试（最多 8 首），命中即停
  var tryOne = function (idx) {
    if (idx >= order.length) return;
    var id = order[idx];
    if (!trackAvailable(id)) { tryOne(idx + 1); return; }
    var key = p.id + "|" + id;
    if (plCoverPending.has(key)) return;      // 已在读取中的跳过（等回调统一刷新）
    plCoverPending.add(key);
    var meta = trackMeta(id);
    readTags(vfileOfSafe(id)).then(function (m) {
      plCoverPending.delete(key);
      if (m && m.cover) {
        meta.cover = m.cover;
        renderLibrary();
        if (curPlId === p.id) renderDetailHero();
      } else {
        tryOne(idx + 1);                       // 这首没有封面 → 试下一首
      }
    }).catch(function () { plCoverPending.delete(key); tryOne(idx + 1); });
  };
  tryOne(0);
}
/** 封面候选顺序：首/尾优先（跟随歌单设置），其后是其它曲目 */
function plCoverOrder(p) {
  var ids = p.items.map(function (it) { return it.id; });
  if (!ids.length) return [];
  var out = [];
  var first = p.coverMode === "last" ? ids[ids.length - 1] : ids[0];
  if (first) out.push(first);
  if (p.coverMode === "last" && ids[0]) out.push(ids[0]);
  if (ids.length > 1 && ids[ids.length - 1] !== first) out.push(ids[ids.length - 1]);
  for (var i = 0; i < ids.length && out.length < 8; i++) {
    if (out.indexOf(ids[i]) < 0) out.push(ids[i]);
  }
  return out.slice(0, 8);
}
var plCoverPending = new Set();
function vfileOfSafe(id) {
  var vf = vfileOf(id);
  vf.name = trackNameOf(id);
  return vf;
}

/* ================= 资料库矩阵 ================= */
function renderLibrary() {
  syncLibSeg();
  var listsTab = libTab === "lists";
  var grid = el("lib-grid");
  grid.innerHTML = "";
  var has = lib.length > 0;
  el("lib-empty").classList.toggle("hidden", !listsTab || has);
  grid.classList.toggle("hidden", !listsTab || !has);
  if (listsTab) el("lib-sub").textContent = has ? lib.length + " 个歌单" : "";
  grid.classList.toggle("anim", Date.now() < cardsAnimUntil);
  grid.classList.toggle("msel", plMselActive);          // 歌单多选：卡片显示勾选圈
  if (listsTab) {
    lib.forEach(function (p, i) {
      var card = buildLibCard(p);
      if (i < 14) card.style.setProperty("--i", String(i));
      grid.appendChild(card);
    });
    if (!plMselActive) grid.appendChild(buildNewCard());   // 多选时不显示「新建歌单」
  }
  validateGroupPage();
  renderBrowse();
  rowMarqueeSync();      // 分类列表（歌曲）重建后同步正在播放行的标题跑马灯
}
function buildLibCard(p) {
  var card = document.createElement("div");
  card.className = "lib-card";
  card.dataset.plId = p.id;
  var cover = document.createElement("div");
  cover.className = "lib-cover";
  var body = document.createElement("div");
  body.className = "lib-card-body";
  var name = document.createElement("div");
  name.className = "lib-card-name";
  name.textContent = p.name;
  var count = document.createElement("div");
  count.className = "lib-card-count";
  count.textContent = p.items.length + " 首";
  body.appendChild(name);
  body.appendChild(count);
  card.appendChild(cover);
  card.appendChild(body);
  if (plMselActive) {
    var chk = document.createElement("span");
    chk.className = "check";
    chk.textContent = "✓";
    card.appendChild(chk);
    card.classList.toggle("sel", plMselSet.has(p.id));
  }
  card.addEventListener("click", function () {
    if (plMselActive) { togglePlSelect(p.id); return; }     // 歌单多选：点击 = 勾选
    openDetail(p.id);
  });
  armLongPress(card, function () {
    if (plMselActive) return;                               // 多选中不长按弹菜单
    openPlaylistMenu(p, false);                             // 主页面：多选管理 = 歌单多选
  });
  plCover(p, cover);
  return card;
}
function buildNewCard() {
  var card = document.createElement("div");
  card.className = "lib-card new";
  var cover = document.createElement("div");
  cover.className = "lib-cover";
  cover.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
  var body = document.createElement("div");
  body.className = "lib-card-body";
  var name = document.createElement("div");
  name.className = "lib-card-name";
  name.textContent = "新建歌单";
  body.appendChild(name);
  card.appendChild(cover);
  card.appendChild(body);
  card.addEventListener("click", function () { promptNewPlaylist(); });
  return card;
}
function nextDefaultPlaylistName() {
  var n = lib.length + 1;
  var names = new Set(lib.map(function (p) { return p.name; }));
  while (names.has("新歌单 " + n)) n++;
  return "新歌单 " + n;
}
function promptNewPlaylist() {
  showDialog("新建歌单", nextDefaultPlaylistName()).then(function (name) {
    if (!name) return;
    name = name.trim();
    if (!name) { showToast("名称不能为空"); return; }
    var p = {
      id: "pl" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
      name: name, coverMode: "first", coverImageId: null, items: []
    };
    lib.push(p);
    curPlId = p.id;
    saveLib();
    renderLibrary();
    openDetail(p.id);
    showToast("已创建歌单「" + name + "」");
  });
}

/* ================= 首页 ＋：直接导入并自动新建歌单 ================= */
var pendingNewPl = null;
function promptAddImport() {
  openMenu("导入", [
    { label: "🎵 导入音频文件", sub: "自动新建歌单", fn: function () { importIntoNewPlaylist("files"); } },
    { label: "📂 导入文件夹", sub: "自动新建歌单", fn: function () { importIntoNewPlaylist("folder"); } }
  ]);
}
function importIntoNewPlaylist(kind) {
  var prevPl = curPlId;
  var p = {
    id: "pl" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
    name: nextDefaultPlaylistName(), coverMode: "first", coverImageId: null, items: []
  };
  lib.push(p);
  curPlId = p.id;
  saveLib();
  renderLibrary();
  renderDetail();
  var mark = { pl: p, prevPl: prevPl, done: false };
  pendingNewPl = mark;
  // 浏览器下取消选择不会触发 change，用一次窗口 focus 兜底收尾
  var onFocus = function () {
    window.removeEventListener("focus", onFocus);
    setTimeout(function () { settleNewPlImport(mark); }, 1500);
  };
  window.addEventListener("focus", onFocus);
  setTimeout(function () { settleNewPlImport(mark); }, 180000);
  if (kind === "folder") doImportFolder();
  else doImportFiles();
}
/** 导入结束（或用户取消）后的收尾：成功则打开新歌单，没导入到东西就撤掉空歌单 */
function settleNewPlImport(mark) {
  if (!mark || mark.done) return;
  mark.done = true;
  if (pendingNewPl === mark) pendingNewPl = null;
  var p = mark.pl;
  var idx = lib.indexOf(p);
  if (p.items.length) {
    openDetail(p.id);
    return;
  }
  if (idx >= 0) lib.splice(idx, 1);
  if (curPlId === p.id) {
    curPlId = (mark.prevPl && plById(mark.prevPl)) ? mark.prevPl : (lib.length ? lib[0].id : null);
  }
  saveLib();
  renderLibrary();
  if (curPlId) renderDetail();
  else showPage("library");
  showToast("没有导入文件，已取消新建歌单");
}

/* ================= 歌单菜单 / 曲目菜单 ================= */
/**
 * 歌单设置菜单
 * @param fromDetail true = 从歌单内页（⋯ / 长按歌单标题）打开 → 「多选管理」是**歌曲**多选
 *                   false = 从主页面长按歌单封面打开   → 「多选管理」是**歌单**多选
 */
function openPlaylistMenu(p, fromDetail) {
  openMenu(p.name, [
    { label: "🎵 导入音频", fn: function () { openDetail(p.id); doImportFiles(); } },
    { label: "📂 导入文件夹", fn: function () { openDetail(p.id); doImportFolder(); } },
    { label: "✏️ 重命名歌单", fn: function () {
        showDialog("重命名歌单", p.name).then(function (name) {
          if (name == null) return;
          name = String(name).trim();
          if (!name) { showToast("名称不能为空"); return; }
          if (name === p.name) return;
          p.name = name;
          saveLib();
          renderLibrary();
          if (curPlId === p.id) renderDetail();
          renderQueue();
          showToast("已重命名为「" + name + "」");
        });
      } },
    { label: fromDetail ? "☑️ 多选管理（歌曲）" : "☑️ 多选管理（歌单）", fn: function () {
        if (fromDetail) {
          // 歌单内页：多选的是这个歌单里的**歌曲**（保持原行为）
          if (!p.items.length) { showToast("歌单是空的"); return; }
          if (curPlId !== p.id) openDetail(p.id); else exitMultiSelect(true);
          enterMultiSelect();
        } else {
          // 主页面：多选的是**歌单**本身，可批量删除
          enterPlMultiSelect(p.id);
        }
      } },
    { label: "🖼 封面设置", fn: function () { openCoverMenu(p); } },
    { label: "🗑 删除歌单", danger: true, fn: function () {
        confirmDialog("删除歌单「" + p.name + "」？",
          "歌曲与音乐文件都会保留：它们仍在「资料库 → 歌曲 / 专辑 / 艺人」里，只是从这个歌单移除", "删除").then(function (ok) {
          if (!ok) return;
          var idx = lib.indexOf(p);
          if (idx >= 0) lib.splice(idx, 1);
          if (curPlId === p.id) {
            curPlId = lib.length ? lib[0].id : null;
            if (lib.length) renderDetail();
            else showPage("library");
          }
          saveLib();
          renderLibrary();
          renderQueue();
          showToast("已删除歌单");
        });
      } }
  ]);
}
function openCoverMenu(p) {
  openMenu("封面设置", [
    { label: "使用第一首歌曲封面", sub: p.coverMode === "first" ? "✓" : "", fn: function () {
        p.coverMode = "first"; p.coverImageId = null; saveLib(); renderLibrary(); renderDetailHero(); showToast("已设为第一首封面");
      } },
    { label: "使用最后一首歌曲封面", sub: p.coverMode === "last" ? "✓" : "", fn: function () {
        p.coverMode = "last"; p.coverImageId = null; saveLib(); renderLibrary(); renderDetailHero(); showToast("已设为最后一首封面");
      } },
    { label: "自定义图片", sub: p.coverMode === "custom" && p.coverImageId ? "✓" : "", fn: function () {
        pickImage().then(function (ref) {
          if (!ref) return;
          p.coverMode = "custom"; p.coverImageId = ref;
          saveLib(); renderLibrary(); renderDetailHero(); showToast("已设置自定义封面");
        });
      } }
  ]);
}
function openTrackMenu(id, ctxPl) {
  var name = trackNameOf(id);
  // ctxPl 未传 = 歌单详情页里的行；传了（可能是空串）= 资料库 / 分类页里的行
  var inDetail = (ctxPl === undefined || ctxPl === null);
  var p = inDetail ? plById(curPlId) : (ctxPl ? plById(ctxPl) : null);
  var inThatPl = !!(p && p.items.some(function (it) { return it.id === id; }));
  var inAnyPl = !!firstPlOf(id);
  var items = [];
  if (inThatPl) items.push({
    label: inDetail ? "🗑 从歌单移除" : "🗑 从「" + p.name + "」移除",
    danger: true,
    fn: function () {
      var target = plById(p.id);
      if (!target) return;
      removeTrackFromPlaylist(target, id);                 // 只从歌单里拿掉，歌曲仍留在资料库
      if (groupState) {
        if (findGroup(groupState.kind, groupState.key)) renderGroup();
        else closeGroup();
      }
    }
  });
  if (inDetail) items.push({ label: "☑️ 多选", fn: function () { enterMultiSelect(id); } });
  // 资料库里始终提供「从资料库移除」：从资料库与所有歌单中移除，但不删除音乐文件
  if (!inDetail) items.push({
    label: "🗑 从资料库移除", danger: true,
    fn: function () {
      removeFromLibrary(id);
      if (groupState) {
        if (findGroup(groupState.kind, groupState.key)) renderGroup();
        else closeGroup();
      }
      showToast("已从资料库移除（音乐文件仍保留在手机上）");
    }
  });
  items.push({ label: "ℹ️ 音频数据", fn: function () { openAudioInfo(id); } });
  openMenu(name, items);
}
/** 从资料库移除：从资料库记录与所有歌单里拿掉这首歌（音乐文件不动） */
function removeFromLibrary(id) {
  libSongRemove(id);
  if (libGone.indexOf(id) < 0) libGone.push(id);    // 记住：重启后不要再从原生登记表加回来
  lib.forEach(function (p) {
    for (var j = p.items.length - 1; j >= 0; j--) if (p.items[j].id === id) p.items.splice(j, 1);
  });
  var pi = pl.indexOf(id);
  if (pi >= 0) {
    if (id === curKey) {
      pl.splice(pi, 1);
      if (!pl.length) stop();
      else { plIndex = Math.min(pi, pl.length - 1); playIndex(plIndex); }
    } else {
      pl.splice(pi, 1);
      if (pi < plIndex) plIndex--;
    }
  }
  saveLib();
  renderLibrary();
  renderDetail();
  renderQueue();
}
function removeTrackFromPlaylist(p, id) {
  var idx = -1;
  for (var i = 0; i < p.items.length; i++) if (p.items[i].id === id) { idx = i; break; }
  if (idx < 0) return;
  p.items.splice(idx, 1);
  if (curPlId === p.id && pl.length) {
    var pi = pl.indexOf(id);
    if (pi >= 0) {
      if (id === curKey) {
        pl.splice(pi, 1);
        if (!pl.length) { stop(); }
        else { plIndex = Math.min(pi, pl.length - 1); playIndex(plIndex); }
      } else {
        pl.splice(pi, 1);
        if (pi < plIndex) plIndex--;
      }
    }
  }
  saveLib();
  renderDetail();
  renderLibrary();
  renderQueue();
  showToast("已移除 1 首");
}
function openAudioInfo(id) {
  var name = trackNameOf(id);
  var ext = extOf(name).toUpperCase() || "—";
  var reg = registry.get(id);
  var sizeText = reg && reg.size ? (reg.size / 1024 / 1024).toFixed(2) + " MB" : "—";
  var special = isSpecialTrack(id);
  var dur = itemDurOf(id);
  var bitrate = (reg && reg.size && dur) ? Math.round(reg.size * 8 / dur / 1000) + " kbps" : "—";
  var rateText = "—";
  var dec = decodedCache.get(id + "|" + dolbyMode) || decodedCache.get(id + "|native") || decodedCache.get(id + "|device");
  var decText = dec
    ? ((dec.codec || ext).toUpperCase() + " → PCM · " + layoutName(dec.channels) + " " + dec.rate + " Hz" +
       (dec.note ? "（" + dec.note + "）" : ""))
    : (special ? "未解码（播放时自动解码）" : "—");
  var rows = [
    ["文件名", name],
    ["格式", ext],
    ["文件大小", sizeText],
    ["采样率", '<span id="ai-rate">—</span>'],
    ["码率", bitrate],
    ["特殊格式", special ? "是（杜比/DTS 等）" : "否"],
    ["解码输出", decText]
  ];
  var html = '<div class="ai-wrap">' + rows.map(function (r) {
    return '<div class="ai-row"><span>' + esc(r[0]) + "</span><b>" + (r[0] === "采样率" ? r[1] : esc(r[1])) + "</b></div>";
  }).join("") + "</div>";
  openMenu("音频数据", [], html);
  if (trackAvailable(id)) {
    probeRate(id).then(function (r) {
      var n = el("ai-rate");
      if (n) n.textContent = r ? r + " Hz" : "无法识别";
    });
  }
}

/* ================= 歌曲分类（歌曲 / 专辑 / 艺人） ================= */
var LIB_TABS = ["lists", "songs", "albums", "artists"];
var libTab = "lists";           // 资料库当前分类：歌单 / 歌曲 / 专辑 / 艺人
var libCollator = null;
function cmpText(a, b) {
  if (!libCollator) {
    try { libCollator = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" }); }
    catch (e) { libCollator = null; }
  }
  if (libCollator) return libCollator.compare(String(a), String(b));
  a = String(a); b = String(b);
  return a < b ? -1 : (a > b ? 1 : 0);
}
function setLibTab(tab) {
  if (LIB_TABS.indexOf(tab) < 0) tab = "lists";
  libTab = tab;
  cardsAnimUntil = Date.now() + 700;
  savePrefs();
  var pg = el("page-library");
  if (pg) pg.scrollTop = 0;
  renderLibrary();
}
function syncLibSeg() {
  var seg = el("lib-seg");
  if (!seg) return;
  seg.querySelectorAll("button").forEach(function (b) {
    b.classList.toggle("on", b.dataset.tab === libTab);
  });
}
/* ================= 资料库歌曲（与歌单解耦） =================
   导入过的歌会一直留在资料库里：删掉歌单只是把歌从那个歌单里拿掉，
   歌曲本身仍然出现在「资料库 → 歌曲 / 专辑 / 艺人」，也照样能播放。 */
var libSongs = [];                  // [{ id, name, dur, codec }]
var libGone = [];                   // 被「从资料库移除」过的 id：重启后不再自动加回
function libSongHas(id) {
  for (var i = 0; i < libSongs.length; i++) if (libSongs[i].id === id) return true;
  return false;
}
function libSongAdd(it) {
  if (!it || !it.id) return false;
  if (libGone.indexOf(it.id) >= 0) return false;    // 用户主动从资料库移除过，别再加回来
  if (libSongHas(it.id)) return false;
  var o = { id: it.id, name: it.name || "", dur: (typeof it.dur === "number" ? it.dur : null) };
  if (it.codec) o.codec = it.codec;
  libSongs.push(o);
  return true;
}
function libSongRemove(id) {
  var n = libSongs.length;
  libSongs = libSongs.filter(function (s) { return s.id !== id; });
  if (libSongs.length !== n) saveLib();
  return libSongs.length !== n;
}
/** 首次出现该曲目的歌单（不在任何歌单里则返回 ""） */
function firstPlOf(id) {
  for (var i = 0; i < lib.length; i++) {
    for (var j = 0; j < lib[i].items.length; j++) if (lib[i].items[j].id === id) return lib[i].id;
  }
  return "";
}
/* 全部歌曲 = 各歌单里的歌（按歌单顺序去重）+ 资料库里剩下的歌（顺序稳定） */
function songUniverse() {
  var seen = new Set(), out = [];
  lib.forEach(function (p) {
    p.items.forEach(function (it) {
      if (!it || !it.id || seen.has(it.id)) return;
      seen.add(it.id);
      out.push({ id: it.id, plId: p.id });
    });
  });
  libSongs.forEach(function (s) {
    if (!s || !s.id || seen.has(s.id)) return;
    seen.add(s.id);
    out.push({ id: s.id, plId: "" });                // 不在任何歌单里（文件缺失时行内会有 ⚠️ 标记）
  });
  return out;
}
function metaTitleOf(id) {
  var m = metaCache.get(id);
  if (m && m.title) return m.title;
  return String(trackNameOf(id) || itemNameOf(id) || "").replace(/\.[^.]+$/, "");
}
function metaArtistOf(id) { var m = metaCache.get(id); return (m && m.artist) || ""; }
function metaAlbumOf(id) { var m = metaCache.get(id); return (m && m.album) || ""; }
function sortSongs(list) {
  return list.slice().sort(function (a, b) {
    return cmpText(metaTitleOf(a.id), metaTitleOf(b.id)) || cmpText(a.id, b.id);
  });
}

/* ================= 全部歌曲的排序方式 / 正倒序 ================= */
var SONG_SORTS = ["default", "added", "letter"];
var songSort = "default";      // default = 同专辑聚在一起；added = 加入顺序；letter = 按首字母
var sortDir = "asc";           // asc = 正序；desc = 倒序
function songSortText(mode) {
  if (mode === "added") return "按加入顺序";
  if (mode === "letter") return "按首字母";
  return "默认排序";
}
/** 首字母（A–Z，# 收尾）：拉丁字母直取，汉字用拼音排序器与锚点比较（zh 排序按拼音） */
var ALPHA_KEYS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ#".split("");
var ALPHA_ANCHORS = [
  ["A", "阿"], ["B", "八"], ["C", "擦"], ["D", "搭"], ["E", "蛾"], ["F", "发"], ["G", "噶"], ["H", "哈"],
  ["J", "击"], ["K", "喀"], ["L", "垃"], ["M", "妈"], ["N", "拿"], ["O", "哦"], ["P", "啪"], ["Q", "期"],
  ["R", "然"], ["S", "撒"], ["T", "塔"], ["W", "挖"], ["X", "昔"], ["Y", "压"], ["Z", "匝"]
];
var pinyinCollator = null;
function firstLetterOf(name) {
  var s = String(name == null ? "" : name).trim();
  if (!s) return "#";
  // 去掉重音符号后再判断拉丁字母（Édith → E）
  var latin = s[0].normalize ? s[0].normalize("NFD").replace(/[\u0300-\u036f]/g, "") : s[0];
  var up = latin.toUpperCase();
  if (up >= "A" && up <= "Z") return up;
  if (s[0] >= "0" && s[0] <= "9") return "#";
  if (!pinyinCollator) {
    try { pinyinCollator = new Intl.Collator("zh-Hans-CN", { sensitivity: "base" }); } catch (e) { pinyinCollator = null; }
  }
  if (!pinyinCollator) return "#";
  var got = "#";
  for (var i = 0; i < ALPHA_ANCHORS.length; i++) {
    if (pinyinCollator.compare(s[0], ALPHA_ANCHORS[i][1]) >= 0) got = ALPHA_ANCHORS[i][0];
    else break;
  }
  return got;
}
function letterRank(L) { var i = ALPHA_KEYS.indexOf(L); return i < 0 ? ALPHA_KEYS.length : i; }
function songsViewMeta() {
  // 每首歌曲的字母（按标题），供排序与分组共用
  var uni = songUniverse();
  uni.forEach(function (s) { s.title = metaTitleOf(s.id); s.letter = firstLetterOf(s.title); });
  return uni;
}
/** 按当前排序方式与方向排列「全部歌曲」 */
function sortedSongView(uni) {
  var arr = uni.slice();
  var desc = sortDir === "desc";
  if (songSort === "added") {
    if (desc) arr.reverse();                       // songUniverse 本身就是加入顺序
    return arr;
  }
  if (songSort === "letter") {
    arr.sort(function (a, b) {
      var d = letterRank(a.letter) - letterRank(b.letter);
      if (d) return d;
      return cmpText(a.title, b.title) || cmpText(a.id, b.id);
    });
  } else {
    // 默认排序：同一张专辑的歌聚在一起（无专辑标签的排最后，组内按歌名）
    arr.sort(function (a, b) {
      var aa = metaAlbumOf(a.id), ab = metaAlbumOf(b.id);
      if ((!aa) !== (!ab)) return aa ? -1 : 1;
      return cmpText(aa, ab) || cmpText(a.title, b.title) || cmpText(a.id, b.id);
    });
  }
  if (desc) arr.reverse();
  return arr;
}
/* 右侧字母索引条：点击跳到该首字母的第一项 */
function buildAlphaIndex(host, container, letters) {
  if (!host) return;
  var have = {};
  letters.forEach(function (L) { have[L] = true; });
  host.innerHTML = "";
  ALPHA_KEYS.forEach(function (L) {
    var b = document.createElement("button");
    b.className = "alpha-key" + (have[L] ? "" : " empty");
    b.textContent = L;
    b.setAttribute("data-alpha", L);
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      var target = container ? container.querySelector('[data-letter="' + L + '"]') : null;
      if (!target) return;
      var scroller = el("page-library");
      target.scrollIntoView({ block: "start" });
      if (scroller) scroller.scrollTop -= 6;
      b.classList.add("hit");
      setTimeout(function () { b.classList.remove("hit"); }, 300);
    });
    host.appendChild(b);
  });
  host.classList.toggle("hidden", !letters.length);
  document.body.classList.toggle("alpha-on", !!letters.length);
}
function syncSortUI() {
  var bar = el("sort-bar");
  if (bar) bar.classList.toggle("hidden", libTab !== "songs");
  var modeSeg = el("sort-mode");
  if (modeSeg) modeSeg.querySelectorAll("button[data-sort]").forEach(function (b) {
    b.classList.toggle("on", b.dataset.sort === songSort);
  });
  var dirSeg = el("sort-dir");
  if (dirSeg) dirSeg.querySelectorAll("button[data-dir]").forEach(function (b) {
    b.classList.toggle("on", b.dataset.dir === sortDir);
  });
}
function setSongSort(mode) {
  if (SONG_SORTS.indexOf(mode) < 0) mode = "default";
  songSort = mode;
  cardsAnimUntil = Date.now() + 400;
  savePrefs();
  renderBrowse();
  showToast("排序：" + songSortText(mode) + " · " + (sortDir === "desc" ? "倒序" : "正序"));
}
function setSortDir(dir) {
  sortDir = dir === "desc" ? "desc" : "asc";
  savePrefs();
  renderBrowse();
  showToast("排序方向：" + (sortDir === "desc" ? "倒序" : "正序"));
}
/* 元数据分批解析（避免一次性读取过多文件） */
var metaQueue = [], metaRunning = new Set(), META_CONC = 4, browseTimer = 0;
function pumpMeta() {
  while (metaRunning.size < META_CONC && metaQueue.length) {
    var id = metaQueue.shift();
    metaRunning.add(id);
    (function (tid) {
      ensureMeta(tid).then(function () { metaRunning.delete(tid); pumpMeta(); },
                           function () { metaRunning.delete(tid); pumpMeta(); });
    })(id);
  }
}
function prefetchMeta(ids) {
  (ids || []).forEach(function (id) {
    var m = metaCache.get(id);
    if (m && m.loaded) return;
    if (metaRunning.has(id) || metaQueue.indexOf(id) >= 0) return;
    metaQueue.push(id);
  });
  pumpMeta();
}
/* 元数据陆续到达时合并刷新（避免逐首重排） */
function scheduleBrowseRefresh() {
  if (libTab === "lists" && !groupState) return;
  if (browseTimer) return;
  browseTimer = setTimeout(function () {
    browseTimer = 0;
    if (libTab !== "lists") renderBrowse();
    if (groupState) renderGroup();
  }, 150);
}
/* 按专辑 / 按艺人分组 */
function groupOf(kind) {
  var isAlbum = kind === "album";
  var map = new Map();
  songUniverse().forEach(function (s) {
    var raw = isAlbum ? metaAlbumOf(s.id) : metaArtistOf(s.id);
    var key = raw ? "k:" + raw : "?";
    var g = map.get(key);
    if (!g) {
      g = {
        key: key, name: raw || (isAlbum ? "未知专辑" : "未知艺术家"), known: !!raw,
        kind: kind, songs: [], plId: s.plId, artist: ""
      };
      map.set(key, g);
    }
    g.songs.push({ id: s.id, plId: s.plId });
    if (!g.artist) g.artist = metaArtistOf(s.id);
  });
  var out = Array.from(map.values());
  out.forEach(function (g) { g.songs = sortSongs(g.songs); });
  out.sort(function (a, b) {
    if (a.known !== b.known) return a.known ? -1 : 1;   // 未知归类放最后
    if (kind === "artist") {
      // 艺人默认按首字母（A→Z，# 最后）：与右侧字母索引条的分组顺序一致
      var d = letterRank(firstLetterOf(a.name)) - letterRank(firstLetterOf(b.name));
      if (d) return d;
    }
    return cmpText(a.name, b.name);
  });
  return out;
}
function findGroup(kind, key) {
  var list = groupOf(kind);
  for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
  return null;
}
function groupCover(g) {
  for (var i = 0; i < g.songs.length; i++) {
    var m = metaCache.get(g.songs[i].id);
    if (m && m.cover) return m.cover;
  }
  return null;
}
function groupDur(g) {
  var t = 0, any = false;
  g.songs.forEach(function (s) { var d = itemDurOf(s.id); if (d != null) { t += d; any = true; } });
  return any ? t : null;
}
function fillCover(node, name, cover, round) {
  node.classList.toggle("round", !!round);
  if (cover) { applyCoverCSS(node, 'url("' + String(cover).replace(/"/g, '\\"') + '")'); return; }
  applyCoverCSS(node, "gradient:" + coverGradient(name));
}
function initialsOf(name) {
  var s = String(name || "").trim();
  var ch = s ? s.charAt(0) : "";
  if (/[a-z]/.test(ch)) return ch.toUpperCase();
  if (/[\u4e00-\u9fa5A-Z0-9]/.test(ch)) return ch;
  return "♪";
}
function fillAvatar(node, name, cover) {
  node.classList.add("round");
  if (cover) {
    node.style.background = "";
    node.style.backgroundImage = 'url("' + String(cover).replace(/"/g, '\\"') + '")';
    node.innerHTML = "";
    return;
  }
  node.style.backgroundImage = "";
  node.style.background = coverGradient(name);
  node.innerHTML = '<span class="ini">' + esc(initialsOf(name)) + "</span>";
}
function buildGroupCard(g, i) {
  var card = document.createElement("div");
  card.className = "lib-card";
  card.dataset.groupKey = g.key;
  if (i < 14) card.style.setProperty("--i", String(i));
  var cover = document.createElement("div");
  cover.className = "lib-cover";
  var body = document.createElement("div");
  body.className = "lib-card-body";
  var nm = document.createElement("div");
  nm.className = "lib-card-name";
  nm.textContent = g.name;
  var ct = document.createElement("div");
  ct.className = "lib-card-count";
  ct.textContent = g.songs.length + " 首" + (g.artist && g.artist !== g.name ? " · " + g.artist : "");
  body.appendChild(nm);
  body.appendChild(ct);
  card.appendChild(cover);
  card.appendChild(body);
  fillCover(cover, g.name, groupCover(g));
  card.addEventListener("click", function () { openGroup("album", g.key); });
  return card;
}
function buildArtistRow(g, i) {
  var row = document.createElement("div");
  row.className = "artist-row";
  row.dataset.groupKey = g.key;
  if (i < 14) row.style.setProperty("--i", String(i));
  var av = document.createElement("div");
  av.className = "artist-avatar";
  var info = document.createElement("div");
  info.className = "artist-info";
  var nm = document.createElement("div");
  nm.className = "artist-name";
  nm.textContent = g.name;
  var albums = new Set();
  g.songs.forEach(function (s) { var a = metaAlbumOf(s.id); if (a) albums.add(a); });
  var sub = document.createElement("div");
  sub.className = "artist-sub";
  sub.textContent = g.songs.length + " 首歌" +
    (albums.size > 1 ? " · " + albums.size + " 张专辑"
      : (albums.size === 1 ? " · " + Array.from(albums)[0] : ""));
  info.appendChild(nm);
  info.appendChild(sub);
  var chev = document.createElement("span");
  chev.className = "chev";
  chev.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M9 5l7 7-7 7"/></svg>';
  row.appendChild(av);
  row.appendChild(info);
  row.appendChild(chev);
  fillAvatar(av, g.name, groupCover(g));
  row.addEventListener("click", function () { openGroup("artist", g.key); });
  return row;
}
function renderBrowse() {
  syncLibSeg();
  var songsBox = el("lib-songs"), albumBox = el("lib-albums");
  var artistBox = el("lib-artists"), emptyBox = el("lib-browse-empty");
  if (!songsBox || !albumBox || !artistBox || !emptyBox) return;
  songsBox.classList.toggle("hidden", libTab !== "songs");
  albumBox.classList.toggle("hidden", libTab !== "albums");
  artistBox.classList.toggle("hidden", libTab !== "artists");
  emptyBox.classList.add("hidden");
  if (libTab === "lists") return;
  var uni = songUniverse();
  prefetchMeta(uni.map(function (s) { return s.id; }));
  if (!uni.length) {
    el("lib-sub").textContent = "";
    songsBox.innerHTML = "";
    albumBox.innerHTML = "";
    artistBox.innerHTML = "";
    emptyBox.classList.remove("hidden");
    emptyBox.innerHTML = "<b>还没有歌曲</b><br>先在歌单里导入音频，这里会自动按专辑、艺人归类";
    return;
  }
  var anim = Date.now() < cardsAnimUntil;
  syncSortUI();
  if (libTab === "songs") {
    var view = sortedSongView(songsViewMeta());
    el("lib-sub").textContent = uni.length + " 首歌曲 · " + songSortText(songSort) + (sortDir === "desc" ? " 倒序" : "");
    songsBox.innerHTML = "";
    songsBox.classList.toggle("anim", anim);
    var lastLetter = null;
    view.forEach(function (s, i) {
      if (songSort === "letter" && s.letter !== lastLetter) {   // 按首字母：插入分组标题
        lastLetter = s.letter;
        songsBox.appendChild(buildLetterHead(s.letter, "li"));
      }
      var li = buildSongRow(s.id, { menu: true, ctxPl: s.plId, lib: true });   // lib：支持长按多选
      if (i < 14) li.style.setProperty("--i", String(i));
      songsBox.appendChild(li);
    });
    buildAlphaIndex(el("alpha-index"), songsBox, songSort === "letter" ? view.map(function (s) { return s.letter; }) : []);
    if (libMselActive) {                                  // 重绘后恢复多选态的勾选圈与计数
      songsBox.classList.add("msel");
      updateMselUI();
    }
    return;
  }
  if (libTab === "albums") {
    var albums = groupOf("album");
    el("lib-sub").textContent = albums.length + " 张专辑";
    albumBox.innerHTML = "";
    albumBox.classList.toggle("anim", anim);
    albums.forEach(function (g, i) { albumBox.appendChild(buildGroupCard(g, i)); });
    buildAlphaIndex(el("alpha-index"), null, []);
    return;
  }
  // 艺人：默认按首字母（拼音）排列，并给出字母索引
  var artists = groupOf("artist");
  el("lib-sub").textContent = artists.length + " 位艺人 · 按首字母";
  artistBox.innerHTML = "";
  artistBox.classList.toggle("anim", anim);
  var lastA = null, letters = [];
  artists.forEach(function (g, i) {
    var L = g.known ? firstLetterOf(g.name) : "#";   // 未知艺人不按「未知」的首字母分组
    if (L !== lastA) { lastA = L; letters.push(L); artistBox.appendChild(buildLetterHead(L, "div")); }
    artistBox.appendChild(buildArtistRow(g, i));
  });
  buildAlphaIndex(el("alpha-index"), artistBox, letters);
}
function buildLetterHead(letter, tag) {
  var node = document.createElement(tag || "li");
  node.className = "grp-head";
  node.setAttribute("data-letter", letter);
  node.textContent = letter;
  return node;
}
/* 分类内容消失（删歌单 / 移除最后一首）时，自动关闭打开着的分类详情页 */
function validateGroupPage() {
  if (!groupState) return;
  if (findGroup(groupState.kind, groupState.key)) return;
  groupState = null;
  el("page-group").classList.remove("active");
  showPage("library");
  uiPopIfTop("group");
}

/* ================= 专辑 / 艺人详情页 ================= */
var groupState = null;          // { kind: "album" | "artist", key }
function openGroup(kind, key) {
  if (!findGroup(kind, key)) return;
  groupState = { kind: kind, key: key };
  rowsAnimUntil = Date.now() + 700;
  el("page-group").classList.add("active", "slide-right");
  document.querySelectorAll(".page").forEach(function (p) {
    if (p.id !== "page-group") p.classList.remove("active");
  });
  renderGroup();
  uiPush("group");
}
function closeGroup() {
  if (!groupState) return;
  groupState = null;
  el("page-group").classList.remove("active");
  showPage("library");
  uiPopIfTop("group");
}
function renderGroup() {
  if (!groupState) return;
  var g = findGroup(groupState.kind, groupState.key);
  if (!g || !g.songs.length) {   // 内容已不存在（歌单被删/歌曲被移除）
    groupState = null;
    el("page-group").classList.remove("active");
    showPage("library");
    uiPopIfTop("group");
    return;
  }
  el("group-title").textContent = g.name;
  var total = groupDur(g);
  el("group-meta").textContent = g.songs.length + " 首" +
    (total != null ? " · 共 " + fmtTime(total) : "") +
    (groupState.kind === "album" && g.artist ? " · " + g.artist : "");
  var list = el("group-list");
  list.innerHTML = "";
  list.classList.toggle("anim", Date.now() < rowsAnimUntil);
  g.songs.forEach(function (s, i) {
    var li = buildSongRow(s.id, { menu: true, ctxPl: s.plId });
    if (i < 14) li.style.setProperty("--i", String(i));
    list.appendChild(li);
  });
  var node = el("group-hero-cover");
  if (groupState.kind === "album") fillCover(node, g.name, groupCover(g), false);
  else fillAvatar(node, g.name, groupCover(g));
}
function playGroupAll() {
  if (!groupState) return;
  var g = findGroup(groupState.kind, groupState.key);
  if (!g || !g.songs.length) return;
  var first = null;
  for (var i = 0; i < g.songs.length; i++) {
    if (trackAvailable(g.songs[i].id)) { first = g.songs[i]; break; }
  }
  if (!first) { showToast("⚠️ 文件不可读（可能已被移动或删除）"); return; }
  if (!plById(first.plId)) return;
  // 以该分类的顺序作为播放队列
  curPlId = first.plId;
  pl = g.songs.map(function (s) { return s.id; });
  plIndex = g.songs.indexOf(first);
  saveLib();
  playIndex(plIndex);
}

/* ================= 详情页 ================= */
function renderDetail() {
  var p = plById(curPlId);
  if (!p) return;
  el("detail-title").textContent = p.name;
  var total = 0, known = true;
  p.items.forEach(function (it) {
    if (it.dur != null) total += it.dur; else known = false;
  });
  el("detail-meta").textContent = p.items.length + " 首" +
    (known && p.items.length ? " · 共 " + fmtTime(total) : "");
  el("detail-empty").classList.toggle("hidden", p.items.length > 0);
  el("detail-list").classList.toggle("hidden", p.items.length === 0);
  var list = el("detail-list");
  list.innerHTML = "";
  // 打开歌单时行逐条淡入（仅在刚进入的短暂窗口内，避免刷新时反复播放）
  list.classList.toggle("anim", Date.now() < rowsAnimUntil);
  p.items.forEach(function (it, i) {
    // 歌单内不提供行内 ⋯（长按可拖动排序；多选见歌单菜单）；支持左滑删除
    var row = buildSongRow(it.id, { menu: false, swipe: true });
    if (i < 14) row.style.setProperty("--i", String(i));
    list.appendChild(row);
  });
  renderDetailHero();
  if (mselActive) {
    el("detail-list").classList.add("msel");
    el("msel-bar").classList.add("on");
    updateMselUI();
  }
  rowMarqueeSync();      // 行重建后，正在播放那一行的标题跑马灯重新接管
}
function renderDetailHero() {
  var p = plById(curPlId);
  if (!p) return;
  plCover(p, el("detail-hero-cover"));
}
function coverThumb(id, node) {
  var meta = trackMeta(id);
  node.style.backgroundSize = "cover";
  node.style.backgroundPosition = "center";
  if (meta.cover) {
    node.style.background = "";
    node.style.backgroundImage = "url(" + meta.cover + ")";
    node.style.backgroundSize = "cover";
    node.style.backgroundPosition = "center";
    node.innerHTML = "";
  } else {
    node.style.background = coverGradient(trackNameOf(id));
    node.style.backgroundImage = "";
    node.style.backgroundSize = "cover";
    node.style.backgroundPosition = "center";
    node.innerHTML = '<span class="ph">' + svgNote() + "</span>";
  }
}
function buildSongRow(id, opts) {
  opts = opts || {};
  var li = document.createElement("li");
  li.className = "song-row";
  li.dataset.id = id;
  if (!trackAvailable(id)) li.classList.add("missing");
  if (id === curKey) li.classList.add("current");
  var name = trackNameOf(id) || itemNameOf(id);
  var meta = metaCache.get(id);
  var title = (meta && meta.title) || name.replace(/\.[^.]+$/, "");
  var sub = meta ? [meta.artist, meta.album].filter(Boolean).join(" · ") : "";
  var ext = extOf(name);
  // 格式标签：扩展名是特殊格式，或容器内的音频编码是特殊格式（如 .mp4 里的 E-AC-3）
  var fmtName = FFMPEG_EXTS.has(ext) ? ext : (isSpecialCodec(codecName(id)) ? codecName(id) : "");
  var fmtTag = fmtName && !/^(mp4|m4a|m4v|webm|mp3|flac|wav|ogg|opus)$/.test(fmtName)
    ? '<span class="fmt-tag">' + esc(fmtName.toUpperCase()) + "</span>" : "";
  var dur = itemDurOf(id);
  var busy = !!busyIds[id];
  var durText = busy ? "解码…" : (dur != null ? fmtTime(dur) : "");
  if (busy && !sub) sub = "正在解码为 PCM…";
  // 行内容包一层：左滑时整块左移，露出后面的红色「删除」
  li.innerHTML =
    (opts.swipe ? '<button class="row-del" aria-label="从歌单移除">删除</button>' : "") +
    '<span class="row-inner">' +
    '<span class="check">✓</span>' +
    '<span class="cover"></span>' +
    '<span class="song-info"><span class="song-name"><span class="nm">' + esc(title) + "</span>" + fmtTag + "</span>" +
    '<span class="song-sub">' + esc(sub) + "</span></span>" +
    '<span class="song-dur">' + esc(durText) + "</span>" +
    (opts.menu ? '<button class="song-menu-btn" aria-label="更多"><svg viewBox="0 0 24 24" fill="currentColor" width="17" height="17"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg></button>' : "") +
    "</span>";
  coverThumb(id, li.querySelector(".cover"));
  if (opts.swipe) armRowSwipe(li, id, opts.ctxPl);
  if (opts.lib) armLongPress(li, function () {           // 资料库歌曲：长按进入多选
    if (libMselActive) return;
    libLpGuardUntil = Date.now() + 600;                  // 抑制长按松手时补发的 click
    enterLibMultiSelect(id);
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch (err) {} }
  });
  li.addEventListener("click", function (e) {
    if (e.target.closest(".song-menu-btn") || e.target.closest(".check")) return;
    if (opts.lib && libMselActive) { toggleLibSelect(id); return; }   // 资料库多选：点击 = 勾选
    if (opts.lib && Date.now() < libLpGuardUntil) return;            // 刚长按完，别当成点击
    if (swipeJustDragged()) { plClickSuppressed = false; return; }   // 刚滑完 / 刚收起：这次点击不播放
    if (rowSwipeOpen) { closeRowSwipe(); return; }     // 已左滑打开时，先收起
    if (plClickSuppressed) { plClickSuppressed = false; return; }
    if (mselActive) { toggleSelect(id); return; }
    if (!trackAvailable(id)) {
      showToast("⚠️ 文件不可读（可能已被移动或删除）");
      return;
    }
    var p = plById(opts.ctxPl || curPlId);
    if (!p) return;
    if (id === curKey && media) {
      if (id === plLastStartKey && Date.now() - plLastStartAt < 600) return;
      togglePlayPause();
      return;
    }
    playFromItems(p.id, id);
    plLastStartKey = id;
    plLastStartAt = Date.now();
    if (opts.inQueue) { /* 队列里播放后保持打开 */ }
  });
  var menuBtn = li.querySelector(".song-menu-btn");
  if (menuBtn) menuBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    openTrackMenu(id, opts.ctxPl);
  });
  return li;
}
/* ================= 资料库（全部歌曲）多选删除 =================
   长按歌曲行进入多选：勾选若干首后「删除选中」= 从资料库与所有歌单里移除，
   音乐文件本身不会被删除（与「从资料库移除」同一套语义）。 */
var libMselActive = false, libMselSet = new Set();
var libLpGuardUntil = 0;
var LIB_MSEL_BOX = "lib-songs";
function enterLibMultiSelect(preselectId) {
  showPage("library");
  plMselActive = false;
  plMselSet.clear();
  libMselActive = true;
  libMselSet.clear();
  if (preselectId) libMselSet.add(preselectId);
  setLibTab("songs");                                   // 切到「歌曲」并重绘（行上会出现勾选圈）
  var box = el(LIB_MSEL_BOX);
  if (box) box.classList.add("msel");
  el("msel-bar").classList.add("on");
  updateMselUI();
  uiPush("msel");
  showToast("点击勾选歌曲，「删除选中」可一次移除多首");
}
function toggleLibSelect(id) {
  if (libMselSet.has(id)) libMselSet.delete(id);
  else libMselSet.add(id);
  var li = document.querySelector('#' + LIB_MSEL_BOX + ' li[data-id="' + CSS.escape(id) + '"]');
  if (li) li.classList.toggle("sel", libMselSet.has(id));
  updateMselUI();
}
/** 批量从资料库移除（音乐文件保留在手机上） */
function deleteSelectedLibrarySongs() {
  if (!libMselSet.size) return;
  var ids = Array.from(libMselSet);
  var n = ids.length;
  confirmDialog("从资料库移除选中的 " + n + " 首？",
    "只会从资料库与所有歌单里移除记录，音乐文件仍保留在手机上", "移除").then(function (ok) {
    if (!ok) return;
    ids.forEach(function (id) { removeFromLibrary(id); });
    libMselActive = false;
    libMselSet.clear();
    var box = el(LIB_MSEL_BOX);
    if (box) box.classList.remove("msel");
    el("msel-bar").classList.remove("on");
    uiPopIfTop("msel");
    renderLibrary();
    renderDetail();
    renderQueue();
    showToast("已从资料库移除 " + n + " 首（音乐文件仍在手机上）");
  });
}
function exitLibMultiSelect(silent) {
  var was = libMselActive;
  libMselActive = false;
  libMselSet.clear();
  var box = el(LIB_MSEL_BOX);
  if (box) box.classList.remove("msel");
  if (was && !silent) renderBrowse();
}

/* ================= 正在播放行的标题跑马灯 =================
   歌单 / 队列 / 资料库歌曲列表里，只有「正在播放」的那一行会滚动：
   标题长度超出单次可显示宽度时，每几秒滚动一轮（一轮结束后停几秒再滚动）。
   其它行保持静止（不占用 rAF，也不会有任何位移）。 */
var rowMarq = null, rowMarqBox = null;
var ROW_MARQ_SEL = "#detail-list li.current .song-name .nm, #queue-list li.current .song-name .nm, "
  + "#lib-songs li.current .song-name .nm, #group-list li.current .song-name .nm";
function rowMarqueeSync() {
  var box = null;
  if (curKey) {
    try { box = document.querySelector(ROW_MARQ_SEL); } catch (e) { box = null; }
  }
  if (box && !box.clientWidth) box = null;          // 页面不可见（display:none）时先不动
  if (box !== rowMarqBox) {
    if (rowMarq) rowMarq.stop();
    if (rowMarqBox) {                               // 上一行恢复成静止文本
      rowMarqBox.textContent = rowMarqBox.textContent || "";
      rowMarqBox.style.transform = "";
    }
    rowMarqBox = box;
    if (rowMarq) rowMarq._text = null;              // 换行后强制重新接管
  }
  if (!box) return;
  var title = box.textContent || "";
  if (!rowMarq) {
    rowMarq = new Marq(box, { hold1: 1200, hold2: 3000, speed: 0.075 });   // 首次 1.2s 后滚动，两轮之间停 3s
    marqueeList.push(rowMarq);
  } else {
    rowMarq.c = box;
  }
  rowMarq.setText(title);
}
/** 停掉行内跑马灯（离开列表 / 停止播放时调用） */
function rowMarqueeStop() {
  if (rowMarq) rowMarq.stop();
  if (rowMarqBox) { rowMarqBox.textContent = rowMarqBox.textContent || ""; rowMarqBox.style.transform = ""; }
  rowMarqBox = null;
}

/* ================= 左滑删除（仅从当前歌单移除，不影响其它歌单） =================
   交互对齐 iOS：
     · 行内容左移 d，红色「删除」同步滑到 translateX(SWIPE_W + d)，两者始终紧贴（一整块连续红块）；
     · 松手时按「轻扫方向 + 位移过半」吸附：快速左扫 → 打开；快速右扫 → 收起；慢速则看是否拖过一半；
     · 打开状态下：点行本身 / 点页面其它地方 / 滚动列表 / 右扫 → 自动回弹收起。 */
var rowSwipe = null, rowSwipeOpen = null;
var SWIPE_W = 84;                 // 删除按钮宽度
var SWIPE_EASE = "transform .26s var(--ios-ease), width .26s var(--ios-ease)";
var SWIPE_FLICK = 0.3;            // 轻扫判定速度（px/ms）：超过它即使位移不大也按方向吸附
var SWIPE_STRETCH = 32;           // 删除键完全露出后，还能继续把红块拉长的最大距离（松手回弹）
var swipeGuardUntil = 0;          // 刚滑动过/刚收起时，浏览器仍会补一个 click，这里短暂忽略
function swipeJustDragged() { return Date.now() < swipeGuardUntil; }
/**
 * d ∈ [-SWIPE_W-SWIPE_STRETCH, 0]，分两段：
 *   · d ≥ -SWIPE_W：行内容与红块一起左移，红块紧贴行内容右缘（整行像一块整体在移动，尺寸不变）；
 *   · d < -SWIPE_W：行内容停在 -SWIPE_W 不再继续左移（不会露出右侧背景），
 *     多出来的位移把红块**拉长**（红块右缘始终固定在行的右边缘），松手后回弹。
 */
function rowSwipePaint(li, d) {
  var inner = li.querySelector(".row-inner");
  var del = li.querySelector(".row-del");
  var travel = Math.max(d, -SWIPE_W);                    // 行内容最多左移一个删除键的宽度
  var stretch = Math.max(0, -SWIPE_W - d);               // 超出部分 = 红块的拉伸量
  if (inner) inner.style.transform = travel ? "translateX(" + travel + "px)" : "";
  if (del) {
    del.style.width = (SWIPE_W + stretch) + "px";
    del.style.transform = "translateX(" + (SWIPE_W + travel) + "px)";
  }
}
/** 拖动中不做过渡（跟手），松手/收起时加过渡（吸附动画） */
function rowSwipeEase(li, on) {
  var inner = li.querySelector(".row-inner");
  var del = li.querySelector(".row-del");
  if (inner) inner.style.transition = on ? SWIPE_EASE : "none";
  if (del) del.style.transition = on ? SWIPE_EASE : "none";
}
function rowSwipeSettle(li) {
  setTimeout(function () { rowSwipeEase(li, false); }, 320);
}
function closeRowSwipe(except) {
  if (!rowSwipeOpen || rowSwipeOpen === except) return;
  var li = rowSwipeOpen;
  rowSwipeOpen = null;
  li.classList.remove("swiped");
  rowSwipeEase(li, true);
  rowSwipePaint(li, 0);
  rowSwipeSettle(li);
}
/* 点页面其它地方（标签栏、空白、迷你条…）→ 收起已打开的行；滚动列表同理 */
document.addEventListener("pointerdown", function (e) {
  if (!rowSwipeOpen) return;
  var t = e.target;
  if (t && t.closest && t.closest(".song-row.swiped")) return;      // 点在打开的行内（含删除键）
  closeRowSwipe();
  swipeGuardUntil = Date.now() + 300;                               // 这一下点击只用于收起，不触发播放
}, true);
window.addEventListener("scroll", function () { closeRowSwipe(); }, true);

function armRowSwipe(li, id, ctxPl) {
  var del = li.querySelector(".row-del");
  if (del) del.addEventListener("click", function (e) {
    e.stopPropagation();
    var p = plById(ctxPl || curPlId);
    if (!p) return;
    closeRowSwipe();
    li.classList.add("removing");
    setTimeout(function () {
      removeTrackFromPlaylist(p, id);
      showToast("已从《" + p.name + "》移除");
    }, 160);
  });
  li.addEventListener("pointerdown", function (e) {
    if (e.button !== undefined && e.button !== 0) return;
    if (mselActive || plDrag) return;
    if (e.target.closest(".song-menu-btn") || e.target.closest(".check") || e.target.closest(".row-del")) return;
    rowSwipe = { li: li, id: id, x0: e.clientX, y0: e.clientY, dx: 0, vx: 0,
      lastX: e.clientX, lastT: Date.now(), active: false, pointerId: e.pointerId };
  });
  li.addEventListener("pointermove", function (e) {
    var s = rowSwipe;
    if (!s || s.li !== li || e.pointerId !== s.pointerId) return;
    var dx = e.clientX - s.x0, dy = e.clientY - s.y0;
    // 速度估计（指数平滑）：真实手指的轻扫即使位移不大也应该能打开
    var now = Date.now(), dt = now - s.lastT;
    if (dt > 0) {
      var v = (e.clientX - s.lastX) / dt;
      s.vx = s.vx ? (s.vx * 0.55 + v * 0.45) : v;
      s.lastX = e.clientX;
      s.lastT = now;
    }
    if (!s.active) {
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      var isOpen = li.classList.contains("swiped");
      if (dx > 0 && !isOpen) return;                  // 未打开时右滑不处理
      s.active = true;
      plClickSuppressed = true;                       // 抑制随后的 click（避免误播放）
      if (plDrag) { clearTimeout(plDrag.timer); plDrag = null; }
      try { li.setPointerCapture(e.pointerId); } catch (err) {}
      closeRowSwipe(li);
      rowSwipeEase(li, false);                        // 拖动过程跟手，不加过渡
    }
    var base = li.classList.contains("swiped") ? -SWIPE_W : 0;
    var d = Math.max(-SWIPE_W - SWIPE_STRETCH, Math.min(0, base + dx));
    s.dx = d;
    rowSwipePaint(li, d);
  });
  var finish = function (e) {
    var s = rowSwipe;
    if (!s || s.li !== li) return;
    rowSwipe = null;
    if (!s.active) return;
    var open;
    if (s.dx >= -6) open = false;                                  // 几乎没动 → 保持收起
    else if (s.dx <= -SWIPE_W) open = true;                        // 已拖到底 → 打开
    else if (s.vx <= -SWIPE_FLICK) open = true;                    // 快速左扫（轻扫）→ 打开
    else if (s.vx >= SWIPE_FLICK) open = false;                    // 快速右扫 → 收起
    else open = s.dx < -SWIPE_W / 2;                               // 慢速拖动：看是否过半
    swipeGuardUntil = Date.now() + 400;                            // 松手后的 click 一律忽略
    rowSwipeEase(li, true);
    rowSwipePaint(li, open ? -SWIPE_W : 0);
    rowSwipeSettle(li);
    li.classList.toggle("swiped", open);
    rowSwipeOpen = open ? li : null;
  };
  li.addEventListener("pointerup", finish);
  li.addEventListener("pointercancel", finish);
}
var plLastStartKey = null, plLastStartAt = 0, plClickSuppressed = false;
var mselActive = false, mselSet = new Set();            // 歌单内页：歌曲多选
var plMselActive = false, plMselSet = new Set();        // 主页面：歌单多选

/** 歌单内页的「歌曲多选」（原行为，不变） */
function enterMultiSelect(preselectId) {
  mselActive = true;
  mselSet.clear();
  if (preselectId) mselSet.add(preselectId);
  el("detail-list").classList.add("msel");
  el("msel-bar").classList.add("on");
  updateMselUI();
  showToast("点击勾选歌曲，可删除多首");
}

/** 主页面的「歌单多选」：勾选若干歌单批量删除 */
function enterPlMultiSelect(preselectId) {
  // 注意顺序：showPage() 内部会 exitMultiSelect()，所以必须先切页、再置多选状态
  showPage("library");
  plMselActive = true;
  plMselSet.clear();
  if (preselectId) plMselSet.add(preselectId);
  setLibTab("lists");                 // 切到「歌单」分类并重绘（卡片上会带勾选圈）
  el("msel-bar").classList.add("on");
  updateMselUI();
  uiPush("msel");
  showToast("点击勾选歌单，可批量删除");
}

function exitMultiSelect(silent) {
  var wasPl = plMselActive, wasLib = libMselActive;
  mselActive = false;
  mselSet.clear();
  plMselActive = false;
  plMselSet.clear();
  libMselActive = false;
  libMselSet.clear();
  el("detail-list").classList.remove("msel");
  var box = el(LIB_MSEL_BOX);
  if (box) box.classList.remove("msel");
  el("msel-bar").classList.remove("on");
  uiPopIfTop("msel");
  if (wasPl || wasLib) renderLibrary();
  if (!silent) renderDetail();
}

function togglePlSelect(id) {
  if (plMselSet.has(id)) plMselSet.delete(id);
  else plMselSet.add(id);
  var card = document.querySelector('#lib-grid .lib-card[data-pl-id="' + CSS.escape(id) + '"]');
  if (card) card.classList.toggle("sel", plMselSet.has(id));
  updateMselUI();
}
function toggleSelect(id) {
  if (mselSet.has(id)) mselSet.delete(id);
  else mselSet.add(id);
  var li = el("detail-list").querySelector('li[data-id="' + CSS.escape(id) + '"]');
  if (li) li.classList.toggle("sel", mselSet.has(id));
  updateMselUI();
}
function updateMselUI() {
  if (libMselActive) {                                  // 资料库「全部歌曲」多选
    var rows = el(LIB_MSEL_BOX) ? el(LIB_MSEL_BOX).querySelectorAll("li[data-id]") : [];
    el("msel-del").disabled = libMselSet.size === 0;
    el("msel-del").textContent = "删除选中" + (libMselSet.size ? "（" + libMselSet.size + "）" : "");
    el("msel-all").textContent = rows.length && libMselSet.size === rows.length ? "取消全选" : "全选";
    Array.prototype.forEach.call(rows, function (li) {
      li.classList.toggle("sel", libMselSet.has(li.dataset.id));
    });
    return;
  }
  if (plMselActive) {                                   // 主页面：歌单多选
    var cards = el("lib-grid").querySelectorAll(".lib-card[data-pl-id]");
    el("msel-del").disabled = plMselSet.size === 0;
    el("msel-del").textContent = "删除选中" + (plMselSet.size ? "（" + plMselSet.size + "）" : "");
    el("msel-all").textContent = cards.length && plMselSet.size === cards.length ? "取消全选" : "全选";
    Array.prototype.forEach.call(cards, function (c) {
      c.classList.toggle("sel", plMselSet.has(c.dataset.plId));
    });
    return;
  }
  var all = el("detail-list").querySelectorAll("li[data-id]");
  el("msel-del").disabled = mselSet.size === 0;
  el("msel-del").textContent = "删除选中" + (mselSet.size ? "（" + mselSet.size + "）" : "");
  el("msel-all").textContent = all.length && mselSet.size === all.length ? "取消全选" : "全选";
  all.forEach(function (li) {
    li.classList.toggle("sel", mselSet.has(li.dataset.id));
  });
}
/** 批量删除选中的歌单（主页面的歌单多选） */
function deleteSelectedPlaylists() {
  if (!plMselSet.size) return;
  var ids = Array.from(plMselSet);
  var n = ids.length;
  var curDeleted = ids.indexOf(curPlId) >= 0;
  confirmDialog("删除选中的 " + n + " 个歌单？",
    "歌曲与音乐文件都会保留在资料库里，只删除歌单本身", "删除").then(function (ok) {
    if (!ok) return;
    ids.forEach(function (id) {
      for (var i = 0; i < lib.length; i++) {
        if (lib[i].id === id) { lib.splice(i, 1); break; }
      }
    });
    plMselActive = false;
    plMselSet.clear();
    el("msel-bar").classList.remove("on");
    uiPopIfTop("msel");
    if (curDeleted || !plById(curPlId)) {
      curPlId = lib.length ? lib[0].id : null;
      if (curDeleted) showPage("library");
    }
    saveLib();
    renderLibrary();
    renderDetail();
    renderQueue();
    showToast("已删除 " + n + " 个歌单");
  });
}
function deleteSelected() {
  if (libMselActive) { deleteSelectedLibrarySongs(); return; }
  if (plMselActive) { deleteSelectedPlaylists(); return; }
  var p = plById(curPlId);
  if (!p || !mselSet.size) return;
  var count = mselSet.size;
  var ids = Array.from(mselSet);
  mselSet.clear();
  el("detail-list").classList.remove("msel");
  el("msel-bar").classList.remove("on");
  mselActive = false;
  ids.forEach(function (id) { removeTrackFromPlaylist(p, id); });
  showToast("已删除 " + count + " 首");
}

/* ================= 长按拖拽排序 ================= */
var plDrag = null;
var plDragOrig = null;
/* 长按拖动排序时，用手指拖动不能被浏览器当成列表滚动（真机上否则一拖就滚走） */
document.addEventListener("touchmove", function (e) {
  if (plDrag && plDrag.armed) e.preventDefault();
}, { passive: false });

function onDetailPointerDown(e) {
  if (e.button !== undefined && e.button !== 0) return;
  if (plDrag) return;
  if (e.target.closest(".song-menu-btn") || e.target.closest(".check") || mselActive) return;
  var li = e.target.closest("li.song-row");
  if (!li || li.classList.contains("missing")) return;
  var list = el("detail-list");
  var idx = Array.prototype.indexOf.call(list.querySelectorAll("li[data-id]"), li);
  if (idx < 0) return;
  plDragOrig = plById(curPlId).items.map(function (it) { return it.id; });
  plDrag = {
    li: li, index: idx, startX: e.clientX, startY: e.clientY, armed: false, timer: 0
  };
  plDrag.timer = setTimeout(function () {
    if (!plDrag) return;
    plDrag.armed = true;
    try { plDrag.li.setPointerCapture(e.pointerId); } catch (err) {}
    plDrag.li.classList.add("dragging");
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch (err) {} }
  }, DRAG_HOLD_MS);
}
function onDetailPointerMove(e) {
  if (!plDrag) return;
  if (!plDrag.armed) {
    if (Math.hypot(e.clientX - plDrag.startX, e.clientY - plDrag.startY) > DRAG_SLOP_PX) {
      clearTimeout(plDrag.timer);
      plDrag = null;
    }
    return;
  }
  var list = el("detail-list");
  var vr = list.getBoundingClientRect();
  if (e.clientY < vr.top + 24) list.scrollTop -= 12;
  else if (e.clientY > vr.bottom - 24) list.scrollTop += 12;
  var before = null;
  list.querySelectorAll("li[data-id]").forEach(function (other) {
    if (other === plDrag.li || before) return;
    var r = other.getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) before = other;
  });
  if (before) list.insertBefore(plDrag.li, before);
  else list.appendChild(plDrag.li);
  var from = Array.prototype.indexOf.call(list.querySelectorAll("li[data-id]"), plDrag.li);
  if (from !== plDrag.index) {
    var p = plById(curPlId);
    var item = p.items.splice(plDrag.index, 1)[0];
    p.items.splice(from, 0, item);
    plDrag.index = from;
  }
}
function endDetailDrag(done) {
  if (!plDrag) return;
  clearTimeout(plDrag.timer);
  var armed = plDrag.armed;
  var li = plDrag.li;
  plDrag = null;
  if (!armed) return;
  li.classList.remove("dragging");
  var p = plById(curPlId);
  if (done && p) {
    // 同步 DOM 顺序到数据
    var order = Array.prototype.map.call(
      el("detail-list").querySelectorAll("li[data-id]"),
      function (n) { return n.dataset.id; }
    );
    p.items.sort(function (a, b) {
      return order.indexOf(a.id) - order.indexOf(b.id);
    });
    // 若正在播放本歌单：pl 同步并保持当前曲目
    if (curPlId === p.id && pl.length) {
      var cur = curKey;
      pl = p.items.map(function (it) { return it.id; });
      if (cur) plIndex = Math.max(0, pl.indexOf(cur));
    }
    saveLib();
    renderDetail();
    renderQueue();
    plClickSuppressed = true;
    setTimeout(function () { plClickSuppressed = false; }, 0);
    showToast("已调整播放顺序");
  } else {
    p.items = plDragOrig.map(function (id) {
      for (var i = 0; i < p.items.length; i++) if (p.items[i].id === id) return p.items[i];
      return null;
    }).filter(Boolean);
    renderDetail();
  }
}

/* ================= 队列 ================= */
function renderQueue() {
  var list = el("queue-list");
  list.innerHTML = "";
  var p = plById(curPlId);
  if (p && pl.length) {
    pl.forEach(function (id, i) {
      var li = buildSongRow(id, { menu: false });
      li.addEventListener("click", function (e) {
        if (e.target.closest(".song-menu-btn")) return;
        if (!trackAvailable(id)) { showToast("⚠️ 文件不可读"); return; }
        playIndex(i);
      });
      list.appendChild(li);
    });
  }
  el("queue-count").textContent = pl.length ? pl.length + " 首" : "";
  if (!pl.length) {
    var empty = document.createElement("div");
    empty.className = "sheet-empty";
    empty.textContent = "播放队列为空\n先在歌单中点击一首歌开始播放";
    empty.style.whiteSpace = "pre-line";
    list.appendChild(empty);
  }
  syncPlayState();
}

/* ================= 正在播放界面 ================= */
function showNPArt(cover, name) {
  var npArt = el("np-art"), img = el("np-art-img"), ph = el("np-art-ph");
  var miniArt = el("mini-art"), mimg = el("mini-art-img"), mph = el("mini-art-ph");
  var bg = el("np-bg");
  if (cover) {
    img.src = cover; img.hidden = false; ph.hidden = true;
    mimg.src = cover; mimg.hidden = false; mph.hidden = true;
    bg.style.backgroundImage = 'url("' + cover.replace(/"/g, '\"') + '")';
  } else {
    img.hidden = true; img.removeAttribute("src");
    ph.hidden = false; ph.innerHTML = name ? svgNote() : "";
    mimg.hidden = true; mimg.removeAttribute("src");
    mph.hidden = false; mph.innerHTML = name ? svgNote() : "";
    bg.style.backgroundImage = "";
  }
  if (name) {
    var grad = coverGradient(name);
    npArt.style.background = grad;
    miniArt.style.background = grad;
  } else {
    npArt.style.background = "";
    miniArt.style.background = "";
  }
  // background 简写会把 background-size 重置为 auto（封面只显示一角），这里补回来
  [npArt, miniArt].forEach(function (n) {
    n.style.backgroundSize = "cover";
    n.style.backgroundPosition = "center";
    n.style.backgroundRepeat = "no-repeat";
  });
}
var miniTitleMarq = null, miniArtistMarq = null;
function applyNowMeta() {
  if (micOn) return;
  var t = curKey ? itemOf(curKey) : null;
  if (!t) {
    el("np-title").textContent = "未在播放";
    el("np-artist").textContent = "";
    showNPArt(null, null);
    miniTitleMarq.setText("未在播放");
    miniArtistMarq.setText("");
    el("np-viz-note").textContent = "";
    renderNpLyrics();
    return;
  }
  var meta = trackMeta(t.id);
  var title = (meta && meta.title) || t.name.replace(/\.[^.]+$/, "");
  var artist = meta ? [meta.artist, meta.album].filter(Boolean).join(" · ") : "";
  el("np-title").textContent = title;
  el("np-artist").textContent = artist;
  miniTitleMarq.setText(title);
  miniArtistMarq.setText(artist);
  showNPArt(meta.cover, title);
  if (el("np-viz-note").textContent !== "实时分析中")
    el("np-viz-note").textContent = "";
  renderNpLyrics();
  syncMediaSession();
}
/* 封面 Morph：从迷你条封面位置放大进入播放界面（Apple Music 的标志性转场） */
function morphArtworkIn(fromRect) {
  if (!fromRect || fromRect.width < 8) return;
  var art = el("np-art");
  if (!art) return;
  var to = art.getBoundingClientRect();
  if (!to.width || !to.height) return;
  var dx = fromRect.left - to.left, dy = fromRect.top - to.top;
  var s = fromRect.width / to.width;
  art.style.transition = "none";
  art.style.transformOrigin = "0 0";
  art.style.transform = "translate(" + dx + "px," + dy + "px) scale(" + s + ")";
  art.style.borderRadius = "9px";
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      art.style.transition = "transform .46s var(--ios-ease), border-radius .46s var(--ios-ease)";
      art.style.transform = "translate(0,0) scale(1)";
      art.style.borderRadius = "";
      setTimeout(function () {
        art.style.transition = "";
        art.style.transformOrigin = "";
        art.style.transform = "";
        art.style.borderRadius = "";
      }, 560);
    });
  });
}
/* 复位封面（收回播放界面内、清除动画期间的内联样式） */
function resetNpArt() {
  var art = el("np-art");
  if (!art) return;
  var home = el("np-art-zone");
  art.style.transition = "";
  art.style.transform = "";
  art.style.transformOrigin = "";
  art.style.borderRadius = "";
  art.style.position = "";
  art.style.left = "";
  art.style.top = "";
  art.style.width = "";
  art.style.height = "";
  art.style.zIndex = "";
  if (home && art.parentNode !== home) home.insertBefore(art, home.firstChild);
  var layer = el("np-art-layer");
  if (layer) layer.classList.remove("on");
}
function openNP() {
  if (npOpen) return;
  resetNpArt();          // 上一次收起动画若未结束，先复位
  var fromRect = null;
  try {
    var miniArt = el("mini-art");
    if (miniArt && !el("mini-player").classList.contains("gone")) fromRect = miniArt.getBoundingClientRect();
  } catch (e) { /* 忽略 */ }
  npOpen = true;
  el("np").classList.add("open");
  el("np-volume-pop").classList.add("hidden");
  setNpVizVisible(vizOn);
  applyNowMeta();
  renderNpLyrics();
  // 进场就是整屏从下往上滑入（Apple Music 的 sheet 观感），封面不再单独飞行
  uiPush("np");
}
function closeNP() {
  if (!npOpen) return;
  npOpen = false;
  uiPopIfTop("np");
  // 整屏向下滑出（Apple Music 的 sheet 收起），内容层轻微下沉淡出形成层次；
  // 不再让封面单独飞向迷你条——那样会和面板动作脱节、看起来突兀。
  var np = el("np");
  np.classList.add("closing");
  np.classList.remove("open");
  el("np-volume-pop").classList.add("hidden");
  setTimeout(function () {
    np.classList.remove("closing");
    resetNpArt();
  }, 470);
}
function setNpVizVisible(on) {
  vizUIOpen = on;
  el("np-viz").classList.toggle("on", on);
  el("np-art").style.display = on ? "none" : "";
  el("np-lyrics").classList.toggle("on", lyricsOn && !on);
  el("np-viz-btn").classList.toggle("on", on);
  el("np-lyrics-btn").classList.toggle("on", lyricsOn && !on);
  if (on) fitVizCanvas();
}
function setLyricsUI(on) {
  lyricsOn = on;
  el("np-lyrics").classList.toggle("on", on && !vizUIOpen);
  el("np-lyrics-btn").classList.toggle("on", on);
  if (on) {
    renderNpLyrics();
    if (media) syncLyrics(media.currentTime);
  }
}
function fitVizCanvas() {
  var wrap = el("np-canvas-wrap");
  var canvas = el("np-canvas");
  var w = wrap.clientWidth, h = wrap.clientHeight;
  if (!w || !h) return;
  var dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  return { w: w, h: h, dpr: dpr };
}
function drawVizFrame() {
  var fit = fitVizCanvas();
  if (!fit) return;
  var ctx = el("np-canvas").getContext("2d");
  ctx.setTransform(fit.dpr, 0, 0, fit.dpr, 0, 0);
  ctx.clearRect(0, 0, fit.w, fit.h);
  var w = fit.w, h = fit.h;
  if (vizTab === "spec") {
    analyser.getByteFrequencyData(freqBuf);
    var bars = 52, gap = 3;
    var bw = Math.max(2, (w - gap * (bars - 1)) / bars);
    var minHz = 20, maxHz = viewMaxHz();
    var nyq = audioCtx.sampleRate / 2;
    for (var i = 0; i < bars; i++) {
      var f0 = minHz * Math.pow(maxHz / minHz, i / bars);
      var f1 = minHz * Math.pow(maxHz / minHz, (i + 1) / bars);
      var bin0 = Math.floor(f0 * analyser.fftSize / (nyq * 2));
      var bin1 = Math.max(bin0 + 1, Math.ceil(f1 * analyser.fftSize / (nyq * 2)));
      bin0 = Math.max(0, Math.min(freqBuf.length - 1, bin0));
      bin1 = Math.max(bin0 + 1, Math.min(freqBuf.length, bin1));
      var sum = 0;
      for (var b = bin0; b < bin1; b++) sum += freqBuf[b];
      var v = sum / (bin1 - bin0) / 255;
      var bh = Math.max(1.5, v * h * 0.92);
      var x = i * (bw + gap);
      ctx.globalAlpha = 0.35 + 0.65 * Math.min(1, v * 1.6);
      ctx.fillStyle = cssAccent;
      roundRect(ctx, x, h - bh, bw, bh, Math.min(2.5, bw / 2));
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  } else {
    analyser.getByteTimeDomainData(waveBuf);
    ctx.strokeStyle = cssAccent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    var n = waveBuf.length;
    var step = Math.max(1, Math.floor(n / Math.max(1, Math.floor(w * 2))));
    var mid = h / 2;
    for (var s = 0, px = 0; s < n; s += step) {
      var vv = (waveBuf[s] - 128) / 128;
      var y = mid + vv * h * 0.45;
      var xx = (s / n) * w;
      if (s === 0) ctx.moveTo(xx, y);
      else ctx.lineTo(xx, y);
    }
    ctx.stroke();
  }
}
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* ================= 页面导航 ================= */
var pageStack = [];
function showPage(name) {
  var pages = document.querySelectorAll(".page");
  pages.forEach(function (p) { p.classList.remove("active", "slide-right", "slide-left"); });
  var target = el("page-" + name);
  if (target) target.classList.add("active");
  document.querySelectorAll("#tabbar .tab").forEach(function (t) {
    t.classList.toggle("active", t.dataset.page === name);
  });
  pageStack = [name];
  if (name !== "detail") exitMultiSelect(true);
}
var rowsAnimUntil = 0;    // 列表入场动画的时间窗口
var cardsAnimUntil = 0;   // 卡片入场动画的时间窗口
function openDetail(plId) {
  curPlId = plId;
  saveLib();
  rowsAnimUntil = Date.now() + 700;
  exitMultiSelect(true);
  el("page-detail").classList.add("active", "slide-right");
  document.querySelectorAll(".page").forEach(function (p) {
    if (p.id !== "page-detail") p.classList.remove("active");
  });
  renderDetail();
  uiPush("detail");
}
function closeDetail() {
  el("page-detail").classList.remove("active");
  showPage("library");
  uiPopIfTop("detail");
}

/* ================= 系统返回键（安卓 WebView history 导航） ================= */
var uiStack = [];
var uiBackPending = 0;      // 由「界面按钮关闭」触发的 history.back() 数量：对应的 popstate 要忽略
function uiPush(name) {
  uiStack.push(name);
  try { history.pushState({ hbp: uiStack.length }, ""); } catch (e) {}
}
/**
 * 关闭界面时同步回收浏览器历史条目。
 * 只出 JS 栈而不回退 history 会留下「幽灵条目」：返回键先被这些空条目吞掉，
 * 用户要按很多次（且看起来没反应）才能退出应用。
 */
function uiPopIfTop(name) {
  if (uiStack.length && uiStack[uiStack.length - 1] === name) {
    uiStack.pop();
    // 只有「当前条目确实是我们 pushState 出来的」才回退：
    // 关闭界面后紧接着又打开新界面时，先前那次 back() 可能晚于新的 pushState 执行，
    // 此时当前条目已经变回基准条目，再 back() 会把页面整个导航走（WebView 里表现为白屏/退出）。
    if (history.state && history.state.hbp) {
      uiBackPending++;
      try { history.back(); } catch (e) { uiBackPending--; if (uiBackPending < 0) uiBackPending = 0; }
    }
  }
}
window.addEventListener("popstate", function () {
  if (uiBackPending > 0) { uiBackPending--; return; }   // 我们自己关界面时触发的回退，界面已经关好了
  var name = uiStack.pop();
  if (!name) return;
  if (name === "dialog") { if (dialogResolve) dialogResolve(null); }
  else if (name === "sheet") closeSheet();
  else if (name === "np") closeNP();
  else if (name === "detail") closeDetail();
  else if (name === "group") closeGroup();
  else if (name === "bili") closeBili();
  else if (name === "msel") exitMultiSelect();
});

/* ================= 面板（队列 / 菜单） ================= */
var openSheetEl = null;
function openSheet(sel) {
  closeSheet();
  openSheetEl = el(sel);
  openSheetEl.classList.add("open");
  el("scrim").classList.add("on");
  uiPush("sheet");
}
function closeSheet() {
  if (openSheetEl) openSheetEl.classList.remove("open");
  openSheetEl = null;
  el("scrim").classList.remove("on");
  uiPopIfTop("sheet");
}
function openMenu(title, items, customHTML) {
  var menu = el("menu");
  el("menu-title").textContent = title || "";
  var box = el("menu-items");
  box.innerHTML = "";
  if (customHTML) {
    box.innerHTML = customHTML;
  } else {
    (items || []).forEach(function (it) {
      var b = document.createElement("button");
      b.className = "menu-item" + (it.danger ? " danger" : "");
      b.innerHTML = '<span class="mi-ic">' + esc(it.icon || "") + "</span>" +
        "<span>" + esc(it.label) + "</span>" +
        (it.sub ? '<span class="mi-sub">' + esc(it.sub) + "</span>" : "");
      b.addEventListener("click", function () {
        var fn = it.fn;
        closeSheet();
        if (fn) setTimeout(fn, 60);
      });
      box.appendChild(b);
    });
  }
  openSheet("menu");
}
function openQueue() {
  renderQueue();
  openSheet("queue");
}

/* ================= 弹窗 ================= */
var dialogResolve = null;
var dialogIsConfirm = false;      // true = 当前是确认框（没有输入框，确定 = true）
function showDialog(title, initial) {
  dialogIsConfirm = false;
  var noteEl = el("dialog-note");
  if (noteEl) noteEl.classList.add("hidden");
  el("dialog-title").textContent = title;
  el("dialog-input").value = initial || "";
  el("dialog").classList.add("on");
  uiPush("dialog");
  setTimeout(function () {
    el("dialog-input").focus();
    try { el("dialog-input").select(); } catch (e) {}
  }, 60);
  return new Promise(function (resolve) {
    dialogResolve = function (v) {
      el("dialog").classList.remove("on");
      uiPopIfTop("dialog");
      resolve(v);
    };
  });
}
function confirmDialog(title, note, okLabel) {
  el("dialog-title").textContent = title;
  var noteEl = el("dialog-note");
  if (noteEl) {
    noteEl.textContent = note || "";
    noteEl.classList.toggle("hidden", !note);
  }
  el("dialog-input").value = "";
  el("dialog-input").style.display = "none";
  el("dialog-ok").textContent = okLabel || "确定";
  el("dialog").classList.add("on");
  uiPush("dialog");
  dialogIsConfirm = true;                 // 确认框没有输入框：确定按钮要返回 true，而不是空字符串
  return new Promise(function (resolve) {
    dialogResolve = function (v) {
      el("dialog").classList.remove("on");
      el("dialog-input").style.display = "";
      el("dialog-ok").textContent = "确定";
      if (noteEl) noteEl.classList.add("hidden");
      dialogIsConfirm = false;
      uiPopIfTop("dialog");
      resolve(v);
    };
  });
}

/* ================= 搜索 ================= */
function doSearch() {
  var q = el("search-input").value.trim().toLowerCase();
  var box = el("search-results");
  box.innerHTML = "";
  if (!q) {
    box.innerHTML = '<div class="search-empty">输入歌单名或歌曲名搜索</div>';
    return;
  }
  var songHits = [], plHits = [];
  lib.forEach(function (p) {
    if (p.name.toLowerCase().indexOf(q) >= 0) plHits.push(p);
    p.items.forEach(function (it) {
      var name = trackNameOf(it.id) || it.name || "";
      var meta = metaCache.get(it.id);
      var hay = name.toLowerCase() + " " + ((meta && meta.title) || "").toLowerCase() +
        " " + ((meta && meta.artist) || "").toLowerCase() +
        " " + ((meta && meta.album) || "").toLowerCase();
      if (hay.indexOf(q) >= 0) songHits.push({ p: p, id: it.id });
    });
  });
  var seen = new Set();
  songHits = songHits.filter(function (h) {
    if (seen.has(h.id)) return false;
    seen.add(h.id);
    return true;
  }).slice(0, 50);
  if (songHits.length) {
    var t1 = document.createElement("div");
    t1.className = "search-group-title";
    t1.textContent = "歌曲";
    box.appendChild(t1);
    var ul = document.createElement("ul");
    ul.className = "song-list";
    songHits.forEach(function (h) {
      var li = buildSongRow(h.id, { menu: false });
      li.addEventListener("click", function (e) {
        if (e.target.closest(".song-menu-btn")) return;
        if (!trackAvailable(h.id)) { showToast("⚠️ 文件不可读"); return; }
        playFromItems(h.p.id, h.id);
      });
      ul.appendChild(li);
    });
    box.appendChild(ul);
  }
  if (plHits.length) {
    var t2 = document.createElement("div");
    t2.className = "search-group-title";
    t2.textContent = "歌单";
    box.appendChild(t2);
    var ul2 = document.createElement("ul");
    ul2.className = "song-list";
    plHits.forEach(function (p) {
      var li = document.createElement("li");
      li.className = "song-row";
      li.innerHTML =
        '<span class="cover"></span>' +
        '<span class="song-info"><span class="song-name">' + esc(p.name) + "</span>" +
        '<span class="song-sub">' + p.items.length + " 首</span></span>";
      coverThumb(p.items[0] ? p.items[0].id : null, li.querySelector(".cover"));
      if (!p.items.length) {
        li.querySelector(".cover").style.background = coverGradient(p.name);
        li.querySelector(".cover").innerHTML = '<span class="ph">' + svgNote() + "</span>";
      }
      li.addEventListener("click", function () { openDetail(p.id); });
      ul2.appendChild(li);
    });
    box.appendChild(ul2);
  }
  if (!songHits.length && !plHits.length) {
    box.innerHTML = '<div class="search-empty">没有找到「' + esc(el("search-input").value.trim()) + "」相关的内容</div>";
  }
}

/* ================= 图片选择 ================= */
function pickImage() {
  if (NATIVE) {
    return bridgeCall("pickImage").then(function (r) {
      return r && r.id ? r.id : null;
    }).catch(function () { return null; });
  }
  return new Promise(function (resolve) {
    var input = el("pick-img");
    var done = false;
    input.onchange = function () {
      var f = input.files && input.files[0];
      input.value = "";
      if (!f) { if (!done) { done = true; resolve(null); } return; }
      downscaleImage(f, 1024).then(function (dataURL) {
        if (!done) { done = true; resolve(dataURL); }
      });
    };
    input.click();
  });
}
function downscaleImage(file, maxDim) {
  return new Promise(function (resolve) {
    var rd = new FileReader();
    rd.onload = function () {
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        var c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.width * scale));
        c.height = Math.max(1, Math.round(img.height * scale));
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        try { resolve(c.toDataURL("image/jpeg", 0.88)); }
        catch (e) { resolve(null); }
      };
      img.onerror = function () { resolve(null); };
      img.src = rd.result;
    };
    rd.onerror = function () { resolve(null); };
    rd.readAsDataURL(file);
  });
}

/* ================= 背景 ================= */
function applyBGPanel() {
  var on = !!(bgStore && document.body.classList.contains("has-bg"));
  el("set-bg").classList.toggle("on", on);
  el("set-bg-panel").classList.toggle("hidden", !on);
  el("set-bg-dim").value = String(bgDim);
  el("set-bg-dim-val").textContent = Math.round(bgDim * 100) + "%";
}
function toggleBG() {
  if (bgStore) {
    if (document.body.classList.contains("has-bg")) applyBG(null);
    else applyBG(bgStore);
    applyBGPanel();
  } else {
    pickImage().then(function (ref) {
      if (!ref) return;
      applyBG(ref.indexOf("data:") === 0 ? ref : "id:" + ref);
      applyBGPanel();
      showToast("已设置自定义背景");
    });
  }
}
function clearBG() {
  applyBG(null);
  applyBGPanel();
  showToast("已清除背景");
}

/* ================= 歌词选择 ================= */
function pickLyrics() {
  if (!curKey || micOn) { showToast("请先播放一首歌再载入歌词"); return; }
  var id = curKey;
  if (NATIVE) {
    bridgeCall("readTextFile", { kind: "lrc" }).then(function (r) {
      if (!r || typeof r.content !== "string") { showToast("未选择文件"); return; }
      setLyricsFor(id, r.content);
      showToast("歌词已载入：" + (r.name || ""));
      if (npOpen) setLyricsUI(true);
    }).catch(function (err) { showToast("载入失败：" + (err.message || err)); });
  } else {
    var input = el("pick-lrc");
    input.onchange = function () {
      var f = input.files && input.files[0];
      input.value = "";
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        if (typeof fr.result === "string") {
          setLyricsFor(id, fr.result);
          showToast("歌词已载入：" + f.name);
          if (npOpen) setLyricsUI(true);
        }
      };
      fr.readAsText(f);
    };
    input.click();
  }
}

/* ================= 事件接线 ================= */
/**
 * 进度条拖动：拖动过程中只更新界面（平滑跟手），松手才真正 seek。
 * 原因：特殊格式（杜比 PCM WAV）每个 currentTime 都会触发新的 HTTP Range 请求，
 * 若逐帧 seek 会卡顿且看起来「拖不动」。
 */
function makeSeekable(bar, fn) {
  var seeking = false;
  bar.addEventListener("pointerdown", function (e) {
    seeking = true;
    try { bar.setPointerCapture(e.pointerId); } catch (err) {}
    fn(e, true);
  });
  bar.addEventListener("pointermove", function (e) { if (seeking) fn(e, true); });
  var end = function (e) {
    if (!seeking) return;
    seeking = false;
    if (e.type === "pointerup") fn(e, false);      // 取消手势不跳转
    else el("np-seek").classList.remove("dragging");
  };
  bar.addEventListener("pointerup", end);
  bar.addEventListener("pointercancel", end);
}
function seekFromEvent(e, previewOnly) {
  if (!media || !isFinite(media.duration) || media.duration <= 0) return;
  var bar = e.currentTarget || el("np-seek");
  var r = bar.getBoundingClientRect();
  if (!r.width) return;
  var frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  var t = frac * media.duration;
  if (previewOnly) {
    el("np-seek-fill").style.width = (frac * 100) + "%";
    el("np-seek-knob").style.left = (frac * 100) + "%";
    el("np-cur").textContent = fmtTime(t);
    el("np-seek").classList.add("dragging");
    return;
  }
  el("np-seek").classList.remove("dragging");
  media.currentTime = t;
  updateProgressUI();
}
function armLongPress(node, fn) {
  var timer = 0, sx = 0, sy = 0;
  node.addEventListener("pointerdown", function (e) {
    if (e.button !== undefined && e.button !== 0) return;
    sx = e.clientX; sy = e.clientY;
    timer = setTimeout(function () {
      timer = 0;
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch (err) {} }
      fn();
    }, 460);
  });
  node.addEventListener("pointermove", function (e) {
    if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 9) { clearTimeout(timer); timer = 0; }
  });
  node.addEventListener("pointerup", function () { if (timer) { clearTimeout(timer); timer = 0; } });
  node.addEventListener("pointercancel", function () { if (timer) { clearTimeout(timer); timer = 0; } });
}

/* ================= B 站音频下载 ================= */
var biliState = {
  info: null,
  qualities: [],
  qualityId: 0,
  parts: {},          // cid -> true（选中的分 P）
  partList: [],
  tasks: {},          // taskId -> task
  account: null,
  qrKey: null,
  qrTimer: 0,
  banner: null,
};

function fmtSize(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / 1048576).toFixed(2) + " MB";
}
function fmtSpeed(bps) {
  if (!bps || bps <= 0) return "";
  if (bps < 1048576) return (bps / 1024).toFixed(0) + " KB/s";
  return (bps / 1048576).toFixed(1) + " MB/s";
}

/* ---------- 下载设置（文件夹 / 速率 / 放入歌单） ---------- */
var biliDirUri = "";        // SAF 目录树 URI（空 = 默认 音乐/Hibiki Player）
var biliDirName = "";
var biliSpeed = 0;          // KB/s，0 = 不限速
var biliPl = "";            // 下载完成后放入的歌单 id（空 = 默认「B站下载」）
var BILI_SPEEDS = [0, 512, 1024, 2048, 5120];
var BILI_DEFAULT_PL = "B站下载";
function biliSpeedText(kb) {
  if (!kb) return "不限";
  return kb >= 1024 ? (kb / 1024) + " MB/s" : kb + " KB/s";
}
/**
 * 下载完成后音频要放入的歌单：
 *   · 设置了就用设置的（歌单被删掉则回落到同名歌单）；
 *   · 没有「B站下载」这个歌单时，create=true 才新建（默认歌单）。
 */
function biliTargetPl(create) {
  var p = biliPl ? plById(biliPl) : null;
  if (p) return p;
  for (var i = 0; i < lib.length; i++) {
    if (lib[i].name === BILI_DEFAULT_PL) { biliPl = lib[i].id; savePrefs(); return lib[i]; }
  }
  if (!create) return null;
  var np = {
    id: "pl" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
    name: BILI_DEFAULT_PL, coverMode: "first", coverImageId: null, items: []
  };
  lib.push(np);
  biliPl = np.id;
  savePrefs();
  return np;
}
function biliPlText() {
  var p = biliTargetPl(false);
  return p ? p.name : BILI_DEFAULT_PL + "（默认）";
}
function renderBiliDownloadSettings() {
  var dirText = biliDirUri ? (biliDirName || "已选择文件夹") : "默认（音乐/Hibiki Player）";
  var speedText = biliSpeedText(biliSpeed);
  var plText = biliPlText();
  [["set-bili-dir-val", dirText], ["bili-set-dir-val", dirText],
   ["set-bili-speed-val", speedText], ["bili-set-speed-val", speedText],
   ["set-bili-pl-val", plText], ["bili-set-pl-val", plText]].forEach(function (pair) {
    var node = el(pair[0]);
    if (node) node.textContent = pair[1];
  });
}
/** 选择「下载放入歌单」：已有歌单 + 新建 */
/** 设置页「关于」：版本与功能清单都按当前实现渲染，避免文案落后于功能 */
function renderAbout() {
  var note = el("about-note");
  if (note) {
    note.innerHTML =
      "<b>Hibiki Player（安卓版）v" + APP_VERSION + "</b><br>" +
      "波形 · 频谱 · 歌词 · Apple Music 风格界面<br><br>" +
      "· <b>本地播放</b>：MP3 / FLAC / M4A / WAV / OGG 等；杜比（E-AC-3 / AC-3）、DTS、TrueHD、WMA 等" +
      "特殊格式由内置 FFmpeg 解码为 PCM，支持多声道原生输出与下混；<br>" +
      "· <b>资料库</b>：歌单 / 歌曲 / 专辑 / 艺人四种分类；全部歌曲可按「默认 / 加入顺序 / 首字母」排序并支持正倒序，" +
      "按首字母时右侧有字母索引条，艺人默认按首字母排列；<br>" +
      "· <b>B 站音频下载</b>：粘贴或分享链接解析，可选 Hi-Res 无损 / 杜比全景声等档位；下载的音频内嵌封面与标签，" +
      "合集会自动建同名子文件夹并按分P命名，完成后统一加入「下载放入歌单」（默认《" + BILI_DEFAULT_PL + "》）；<br>" +
      "· 歌词（LRC）、播放队列、四种播放模式、多选管理、歌单封面自定义、左滑删除与长按拖动排序；<br>" +
      "· <b>隐私</b>：歌单、设置、B 站登录 Cookie 全部只保存在本机，无任何联网上报。";
  }
  var foot = el("set-foot");
  if (foot) foot.textContent = "Hibiki Player · v" + APP_VERSION + " Android";
}
function openBiliPlMenu() {
  var items = lib.map(function (p) {
    return { label: "🎵 " + p.name, sub: p.id === biliPl ? "✓" : (p.items.length + " 首"), fn: function () {
      biliPl = p.id;
      savePrefs();
      renderBiliDownloadSettings();
      showToast("下载完成后放入《" + p.name + "》");
    } };
  });
  items.push({ label: "➕ 新建歌单…", sub: "下载完成后放入新歌单", fn: function () {
    showDialog("新建歌单（下载放入）", "").then(function (name) {
      if (name == null) return;
      name = String(name).trim();
      if (!name) { showToast("名称不能为空"); return; }
      var p = {
        id: "pl" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
        name: name, coverMode: "first", coverImageId: null, items: []
      };
      lib.push(p);
      biliPl = p.id;
      saveLib(); savePrefs();
      renderLibrary(); renderBiliDownloadSettings();
      showToast("已新建《" + name + "》，下载完成后放入");
    });
  } });
  items.push({ label: "↩️ 恢复默认", sub: BILI_DEFAULT_PL, fn: function () {
    biliPl = "";
    savePrefs();
    renderBiliDownloadSettings();
    showToast("下载完成后放入《" + BILI_DEFAULT_PL + "》");
  } });
  openMenu("下载放入歌单", items);
}
function cycleBiliSpeed() {
  var idx = BILI_SPEEDS.indexOf(biliSpeed);
  biliSpeed = BILI_SPEEDS[(idx + 1) % BILI_SPEEDS.length];
  savePrefs();
  renderBiliDownloadSettings();
  showToast("下载速率：" + biliSpeedText(biliSpeed));
}
function openBiliDirMenu() {
  openMenu("下载文件夹", [
    { label: "📁 选择文件夹", sub: NATIVE ? "" : "需要安卓版", fn: function () { pickBiliDir(); } },
    { label: "↩️ 恢复默认", sub: "音乐/Hibiki Player", fn: function () {
        biliDirUri = "";
        biliDirName = "";
        savePrefs();
        renderBiliDownloadSettings();
        showToast("已恢复默认下载文件夹");
      } }
  ]);
}
function pickBiliDir() {
  if (!NATIVE) { showToast("选择文件夹需要安卓版"); return; }
  bridgeCall("pickDownloadDir").then(function (r) {
    if (!r || !r.uri) { showToast("已取消"); return; }
    biliDirUri = r.uri;
    biliDirName = r.name || "";
    savePrefs();
    renderBiliDownloadSettings();
    showToast("下载文件夹：" + (biliDirName || "已选择"));
  }).catch(function (err) {
    showToast("选择失败：" + (err.message || err));
  });
}

/* ---------- 页面进出 ---------- */
function openBili() {
  el("page-bili").classList.add("active", "slide-right");
  document.querySelectorAll(".page").forEach(function (p) {
    if (p.id !== "page-bili") p.classList.remove("active");
  });
  document.querySelectorAll("#tabbar .tab").forEach(function (t) { t.classList.remove("active"); });
  biliRefreshAccount();
  biliRefreshTasks();
  uiPush("bili");
}
function closeBili() {
  el("page-bili").classList.remove("active");
  showPage("library");
  uiPopIfTop("bili");
}

/* ---------- 结果渲染 ---------- */
function biliRenderResult() {
  var info = biliState.info;
  var box = el("bili-result");
  if (!info) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  el("bili-title").textContent = info.title || "";
  el("bili-owner").textContent = info.owner ? ("UP主：" + info.owner) : "";
  var secs = info.duration || 0;
  el("bili-meta").textContent = (info.pages.length > 1 ? info.pages.length + " 个分P · " : "") + "总时长 " + fmtTime(secs);
  setBiliImage(el("bili-cover"), info.pic);
  // 分 P 列表
  var parts = el("bili-parts");
  parts.innerHTML = "";
  parts.classList.toggle("hidden", info.pages.length <= 1);
  info.pages.forEach(function (p, i) {
    var row = document.createElement("div");
    row.className = "bili-part" + (biliState.parts[p.cid] ? " on" : "");
    row.innerHTML = '<span class="idx">' + (biliState.parts[p.cid] ? "✓" : (i + 1)) + "</span>" +
      '<span class="pt"></span><span class="dur">' + fmtTime(p.duration) + "</span>";
    row.querySelector(".pt").textContent = p.part || ("P" + (i + 1));
    row.addEventListener("click", function () {
      if (biliState.parts[p.cid]) delete biliState.parts[p.cid];
      else biliState.parts[p.cid] = true;
      biliRenderResult();
      biliLoadQualities();
    });
    parts.appendChild(row);
  });
  // 音质
  var seg = el("bili-q-seg");
  seg.innerHTML = "";
  if (!biliState.qualities.length) {
    el("bili-q-cur").textContent = "解析中…";
  } else {
    var cur = biliState.qualities.filter(function (q) { return q.id === biliState.qualityId; })[0] || biliState.qualities[0];
    biliState.qualityId = cur.id;
    el("bili-q-cur").textContent = cur.label + (cur.bandwidth ? " · " + Math.round(cur.bandwidth / 1000) + " kbps" : "");
    biliState.qualities.forEach(function (q) {
      var b = document.createElement("button");
      b.textContent = q.short || q.label;
      b.title = q.label;
      b.dataset.qid = String(q.id);
      b.dataset.kind = q.kind || "";
      b.className = q.id === biliState.qualityId ? "on" : "";
      b.addEventListener("click", function () {
        biliState.qualityId = q.id;
        biliRenderResult();
      });
      seg.appendChild(b);
    });
  }
  // 未登录（或该视频没有会员音轨）时，提示如何解锁 Hi-Res / 杜比
  var hint = el("bili-q-hint");
  if (hint) {
    var hasPremium = biliState.qualities.some(function (q) { return q.kind === "flac" || q.kind === "dolby"; });
    if (hasPremium) {
      hint.textContent = "已解锁会员音轨：Hi-Res 无损 / 杜比全景声为原始码流，不重编码，文件更大。";
      hint.classList.remove("hidden");
    } else if (biliState.account) {
      hint.textContent = "当前账号未解锁该视频的 Hi-Res / 杜比音轨（需大会员，且视频本身要有对应音轨）。";
      hint.classList.remove("hidden");
    } else {
      hint.textContent = "登录 B 站账号（大会员）后可解锁 Hi-Res 无损 / 杜比全景声档位。";
      hint.classList.remove("hidden");
    }
  }
  var n = Object.keys(biliState.parts).length;
  el("bili-download").lastChild.textContent = n > 1 ? ("下载 " + n + " 个分P") : "下载到音乐目录";
}

/* 音质档位固定名称（与桌面版一致） */
var BILI_Q_LABEL = { 30216: "64K", 30232: "132K", 30280: "192K", 30250: "杜比全景声", 30251: "Hi-Res 无损" };
var BILI_Q_SHORT = { 30216: "64K", 30232: "132K", 30280: "192K", 30250: "杜比", 30251: "Hi-Res" };
/**
 * 从 playurl 的 DASH 数据解析可选音质（与桌面版 bili-ipc.js 同一套逻辑）：
 *   dash.audio        → AAC 档位（64K / 132K / 192K）
 *   dash.flac.audio   → Hi-Res 无损（需登录 + 大会员）
 *   dash.dolby.audio  → 杜比全景声（需登录 + 大会员）
 * 三项都可能为 null，必须逐层判空。
 */
function biliParseQualities(dash) {
  var out = [];
  var seen = {};
  var push = function (a, kind) {
    if (!a || typeof a !== "object") return;
    var url = a.baseUrl || a.base_url || "";
    if (!url) return;
    var id = Number(a.id || 0);
    var bw = Number(a.bandwidth || 0);
    var codec = String(a.codecs || a.codec || "");
    var key = kind + "|" + id;
    if (seen[key] != null && out[seen[key]].bandwidth >= bw) return;   // 同档位保留带宽更大的线路
    var backups = [];
    var bu = a.backupUrl || a.backup_url;
    if (bu && bu.length) for (var i = 0; i < bu.length; i++) backups.push(bu[i]);
    var item = {
      id: id, kind: kind, codec: codec, mime: a.mimeType || a.mime_type || "",
      bandwidth: bw, url: url, backups: backups,
      label: BILI_Q_LABEL[id] || (kind === "flac" ? "Hi-Res 无损" : (kind === "dolby" ? "杜比全景声" : (id ? String(id) : codec))),
      short: BILI_Q_SHORT[id] || (kind === "flac" ? "Hi-Res" : (kind === "dolby" ? "杜比" : (id ? String(id) : "音质")))
    };
    if (seen[key] == null) { seen[key] = out.length; out.push(item); }
    else out[seen[key]] = item;
  };
  var d = dash || {};
  // Hi-Res 无损
  if (d.flac && (d.flac.display === undefined || d.flac.display)) push(d.flac.audio, "flac");
  // 杜比全景声（audio 可能是对象或数组）
  if (d.dolby && d.dolby.audio) {
    if (Object.prototype.toString.call(d.dolby.audio) === "[object Array]")
      d.dolby.audio.forEach(function (a) { push(a, "dolby"); });
    else push(d.dolby.audio, "dolby");
  }
  // AAC 档位
  (d.audio || []).forEach(function (a) { push(a, "aac"); });
  // 排序：无损 → 杜比 → AAC 按带宽从高到低
  var rank = { flac: 0, dolby: 1, aac: 2 };
  out.sort(function (a, b) {
    if (rank[a.kind] !== rank[b.kind]) return rank[a.kind] - rank[b.kind];
    return (b.bandwidth || 0) - (a.bandwidth || 0);
  });
  return out;
}
function biliLoadQualities() {
  var info = biliState.info;
  if (!info) return;
  var cids = Object.keys(biliState.parts);
  if (!cids.length) { biliState.qualities = []; biliRenderResult(); return; }
  var cid = Number(cids[0]);
  el("bili-q-cur").textContent = "解析中…";
  bridgeCall("biliQualities", { bvid: info.bvid, cid: cid }).then(function (res) {
    if (res && res.dash) biliState.qualities = biliParseQualities(res.dash);
    else biliState.qualities = (res && res.qualities) || [];   // 兼容旧桥格式
    if (biliState.qualities.length && !biliState.qualities.some(function (q) { return q.id === biliState.qualityId; })) {
      // 默认选排序后的第一档：Lossless / 杜比 → 192K
      biliState.qualityId = biliState.qualities[0].id;
    }
    biliRenderResult();
  }).catch(function (err) {
    biliState.qualities = [];
    el("bili-q-cur").textContent = "不可用";
    showToast("无法获取音质：" + (err.message || err));
  });
}

/* ---------- 解析 ---------- */
function biliParseText(text) {
  text = (text || "").trim();
  if (!text) { showToast("请先粘贴 B 站链接"); return; }
  if (!NATIVE) { showToast("B 站下载需要安卓版（浏览器模式无网络桥）"); return; }
  showToast("正在解析…", 1200);
  el("bili-result").classList.add("hidden");
  bridgeCall("biliParse", { text: text }).then(function (info) {
    biliState.info = info;
    biliState.parts = {};
    biliState.qualities = [];
    biliState.qualityId = 0;
    if (info.pages && info.pages.length) biliState.parts[info.pages[0].cid] = true;   // 默认只选第一个分P
    biliRenderResult();
    biliLoadQualities();
    hideBiliBanner();
  }).catch(function (err) {
    showToast("解析失败：" + (err.message || err));
  });
}

function biliPaste() {
  bridgeCall("biliClipboard").then(function (r) {
    var text = (r && r.text) || "";
    if (!text) { showToast("剪贴板里没有内容"); return; }
    el("bili-input").value = text;
    var link = text.match(/https?:\/\/\S+/);
    biliParseText(link ? link[0] : text);
  }).catch(function () { showToast("无法读取剪贴板"); });
}

/* ---------- 下载 ---------- */
/**
 * 取某个分P的音质清单。
 * 关键：**每个分P的音频流地址都不一样**，必须逐P调 playurl。
 * （曾出现「选集下载几十个分P，下完发现全是第一P」—— 就是因为所有任务共用了第一P的 url）
 */
function biliQualitiesFor(cid, retried) {
  return bridgeCall("biliQualities", { bvid: biliState.info.bvid, cid: cid }).then(function (res) {
    if (res && res.dash) return biliParseQualities(res.dash);
    return (res && res.qualities) || [];        // 兼容旧桥格式
  }).catch(function (err) {
    if (retried) throw err;
    // 分P多时 B 站接口偶发限流/抖动：隔 700ms 重试一次再算失败
    return new Promise(function (r) { setTimeout(r, 700); }).then(function () { return biliQualitiesFor(cid, true); });
  });
}
/** 在某个分P的音质清单里挑出与所选档位对应的流；该分P没有同档时退回同类最高档 */
function biliPickQuality(list, want) {
  if (!list || !list.length) return null;
  var same = list.filter(function (q) { return q.id === want.id; })[0];
  if (same) return same;
  var kind = list.filter(function (q) { return q.kind === want.kind; });
  if (kind.length) return kind[0];              // 清单已按「无损 → 杜比 → AAC」且带宽降序排好
  return list[0];
}
function biliStartDownload() {
  var info = biliState.info;
  if (!info) { showToast("请先解析链接"); return; }
  var q = biliState.qualities.filter(function (x) { return x.id === biliState.qualityId; })[0];
  if (!q) { showToast("请先选择音质"); return; }
  var cids = Object.keys(biliState.parts).map(Number);
  if (!cids.length) { showToast("请至少选择一个分P"); return; }
  // 按分P在视频里的顺序下载（P1、P2…）
  var order = {};
  (info.pages || []).forEach(function (p, i) { order[p.cid] = i; });
  // 合集（多 P）视频：在下载文件夹里建一个以视频名命名的子文件夹，
  // 子文件夹内的文件只用分P名（原生侧 BiliNaming 负责最终命名）
  var isCollection = (info.pages || []).length > 1;
  cids.sort(function (a, b) { return (order[a] == null ? 0 : order[a]) - (order[b] == null ? 0 : order[b]); });

  el("bili-tasks-title").classList.remove("hidden");
  if (cids.length > 1) showToast("正在获取 " + cids.length + " 个分P的音频地址…", 1800);

  var queue = cids.slice(), inflight = 0, started = 0, failed = 0, doneNotified = false;
  function startPart(cid) {
    var part = (info.pages.filter(function (p) { return p.cid === cid; })[0] || {});
    return biliQualitiesFor(cid).then(function (list) {
      var s = biliPickQuality(list, q);
      if (!s || !s.url) throw new Error("该分P没有可用音频");
      return bridgeCall("biliStart", {
        bvid: info.bvid, cid: cid,
        title: info.title, part: part.part || "",
        owner: info.owner || "",
        qualityId: s.id, qualityLabel: s.label, codec: s.codec || "",
        url: s.url, backups: s.backups || [], pic: info.pic || "",
        dirUri: biliDirUri || "", speedKbps: biliSpeed || 0,
        page: part.page || 0,
        folder: isCollection ? info.title : ""
      });
    }).then(function (res) {
      if (res && res.task) {
        biliState.tasks[res.task.id] = res.task;
        biliRenderTasks();
      }
      started++;
      if (started === 1) showToast("已开始下载，可在本页查看进度");
    }).catch(function (err) {
      failed++;
      showToast("分P「" + (part.part || cid) + "」失败：" + ((err && err.message) || err), 2600);
    }).then(function () {
      inflight--;
      pump();
    });
  }
  function pump() {
    if (queue.length && inflight < 2) {
      inflight++;
      startPart(queue.shift());
      // 轻微错开请求：分P 多（几十个）时避免触发 B 站接口限流
      if (queue.length) setTimeout(pump, 150);
    } else if (!queue.length && inflight === 0 && !doneNotified) {
      doneNotified = true;
      if (cids.length > 1) showToast("已提交 " + started + " 个分P的下载" + (failed ? "（" + failed + " 个取地址失败）" : ""), 2600);
    }
  }
  pump();
}

function biliCancelTask(id) {
  bridgeCall("biliCancel", { taskId: id }).catch(function () {});
  var t = biliState.tasks[id];
  if (t) { t.state = "cancelled"; biliRenderTasks(); }
}

/* 任务卡片：原地更新（进度每秒推送多次，重建 DOM 会让整栏反复播放入场动画） */
var biliTaskNodes = {};
function biliBuildTaskCard(id) {
  var root = document.createElement("div");
  root.className = "bili-task";
  var th = document.createElement("div");
  th.className = "th";
  var tt = document.createElement("span");
  tt.className = "tt";
  var st = document.createElement("span");
  st.className = "st";
  th.appendChild(tt); th.appendChild(st);
  var bar = document.createElement("div");
  bar.className = "bar";
  var fill = document.createElement("i");
  bar.appendChild(fill);
  var tf = document.createElement("div");
  tf.className = "tf";
  var sp = document.createElement("span");
  sp.className = "sp";
  tf.appendChild(sp);
  root.appendChild(th); root.appendChild(bar); root.appendChild(tf);
  var cancel = document.createElement("button");
  cancel.textContent = "取消";
  cancel.addEventListener("click", function () { biliCancelTask(id); });
  var added = document.createElement("span");
  added.textContent = "已加入歌单";
  added.style.color = "var(--accent)";
  return { root: root, tt: tt, st: st, fill: fill, sp: sp, tf: tf, cancel: cancel, added: added, state: null };
}
function biliUpdateTaskCard(node, t) {
  var pct = t.total > 0 ? Math.min(100, Math.round(t.bytes * 100 / t.total)) : (t.state === "done" ? 100 : 0);
  var stateText = {
    pending: "等待中", downloading: pct + "%", muxing: "封装中…",
    done: "已完成", error: "失败", cancelled: "已取消"
  }[t.state] || t.state;
  node.tt.textContent = t.title + (t.part && t.part !== t.title ? " · " + t.part : "") +
    (t.quality ? "（" + t.quality + "）" : "");
  node.st.textContent = stateText;
  node.fill.style.width = pct + "%";
  var info = "";
  if (t.state === "downloading") {
    info = fmtSize(t.bytes) + (t.total ? " / " + fmtSize(t.total) : "") + (t.speed ? " · " + fmtSpeed(t.speed) : "");
  } else if (t.state === "done") {
    info = fmtSize(t.entrySize || t.bytes) + (t.savedPath ? " · " + t.savedPath : "");
  } else {
    info = t.message || "";
  }
  node.sp.textContent = info;
  // 只在状态变化时切换类名与按钮，避免重复插入节点
  if (node.state !== t.state) {
    node.state = t.state;
    node.root.className = "bili-task" + (t.state === "done" ? " done" : (t.state === "error" ? " error" : ""));
    var active = t.state === "downloading" || t.state === "muxing" || t.state === "pending";
    if (active && node.cancel.parentNode !== node.tf) node.tf.appendChild(node.cancel);
    if (!active && node.cancel.parentNode === node.tf) node.tf.removeChild(node.cancel);
    if (t.state === "done" && node.added.parentNode !== node.tf) node.tf.appendChild(node.added);
    if (t.state !== "done" && node.added.parentNode === node.tf) node.tf.removeChild(node.added);
  }
}
function biliRenderTasks() {
  var box = el("bili-tasks");
  var ids = Object.keys(biliState.tasks);
  el("bili-tasks-title").classList.toggle("hidden", ids.length === 0);
  var finished = ids.filter(function (id) {
    var s = biliState.tasks[id].state;
    return s === "done" || s === "error" || s === "cancelled";
  }).length;
  var clearBtn = el("bili-clear");
  if (clearBtn) {
    clearBtn.classList.toggle("hidden", finished === 0);
    clearBtn.textContent = "清除记录" + (finished ? "（" + finished + "）" : "");
  }
  el("lib-bili-btn").classList.toggle("busy", ids.some(function (id) {
    var s = biliState.tasks[id].state;
    return s === "pending" || s === "downloading" || s === "muxing";
  }));
  Object.keys(biliTaskNodes).forEach(function (id) {
    if (biliState.tasks[id]) return;
    var node = biliTaskNodes[id];
    if (node.root.parentNode) node.root.parentNode.removeChild(node.root);
    delete biliTaskNodes[id];
  });
  ids.forEach(function (id) {
    var node = biliTaskNodes[id];
    if (!node) {
      node = biliTaskNodes[id] = biliBuildTaskCard(id);
      box.appendChild(node.root);
    }
    biliUpdateTaskCard(node, biliState.tasks[id]);
  });
}

/** 清掉已完成 / 失败 / 已取消的任务（原生与界面同时清） */
function biliClearFinished() {
  if (NATIVE) bridgeCall("biliClearFinished").catch(function () {});
  Object.keys(biliState.tasks).forEach(function (id) {
    var s = biliState.tasks[id].state;
    if (s !== "done" && s !== "error" && s !== "cancelled") return;
    delete biliState.tasks[id];
    var node = biliTaskNodes[id];
    if (node && node.root.parentNode) node.root.parentNode.removeChild(node.root);
    delete biliTaskNodes[id];
  });
  biliRenderTasks();
}

function biliRefreshTasks() {
  if (!NATIVE) return;
  bridgeCall("biliTasks").then(function (res) {
    var list = (res && res.tasks) || [];
    var live = {};
    list.forEach(function (t) {
      live[t.id] = true;
      var prev = biliState.tasks[t.id];
      biliState.tasks[t.id] = t;
      // 回到前台时才拿到「已完成」的任务（页面暂停期间推送可能没跑到脚本）：
      // 这里补一次入歌单，避免卡片显示已完成但歌没进目标歌单。
      if (t.state === "done" && (!prev || prev.state !== "done")) biliAutoAdd(t);
    });
    // 原生侧已清掉的任务（清除记录 / 进程重启）不再保留卡片
    Object.keys(biliState.tasks).forEach(function (id) {
      if (live[id]) return;
      delete biliState.tasks[id];
      var node = biliTaskNodes[id];
      if (node && node.root.parentNode) node.root.parentNode.removeChild(node.root);
      delete biliTaskNodes[id];
    });
    biliRenderTasks();
  }).catch(function () {});
}

/** 下载完成 → 自动登记并加入「下载放入歌单」（默认「B站下载」，可在下载设置里改） */
function biliAutoAdd(task) {
  if (!task.entryId) return;
  registerHttp(task.entryId, task.entryName || task.fileName || "bilibili_audio", task.entrySize || 0);
  var plObj = biliTargetPl(true);
  if (!plObj) return;
  var exists = plObj.items.some(function (it) { return it.id === task.entryId; });
  if (!exists) {
    // 记下编码：杜比（E-AC-3）封装在 .mp4 里，靠扩展名看不出，需要它来决定播放走解码器
    var it = { id: task.entryId, name: task.entryName || task.fileName, dur: null };
    if (task.codec) it.codec = task.codec;
    if (task.codec) markCodec(task.entryId, task.codec);
    plObj.items.push(it);
    probeDurations([it]);
  } else if (task.codec) {
    markCodec(task.entryId, task.codec);
    plObj.items.forEach(function (x) { if (x.id === task.entryId && !x.codec) x.codec = task.codec; });
  }
  saveLib();
  renderLibrary();
  renderDetail();
  renderQueue();
  showToast("已加入歌单《" + plObj.name + "》");
  if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) {} }
}

/* ---------- 账号 / 扫码登录 ---------- */
/* B 站图床防盗链：外站 Referer 会 403（安卓页面来自 http://127.0.0.1，正好命中），
   因此图片统一走本地代理 /biliimg/<base64url>，由原生带 UA + bilibili Referer 取图 */
function biliImageURL(url) {
  var u = String(url || "");
  if (!u) return "";
  if (u.indexOf("//") === 0) u = "https:" + u;
  if (!NATIVE) return u;
  if (!/^https?:\/\/[^/]*(hdslb\.com|bilibili\.com|bilivideo\.com)/i.test(u)) return u;
  try {
    return "/biliimg/" + btoa(u).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch (e) {
    return u;
  }
}
/** 设置图片：优先本地代理，代理失败时回退直连（例如非图床域名） */
function setBiliImage(img, url) {
  if (!img) return;
  var direct = String(url || "");
  if (!direct) { img.removeAttribute("src"); img.hidden = true; return; }
  if (direct.indexOf("//") === 0) direct = "https:" + direct;
  var proxied = biliImageURL(direct);
  img.hidden = false;
  img.onerror = function () {
    img.onerror = null;
    if (proxied !== direct) img.src = direct;
  };
  img.src = proxied;
}
var BILI_PERSON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8.2" r="3.6"/><path d="M4.8 20c.6-3.6 3.6-5.8 7.2-5.8s6.6 2.2 7.2 5.8"/></svg>';
function renderBiliAccountRow() {
  var ic = el("bili-account-ic");
  if (!ic) return;
  var nameEl = el("bili-account-name");
  var stateEl = el("bili-account-state");
  var a = biliState.account;
  if (a) {
    var face = a.face || "";
    if (face.indexOf("//") === 0) face = "https:" + face;
    if (face) {
      ic.innerHTML = '<img class="face" alt="">';
      setBiliImage(ic.querySelector("img.face"), face);
    } else {
      ic.innerHTML = BILI_PERSON_SVG;
    }
    if (nameEl) nameEl.textContent = a.name || "已登录";
    if (stateEl) stateEl.textContent = (a.vip ? "大会员 · " : "") + "点击管理";
  } else {
    ic.innerHTML = BILI_PERSON_SVG;
    if (nameEl) nameEl.textContent = "B 站账号";
    if (stateEl) stateEl.textContent = "扫码登录 · 解锁 Hi-Res";
  }
}
function biliRefreshAccount() {
  renderBiliAccountRow();
  if (!NATIVE) return;
  bridgeCall("biliAccount").then(function (acc) {
    biliState.account = acc && acc.loggedIn ? acc : null;
    renderBiliAccountRow();
  }).catch(function () {});
}
/* 保存二维码到相册：只有一台手机时，可用 B 站 App「扫一扫 → 相册」选它登录 */
function biliSaveQr() {
  var canvas = el("qr-canvas");
  if (!canvas) return;
  var url = "";
  try { url = canvas.toDataURL("image/png"); } catch (e) { url = ""; }
  if (!url || url.length < 200) { showToast("二维码还没生成，请先等待出码"); return; }
  var name = "bilibili-qr-" + Date.now().toString(36) + ".png";
  if (NATIVE) {
    showToast("正在保存到相册…");
    bridgeCall("saveQrImage", { data: url, name: name }).then(function (r) {
      showToast("已保存到相册：" + ((r && r.path) || "Pictures/Hibiki Player") + "，可在 B 站「扫一扫 → 相册」中选择");
    }).catch(function (err) {
      showToast("保存失败：" + (err.message || err));
    });
    return;
  }
  var a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  showToast("二维码已保存为图片");
}

function drawBiliQr(text) {
  var canvas = el("qr-canvas");
  var ctx = canvas.getContext("2d");
  var size = canvas.width;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  // 该库是经典版：typeNumber 必须为 1~40，逐档尝试直到容量放得下
  var qr = null;
  for (var t = 4; t <= 15 && !qr; t++) {
    try {
      var cand = qrcode(t, "M");
      cand.addData(text);
      cand.make();
      qr = cand;
    } catch (e) {
      qr = null;
    }
  }
  if (!qr) return false;
  var count = qr.getModuleCount();
  var quiet = 3;
  var cell = Math.floor(size / (count + quiet * 2));
  var offset = Math.floor((size - cell * count) / 2);
  ctx.fillStyle = "#101014";
  for (var r = 0; r < count; r++) {
    for (var c = 0; c < count; c++) {
      if (qr.isDark(r, c)) ctx.fillRect(offset + c * cell, offset + r * cell, cell, cell);
    }
  }
  return true;
}

function biliQrStart() {
  if (!NATIVE) { showToast("扫码登录需要安卓版"); return; }
  el("qr-status").textContent = "正在获取二维码…";
  bridgeCall("biliQrStart").then(function (r) {
    if (!r || !r.url) throw new Error("二维码获取失败");
    biliState.qrKey = r.key;
    if (!drawBiliQr(r.url)) throw new Error("二维码绘制失败");
    el("qr-status").textContent = "请用 B 站手机客户端扫码";
    biliQrPoll();
  }).catch(function (err) {
    el("qr-status").textContent = "获取失败：" + (err.message || err);
  });
}

function biliQrPoll() {
  clearTimeout(biliState.qrTimer);
  if (!biliState.qrKey) return;
  biliState.qrTimer = setTimeout(function () {
    if (!biliState.qrKey) return;
    bridgeCall("biliQrPoll", { key: biliState.qrKey }).then(function (r) {
      var state = r && r.state;
      if (state === "ok") {
        biliState.qrKey = null;
        el("qr-status").textContent = "登录成功 ✓（可关闭本面板继续下载）";
        biliRefreshAccount();
        showToast("已登录 B 站" + (r.account && r.account.vip ? "（大会员）" : ""));
        setTimeout(function () { closeSheet(); biliLoadQualities(); }, 900);
        return;
      }
      if (state === "expired") {
        biliState.qrKey = null;
        el("qr-status").textContent = "二维码已失效，点右上角刷新";
        return;
      }
      el("qr-status").textContent = state === "scanned" ? "已扫码，请在手机上确认" : "请用 B 站手机客户端扫码";
      biliQrPoll();
    }).catch(function () {
      biliQrPoll();
    });
  }, 2500);
}

function biliOpenQr() {
  if (biliState.account) {
    openMenu(biliState.account.name || "已登录", [
      { label: "🚪 退出登录", danger: true, fn: function () {
          bridgeCall("biliLogout").then(function () {
            biliState.account = null;
            biliRefreshAccount();
            biliLoadQualities();
            showToast("已退出登录");
          });
        } }
    ]);
    return;
  }
  openSheet("qr-sheet");
  biliQrStart();
}

/* ---------- 外部链接（分享 / 剪贴板） ---------- */
function showBiliBanner(link, source) {
  biliState.banner = link;
  el("bili-banner-text").textContent = (source === "share" ? "收到分享：" : "检测到剪贴板链接：") + link;
  el("bili-banner").classList.remove("hidden");
}
function hideBiliBanner() {
  biliState.banner = null;
  el("bili-banner").classList.add("hidden");
}

window.__hbdBiliTask = function (task) {
  if (!task || !task.id) return;
  var prev = biliState.tasks[task.id];
  biliState.tasks[task.id] = task;
  biliRenderTasks();
  if (task.state === "done" && (!prev || prev.state !== "done")) biliAutoAdd(task);
  if (task.state === "error" && (!prev || prev.state !== "error")) {
    showToast("下载失败：" + (task.message || ""));
  }
};

window.__hbdBiliLink = function (text, source) {
  if (!text) return;
  if (source === "share") {
    // 从 B 站 App 分享进来：直接打开下载页并解析
    if (!el("page-bili").classList.contains("active")) openBili();
    el("bili-input").value = text;
    biliParseText(text);
  } else {
    showBiliBanner(text, source);
    if (el("page-bili").classList.contains("active")) el("bili-banner").classList.remove("hidden");
  }
};

window.__hbdResume = function () {
  biliRefreshTasks();
  if (el("page-bili").classList.contains("active")) biliRefreshAccount();
};

/* ---- 杜比 / DTS 输出模式（原生多声道直出 / 重编码适配设备） ---- */
function setDolbyMode(mode) {
  dolbyMode = mode === "device" ? "device" : "native";
  savePrefs();
  renderDolbyUI();
  showToast(dolbyMode === "native"
    ? "杜比输出：原生多声道直出（保留 5.1 / 7.1 原始布局）"
    : "杜比输出：重编码适配设备（按设备声道布局降混）");
}
function renderDolbyUI() {
  var seg = el("dolby-seg");
  if (seg) {
    seg.querySelectorAll("button").forEach(function (b) {
      b.classList.toggle("on", b.dataset.mode === dolbyMode);
    });
  }
  var cur = el("dolby-cur");
  if (cur) cur.textContent = dolbyMode === "native" ? "原生输出" : "下混输出";
  var note = el("dolby-note");
  if (!note) return;
  var maxCh = audioCtx ? (audioCtx.destination.maxChannelCount || 2) : 0;
  var dev = maxCh ? layoutName(maxCh) + "（" + maxCh + " 声道）" : "播放任一音频后显示";
  note.textContent = "当前输出设备：" + dev + " · 改动自下一首播放起生效";
}

function wireEvents() {
  /* 标签页 */
  document.querySelectorAll("#tabbar .tab").forEach(function (t) {
    t.addEventListener("click", function () {
      if (t.dataset.page === "library") cardsAnimUntil = Date.now() + 700;
      showPage(t.dataset.page);
      if (t.dataset.page === "search") {
        setTimeout(function () { try { el("search-input").focus(); } catch (e) {} }, 120);
        doSearch();
      }
    });
  });

  /* 资料库 */
  el("lib-empty-new").addEventListener("click", promptNewPlaylist);
  el("lib-add-btn").addEventListener("click", promptAddImport);

  /* 下载设置（设置页 + 下载页两处入口） */
  [["set-bili-dir", openBiliDirMenu], ["bili-set-dir", openBiliDirMenu],
   ["set-bili-pl", openBiliPlMenu], ["bili-set-pl", openBiliPlMenu],
   ["set-bili-speed", cycleBiliSpeed], ["bili-set-speed", cycleBiliSpeed]].forEach(function (pair) {
    var node = el(pair[0]);
    if (node) node.addEventListener("click", pair[1]);
  });
  el("sort-mode").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-sort]");
    if (b) setSongSort(b.dataset.sort);
  });
  el("sort-dir").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-dir]");
    if (b) setSortDir(b.dataset.dir);
  });
  el("lib-seg").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-tab]");
    if (!b) return;
    setLibTab(b.dataset.tab);
  });

  /* 专辑 / 艺人详情页 */
  el("group-back").addEventListener("click", closeGroup);
  el("group-play").addEventListener("click", playGroupAll);

  /* 详情页 */
  el("detail-back").addEventListener("click", closeDetail);

  /* B 站下载 */
  el("lib-bili-btn").addEventListener("click", openBili);
  el("bili-back").addEventListener("click", closeBili);
  el("bili-clear").addEventListener("click", biliClearFinished);
  el("bili-account-btn").addEventListener("click", biliOpenQr);
  el("bili-paste").addEventListener("click", biliPaste);
  el("bili-parse").addEventListener("click", function () { biliParseText(el("bili-input").value); });
  el("bili-input").addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") { ev.preventDefault(); biliParseText(el("bili-input").value); }
  });
  el("bili-download").addEventListener("click", biliStartDownload);
  el("bili-banner-go").addEventListener("click", function () { biliParseText(biliState.banner || ""); });
  el("bili-banner-x").addEventListener("click", hideBiliBanner);
  el("qr-refresh").addEventListener("click", biliQrStart);
  el("qr-save").addEventListener("click", biliSaveQr);
  el("qr-close").addEventListener("click", function () { closeSheet(); });
  el("qr-logout").addEventListener("click", function () {
    bridgeCall("biliLogout").then(function () {
      biliState.qrKey = null;
      biliState.account = null;
      biliRefreshAccount();
      closeSheet();
      showToast("已退出登录");
    });
  });
  el("detail-menu-btn").addEventListener("click", function () {
    var p = plById(curPlId);
    if (p) openPlaylistMenu(p, true);       // 歌单内页：多选管理 = 歌曲多选
  });
  el("detail-import").addEventListener("click", doImportFiles);
  el("detail-folder").addEventListener("click", doImportFolder);
  el("detail-empty-import").addEventListener("click", doImportFiles);
  el("detail-play").addEventListener("click", function () {
    var p = plById(curPlId);
    if (p) setPlAndPlay(p.id, 0);
  });
  el("detail-list").addEventListener("pointerdown", onDetailPointerDown);
  window.addEventListener("pointermove", onDetailPointerMove);
  window.addEventListener("pointerup", function () { endDetailDrag(true); });
  window.addEventListener("pointercancel", function () { endDetailDrag(false); });
  window.addEventListener("blur", function () { endDetailDrag(false); });

  /* 多选 */
  el("msel-all").addEventListener("click", function () {
  if (libMselActive) {                                  // 资料库歌曲：全选 / 取消全选
    var rows = el(LIB_MSEL_BOX) ? el(LIB_MSEL_BOX).querySelectorAll("li[data-id]") : [];
    var rowIds = Array.prototype.map.call(rows, function (li) { return li.dataset.id; });
    if (rowIds.length && libMselSet.size === rowIds.length) libMselSet.clear();
    else rowIds.forEach(function (id) { libMselSet.add(id); });
    updateMselUI();
    return;
  }
  if (plMselActive) {                                   // 主页面：全选 / 取消全选歌单
    var cards = el("lib-grid").querySelectorAll(".lib-card[data-pl-id]");
    var ids = Array.prototype.map.call(cards, function (c) { return c.dataset.plId; });
    if (ids.length && plMselSet.size === ids.length) plMselSet.clear();
    else ids.forEach(function (id) { plMselSet.add(id); });
    updateMselUI();
    return;
  }
    var p = plById(curPlId);
    if (!p) return;
    var all = p.items.map(function (it) { return it.id; });
    if (mselSet.size === all.length) mselSet.clear();
    else all.forEach(function (id) { mselSet.add(id); });
    updateMselUI();
  });
  el("msel-del").addEventListener("click", deleteSelected);
  el("msel-cancel").addEventListener("click", function () { exitMultiSelect(); });

  /* 搜索 */
  var searchTimer = 0;
  el("search-input").addEventListener("input", function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(doSearch, 160);
  });
  el("search-cancel").addEventListener("click", function () {
    el("search-input").value = "";
    el("search-input").blur();
    doSearch();
  });

  /* 迷你条 */
  el("mini-art").addEventListener("click", function () { openNP(); });
  el("mini-text").addEventListener("click", function () { openNP(); });
  el("mini-prev").addEventListener("click", function (e) { e.stopPropagation(); if (!micOn && pl.length) playIndex(plIndex - 1); });
  el("mini-play").addEventListener("click", function (e) { e.stopPropagation(); togglePlayPause(); });
  el("mini-next").addEventListener("click", function (e) { e.stopPropagation(); if (!micOn && pl.length) playIndex(plIndex + 1); });
  makeSeekable(el("mini-progress"), seekFromEvent);

  /* 正在播放 */
  el("np-close").addEventListener("click", closeNP);
  el("np-menu").addEventListener("click", function () {
    openMenu("更多", [
      { label: "📃 载入歌词", fn: pickLyrics },
      { label: "🔁 播放模式", sub: plModeName(), fn: cyclePlayMode },
      { label: "🔊 杜比输出", sub: dolbyMode === "native" ? "原生输出" : "下混输出",
        fn: function () { setDolbyMode(dolbyMode === "native" ? "device" : "native"); } },
      { label: vizUIOpen ? "📊 关闭可视化" : "📊 打开可视化", fn: function () {
          vizOn = !vizOn;
          savePrefs();
          el("set-viz").classList.toggle("on", vizOn);
          setNpVizVisible(vizOn);
        } },
      { label: micOn ? "🎤 停止麦克风" : "🎤 麦克风可视化", fn: function () {
          if (micOn) { stopPlayback(); setNpVizVisible(vizOn); applyNowMeta(); showToast("已停止麦克风"); }
          else startMic();
        } },
      { label: "ℹ️ 音频数据", fn: function () {
          if (curKey) openAudioInfo(curKey); else showToast("未在播放");
        } },
      { label: "🗑 从歌单移除", danger: true, fn: function () {
          var p = plById(curPlId);
          var inList = p && curKey && p.items.some(function (it) { return it.id === curKey; });
          if (inList) removeTrackFromPlaylist(p, curKey);
          else showToast("当前歌曲不在该歌单中");
        } },
      { label: "⏹ 停止播放", danger: true, fn: function () { stop(); showToast("已停止"); } }
    ]);
  });
  el("np-play").addEventListener("click", togglePlayPause);
  el("np-prev").addEventListener("click", function () { if (!micOn && pl.length) playIndex(plIndex - 1); });
  el("np-next").addEventListener("click", function () { if (!micOn && pl.length) playIndex(plIndex + 1); });
  el("np-back15").addEventListener("click", function () { seekBy(-15); });
  el("np-fwd15").addEventListener("click", function () { seekBy(15); });
  el("np-lyrics-btn").addEventListener("click", function () { setLyricsUI(!lyricsOn); });
  el("np-viz-btn").addEventListener("click", function () {
    vizOn = !vizOn;
    savePrefs();
    el("set-viz").classList.toggle("on", vizOn);
    setNpVizVisible(vizOn);
  });
  el("np-vol-btn").addEventListener("click", function () {
    el("np-volume-pop").classList.toggle("hidden");
  });
  el("np-mute").addEventListener("click", toggleMute);
  el("np-vol").addEventListener("input", function () { setVolume(parseFloat(el("np-vol").value)); });
  el("np-queue-btn").addEventListener("click", openQueue);
  makeSeekable(el("np-seek"), seekFromEvent);
  document.querySelectorAll("#np-viz-tabs button[data-tab]").forEach(function (b) {
    b.addEventListener("click", function () {
      vizTab = b.dataset.tab;
      savePrefs();
      document.querySelectorAll("#np-viz-tabs button[data-tab]").forEach(function (x) {
        x.classList.toggle("active", x === b);
      });
      if (vizUIOpen) drawVizFrame();
    });
  });
  el("np-viz-mic").addEventListener("click", function () {
    if (micOn) {
      stopPlayback();
      setNpVizVisible(vizOn);
      applyNowMeta();
      showToast("已停止麦克风");
    } else startMic();
  });
  /* NP 下拉关闭手势 */
  var gs = null;
  el("np-body").addEventListener("pointerdown", function (e) {
    if (e.target.closest("button, input, .seek, .np-line, #np-viz-tabs, #np-lyrics")) return;
    gs = { y: e.clientY, dy: 0 };
  });
  window.addEventListener("pointermove", function (e) {
    if (gs) gs.dy = e.clientY - gs.y;
  });
  window.addEventListener("pointerup", function () {
    if (gs && gs.dy > 90) closeNP();
    gs = null;
  });
  /* 歌词滚动暂停跟随 */
  el("np-lyrics").addEventListener("pointerdown", function () {
    lrcFollowPauseUntil = Date.now() + 3000;
  });

  /* 面板 */
  el("scrim").addEventListener("click", closeSheet);
  el("menu-cancel").addEventListener("click", closeSheet);
  el("queue-mode").addEventListener("click", function () { cyclePlayMode(); renderQueue(); });

  /* 弹窗 */
  el("dialog-cancel").addEventListener("click", function () { if (dialogResolve) dialogResolve(null); });
  el("dialog-ok").addEventListener("click", function () {
    // 确认框（无输入框）返回 true；输入框返回内容
    if (dialogResolve) dialogResolve(dialogIsConfirm ? true : el("dialog-input").value.trim());
  });
  el("dialog-input").addEventListener("keydown", function (e) {
    if (e.key === "Enter" && dialogResolve) {
      e.preventDefault();
      dialogResolve(el("dialog-input").value.trim());
    }
  });

  /* 设置 */
  el("set-mode").addEventListener("click", cyclePlayMode);
  el("set-lrc").addEventListener("click", pickLyrics);
  el("set-mic-row").addEventListener("click", function () {
    if (micOn) {
      stopPlayback();
      setNpVizVisible(vizOn);
      applyNowMeta();
      el("set-mic").classList.remove("on");
      showToast("已停止麦克风");
    } else {
      el("set-mic").classList.add("on");
      startMic();
    }
  });
  el("set-bg-row").addEventListener("click", toggleBG);
  el("set-bg-pick").addEventListener("click", function (e) {
    e.stopPropagation();
    pickImage().then(function (ref) {
      if (!ref) return;
      applyBG(ref.indexOf("data:") === 0 ? ref : "id:" + ref);
      applyBGPanel();
      showToast("已更新背景");
    });
  });
  el("set-bg-clear").addEventListener("click", function (e) { e.stopPropagation(); clearBG(); });
  el("set-bg-dim").addEventListener("input", function () {
    applyBGDim(parseFloat(el("set-bg-dim").value));
    el("set-bg-dim-val").textContent = Math.round(bgDim * 100) + "%";
  });
  document.querySelectorAll("#dolby-seg button").forEach(function (b) {
    b.addEventListener("click", function () { setDolbyMode(b.dataset.mode); });
  });
  el("set-viz-row").addEventListener("click", function () {
    vizOn = !vizOn;
    el("set-viz").classList.toggle("on", vizOn);
    savePrefs();
    showToast(vizOn ? "已开启：播放界面显示可视化" : "已关闭可视化");
  });

  /* 浏览器回退文件选择 */
  el("pick-files").addEventListener("change", function () {
    browserImportFiles(this.files).then(afterImport);
    this.value = "";
  });
  el("pick-dir").addEventListener("change", function () {
    browserImportFiles(this.files).then(function (res) {
      afterImport(res);
    });
    this.value = "";
  });
  el("pick-img").addEventListener("change", function () { /* pickImage 内部处理 */ });

  window.addEventListener("resize", function () {
    if (vizUIOpen) drawVizFrame();
  });
  document.addEventListener("contextmenu", function (e) {
    if (e.target.closest("li, .lib-card, .swatch")) e.preventDefault();
  });
}

/* ================= 启动 ================= */
function boot() {
  miniTitleMarq = makeMarquee("mini-title");
  miniArtistMarq = makeMarquee("mini-artist");
  loadPrefs();
  applyTheme(document.body.getAttribute("data-theme") || "green");
  renderSwatches();
  applyBG(bgStore);
  applyBGPanel();
  el("set-viz").classList.toggle("on", vizOn);
  el("set-mic").classList.toggle("on", micOn);
  renderPlayModeUI();
  el("set-bg-dim").value = String(bgDim);
  loadLib();
  loadLrc();
  wireEvents();
  renderDolbyUI();
  renderBiliDownloadSettings();
  renderAbout();
  biliRenderTasks();
  if (NATIVE) { biliRefreshAccount(); biliRefreshTasks(); }
  showPage("library");
  renderLibrary();
  var initFS = NATIVE
    ? bridgeCall("importedAudio").then(function (list) {
        (list || []).forEach(function (en) {
          if (!en || !en.id) return;
          registerHttp(en.id, en.name || "", en.size || 0);
          // 本机导入过的音频都补进资料库：即使当初所在的歌单已被删除，歌依然还在
          libSongAdd({ id: en.id, name: en.name || "", dur: null, codec: en.codec || "" });
        });
        saveLib();
      }).catch(function () {
        showToast("无法读取本机音频库，导入功能可能不可用");
      })
    : idbOpen().then(function (db) {
        idb = db;
        return idbGetAll();
      }).then(function (recs) {
        (recs || []).forEach(function (r) {
          if (!r || !r.id || !r.blob) return;
          registerBlob(r.id, r.name || "", r.size || 0, r.blob);
          libSongAdd({ id: r.id, name: r.name || "", dur: null });     // 浏览器模式同样补进资料库
        });
        saveLib();
      }).catch(function () {
        idbBroken = true;
      });
  initFS.then(function () {
    renderLibrary();
    renderDetail();
    var all = [];
    lib.forEach(function (p) { p.items.forEach(function (it) { all.push(it); }); });
    libSongs.forEach(function (s) { all.push(s); });        // 资料库歌曲（可能已不在任何歌单里）
    if (all.length) probeDurations(all);
    if (curPlId) openDetail(curPlId);
    else showPage("library");
  });
  requestAnimationFrame(function () { tickLoop(); });
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
</script>

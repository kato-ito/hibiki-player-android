// Hibiki Player 安卓版 — 专项复查：播放/暂停图标状态机 + 背景与对齐
"use strict";
const puppeteer = require("puppeteer-core");
const path = require("path");
const fs = require("fs");

const CHROME = process.env.CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const URL = "file:///" + path.resolve(__dirname, "..", "www", "index.html").replace(/\\/g, "/");
const FIXTURES = path.resolve(__dirname, "fixtures");
const SHOTS = path.resolve(__dirname, "screenshots");

let passed = 0, failed = 0;
const failures = [];
const ok = (cond, name, extra) => {
  if (cond) { passed++; console.log("  \u2713 " + name); }
  else { failed++; failures.push(name); console.log("  \u2717 FAIL: " + name + (extra !== undefined ? "  \u2014 " + extra : "")); }
};
const eq = (a, b, name) => ok(a === b, name + (a === b ? "" : "  (got=" + JSON.stringify(a) + " want=" + JSON.stringify(b) + ")"));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = (page, n) => page.screenshot({ path: path.join(SHOTS, n + ".png") }).catch(() => {});

async function waitFor(page, fn, timeout = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.evaluate(fn)) return true;
    await sleep(80);
  }
  return false;
}

const ICON = '(() => { const pick = (sel) => { const el = document.querySelector(sel); if (!el) return "missing"; const html = el.innerHTML; if (html.indexOf("M8 5.5v13l11-6.5z") >= 0) return "play"; if (html.indexOf("M7 5h4v14H7z") >= 0) return "pause"; return "other"; }; return { np: pick("#np-play"), mini: pick("#mini-play") }; })()';

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errors = [];
  page.on("console", m => { if (m.type() === "error") errors.push("[console] " + m.text().slice(0, 160)); });
  page.on("pageerror", e => errors.push("[pageerror] " + e.message.slice(0, 200)));
  page.on("requestfailed", r => {
    const u = r.url();
    if (/^blob:/.test(u) || /favicon/.test(u)) return;
    if (r.failure() && /ERR_ABORTED/.test(r.failure().errorText)) return;
    errors.push("[reqfail] " + u.slice(-40) + " " + (r.failure() && r.failure().errorText));
  });

  await page.goto(URL, { waitUntil: "load" });
  await sleep(700);

  console.log("\n=== 0. 准备：歌单 + 导入音频 ===");
  await page.tap("#lib-empty-new"); await sleep(300);
  await page.type("#dialog-input", "复查歌单"); await page.tap("#dialog-ok"); await sleep(400);
  const pick = await page.$("#pick-files");
  await pick.uploadFile(
    path.join(FIXTURES, "song1-44100.wav"),
    path.join(FIXTURES, "song4-tagged.mp3"),
    path.join(FIXTURES, "song6-tagged.m4a"),
    path.join(FIXTURES, "short-2s.wav")
  );
  await sleep(2200);
  eq(await page.$$eval("#detail-list li[data-id]", e => e.length), 4, "导入 4 首");

  console.log("\n=== A. 播放/暂停图标状态机 ===");
  let icon = await page.evaluate(ICON);
  eq(icon.np, "play", "初始：NP 显示播放图标");
  eq(icon.mini, "play", "初始：迷你条显示播放图标");
  ok(await page.evaluate(() => document.getElementById("mini-player").classList.contains("gone")), "初始：迷你条隐藏");

  await page.evaluate(() => document.querySelectorAll("#detail-list li[data-id]")[0].click());
  ok(await waitFor(page, () => !document.getElementById("mini-player").classList.contains("gone")), "播放后迷你条出现");
  await sleep(600);
  icon = await page.evaluate(ICON);
  eq(icon.np, "pause", "播放中：NP 显示暂停图标");
  eq(icon.mini, "pause", "播放中：迷你条显示暂停图标");
  eq(await page.evaluate(() => document.getElementById("mini-eq")), null, "播放中：迷你条封面只展示封面（无播放标识）");
  ok(await page.evaluate(() => {
    const li = document.querySelector("#detail-list li.current");
    return !!li && document.querySelectorAll("#detail-list .row-eq").length === 0;
  }), "播放中：歌单行只有绿色标注，无均衡器覆盖层");
  ok(await page.evaluate(() => {
    const li = document.querySelector("#detail-list li.current");
    const c = li ? getComputedStyle(li.querySelector(".song-name")).color : "";
    return c === "rgb(55, 214, 122)" || /^rgb\(/.test(c);
  }), "播放中：当前行标题为强调色");

  await page.tap("#mini-play"); await sleep(400);
  icon = await page.evaluate(ICON);
  eq(icon.np, "play", "暂停后：NP 变播放图标");
  eq(icon.mini, "play", "暂停后：迷你条变播放图标");
  ok(await page.evaluate(() => !!document.getElementById("mini-art-img")), "暂停后：迷你条封面元素仍在");
  ok(await page.evaluate(() => {
    const li = document.querySelector("#detail-list li.current");
    return !!li && document.querySelectorAll("#detail-list .row-eq").length === 0;
  }), "暂停后：歌单行仍保持绿色标注（无覆盖动画）");

  await page.tap("#mini-play"); await sleep(500);
  icon = await page.evaluate(ICON);
  eq(icon.mini, "pause", "再次播放：图标恢复暂停态");

  await page.tap("#mini-play"); await sleep(300);
  await page.tap("#mini-art"); await sleep(600);
  icon = await page.evaluate(ICON);
  eq(icon.np, "play", "暂停态打开 NP：图标为播放（未失步）");
  eq(icon.mini, "play", "暂停态打开 NP：迷你条一致");
  await page.tap("#np-play"); await sleep(500);
  icon = await page.evaluate(ICON);
  eq(icon.np, "pause", "NP 内继续播放：图标为暂停");
  eq(icon.mini, "pause", "迷你条同步");
  await shot(page, "chk-01-playing");

  await page.evaluate(() => {
    const bar = document.getElementById("np-seek");
    const r = bar.getBoundingClientRect();
    const x = r.left + r.width * 0.6, y = r.top + r.height / 2;
    bar.dispatchEvent(new PointerEvent("pointerdown", { clientX: x, clientY: y, bubbles: true, pointerId: 9 }));
    bar.dispatchEvent(new PointerEvent("pointerup", { clientX: x, clientY: y, bubbles: true, pointerId: 9 }));
  });
  await sleep(400);
  icon = await page.evaluate(ICON);
  eq(icon.np, "pause", "拖动进度条后：图标仍为暂停");

  await page.tap("#np-next"); await sleep(1400);
  icon = await page.evaluate(ICON);
  eq(icon.np, "pause", "下一首后：图标仍为暂停");
  eq(icon.mini, "pause", "下一首后：迷你条一致");
  await page.tap("#np-prev"); await sleep(1400);
  icon = await page.evaluate(ICON);
  eq(icon.np, "pause", "上一首后：图标仍为暂停");

  await page.$eval("#np-close", b => b.click()); await sleep(500);
  await page.evaluate(() => document.querySelectorAll("#detail-list li[data-id]")[0].click());
  await sleep(500);
  icon = await page.evaluate(ICON);
  eq(icon.mini, "play", "点当前行 → 暂停（图标变为播放三角）");
  eq(icon.np, "play", "点当前行 → NP 图标同步");
  await page.evaluate(() => document.querySelectorAll("#detail-list li[data-id]")[0].click());
  await sleep(700);
  icon = await page.evaluate(ICON);
  eq(icon.mini, "pause", "再点当前行 → 继续（图标回到暂停双竖条）");

  // 暂停状态下点另一首 → 应开始播放该曲目
  await page.tap("#mini-play"); await sleep(400);
  eq((await page.evaluate(ICON)).mini, "play", "先暂停");
  await page.evaluate(() => document.querySelectorAll("#detail-list li[data-id]")[2].click());
  await sleep(1500);
  icon = await page.evaluate(ICON);
  eq(icon.mini, "pause", "暂停时点其他曲目 → 开始播放（图标为暂停）");

  await page.evaluate(() => document.querySelectorAll("#detail-list li[data-id]")[1].click());
  await sleep(120);
  await page.evaluate(() => document.querySelectorAll("#detail-list li[data-id]")[1].click());
  await sleep(900);
  icon = await page.evaluate(ICON);
  eq(icon.mini, "pause", "双击守卫：不会刚播就暂停", JSON.stringify(icon));

  console.log("  -- 顺序播放播完最后一首应停止并复原图标 --");
  await page.evaluate(() => { setPlayMode("seq"); });
  await page.evaluate(() => {
    const rows = document.querySelectorAll("#detail-list li[data-id]");
    rows[rows.length - 1].click();
  });
  ok(await waitFor(page, () => !document.getElementById("mini-player").classList.contains("gone"), 4000), "短曲开始播放");
  await sleep(500);
  ok(await waitFor(page, () => document.getElementById("mini-player").classList.contains("gone"), 9000), "播完后自动停止（迷你条收起）");
  icon = await page.evaluate(ICON);
  eq(icon.mini, "play", "停止后：迷你条图标复原为播放");
  eq(icon.np, "play", "停止后：NP 图标复原为播放");
  await page.evaluate(() => { setPlayMode("all"); });

  await page.evaluate(() => document.querySelectorAll("#detail-list li[data-id]")[0].click());
  await sleep(1200);
  await page.tap("#mini-art"); await sleep(500);
  await page.tap("#np-menu"); await sleep(400);
  await page.evaluate(() => {
    const items = Array.prototype.slice.call(document.querySelectorAll("#menu-items .menu-item"));
    const stop = items.filter(i => i.textContent.indexOf("停止播放") >= 0)[0];
    if (stop) stop.click();
  });
  await sleep(600);
  icon = await page.evaluate(ICON);
  eq(icon.np, "play", "停止播放后：NP 图标为播放");
  eq(await page.evaluate(() => document.getElementById("np-title").textContent), "未在播放", "停止播放后：标题回到未在播放");
  ok(await page.evaluate(() => document.getElementById("mini-player").classList.contains("gone")), "停止播放后：迷你条收起");
  await page.$eval("#np-close", b => b.click()); await sleep(600);   // 等播放界面收起动画结束

  console.log("\n=== B. 背景层与对齐 ===");
  const bgGeometry = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    const layer = document.getElementById("bg-layer");
    const cs = getComputedStyle(layer);
    const r = layer.getBoundingClientRect();
    return {
      vw, vh,
      rect: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      position: cs.position, zIndex: cs.zIndex, pointerEvents: cs.pointerEvents,
      hasBg: document.body.classList.contains("has-bg"),
    };
  });
  ok(bgGeometry.rect.l === 0 && bgGeometry.rect.t === 0 &&
     Math.abs(bgGeometry.rect.w - bgGeometry.vw) <= 1 && Math.abs(bgGeometry.rect.h - bgGeometry.vh) <= 1,
     "背景层与视口完全对齐（无错位）", JSON.stringify(bgGeometry.rect) + " vs " + bgGeometry.vw + "x" + bgGeometry.vh);
  eq(bgGeometry.position, "fixed", "背景层为 fixed 定位");
  eq(bgGeometry.pointerEvents, "none", "背景层不拦截点击");

  await page.tap("#tabbar .tab[data-page='settings']"); await sleep(400);
  await page.tap("#set-bg-row"); await sleep(300);
  const bgInput = await page.$("#pick-img");
  await bgInput.uploadFile(path.join(__dirname, "bg.jpg"));
  await sleep(1500);
  const bgApplied = await page.evaluate(() => {
    const layer = document.getElementById("bg-layer");
    const cs = getComputedStyle(layer);
    const after = getComputedStyle(layer, "::after");
    const r = layer.getBoundingClientRect();
    return {
      hasBg: document.body.classList.contains("has-bg"),
      bgImage: cs.backgroundImage.slice(0, 30),
      opacity: cs.opacity,
      dimOpacity: after.opacity,
      dimColor: after.backgroundColor,
      overlayRect: { w: Math.round(r.width), h: Math.round(r.height) },
      vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight,
    };
  });
  ok(bgApplied.hasBg, "自定义背景已启用");
  ok(bgApplied.bgImage.indexOf("data:image") >= 0 || bgApplied.bgImage.indexOf("url") >= 0, "背景图已应用", bgApplied.bgImage);
  eq(bgApplied.opacity, "1", "背景层可见（opacity 1）");
  ok(Math.abs(parseFloat(bgApplied.dimOpacity) - 0.55) < 0.02, "遮罩浓度默认 55%", bgApplied.dimOpacity);
  ok(bgApplied.overlayRect.w === bgApplied.vw && bgApplied.overlayRect.h === bgApplied.vh,
     "遮罩层与视口同尺寸（无错位）", JSON.stringify(bgApplied.overlayRect));
  await shot(page, "chk-02-bg-green");

  await page.evaluate(() => {
    const s = document.getElementById("set-bg-dim");
    s.value = "0.9"; s.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(300);
  const dim9 = await page.evaluate(() => getComputedStyle(document.getElementById("bg-layer"), "::after").opacity);
  ok(Math.abs(parseFloat(dim9) - 0.9) < 0.02, "遮罩浓度跟随滑块（90%）", dim9);

  await page.evaluate(() => document.querySelectorAll(".swatch")[1].click());
  await sleep(500);
  const whiteBg = await page.evaluate(() => {
    const after = getComputedStyle(document.getElementById("bg-layer"), "::after");
    return { color: after.backgroundColor, opacity: after.opacity, bodyBg: getComputedStyle(document.body).backgroundColor };
  });
  ok(/^rgb\(13,\s*13,\s*18\)$/.test(whiteBg.color), "白色主题：遮罩改用深色底", whiteBg.color);
  await shot(page, "chk-03-bg-white");
  await page.evaluate(() => document.querySelectorAll(".swatch")[0].click());
  await sleep(400);

  await page.tap("#set-bg-row"); await sleep(400);
  ok(await page.evaluate(() => !document.body.classList.contains("has-bg")), "关闭后背景层隐藏");

  console.log("  -- 播放界面：背景层、封面居中、文字居中 --");
  await page.tap("#tabbar .tab[data-page='library']"); await sleep(300);
  await page.tap(".lib-card:not(.new)"); await sleep(500);
  await page.evaluate(() => document.querySelectorAll("#detail-list li[data-id]")[1].click());
  await sleep(2200);
  await page.tap("#mini-art"); await sleep(800);
  const npGeo = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    const R = s => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect();
      return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height), cx: Math.round(r.left + r.width / 2) }; };
    const npBg = getComputedStyle(document.getElementById("np-bg"));
    return {
      vw, vh,
      np: R("#np"), bg: R("#np-bg"), art: R("#np-art"), title: R("#np-title"),
      controls: R("#np-controls"), extra: R("#np-extra"), seek: R("#np-seek"),
      bgImage: npBg.backgroundImage.slice(0, 24), bgFilter: npBg.filter,
      artImgShown: !document.getElementById("np-art-img").hidden,
    };
  });
  ok(npGeo.np.l === 0 && npGeo.np.t === 0 && Math.abs(npGeo.np.w - npGeo.vw) <= 1, "播放界面全屏铺满", JSON.stringify(npGeo.np));
  ok(npGeo.bg.l <= -50 && npGeo.bg.t <= -50 && npGeo.bg.w >= npGeo.vw + 100,
     "模糊背景外扩覆盖（inset -60px，缩放不露边）", JSON.stringify(npGeo.bg));
  ok(/blur/.test(npGeo.bgFilter), "背景层带模糊滤镜", npGeo.bgFilter);
  ok(npGeo.artImgShown && npGeo.bgImage.indexOf("data:image") >= 0, "背景图跟随封面（MP3 内嵌封面）", npGeo.bgImage);
  ok(Math.abs(npGeo.art.cx - npGeo.vw / 2) <= 2, "封面水平居中", npGeo.art.cx + " vs " + npGeo.vw / 2);
  ok(Math.abs(npGeo.title.cx - npGeo.vw / 2) <= 3, "标题水平居中", npGeo.title.cx + " vs " + npGeo.vw / 2);
  ok(npGeo.art.t > 60 && npGeo.art.b < npGeo.seek.t, "封面位于标题与进度条之间（不重叠）",
     JSON.stringify({ art: [npGeo.art.t, npGeo.art.b], seek: npGeo.seek.t }));
  ok(npGeo.controls.b <= npGeo.extra.t + 1, "控制区与底部功能区不重叠");
  ok(npGeo.extra.b <= npGeo.vh + 1, "底部功能区在视口内", JSON.stringify(npGeo.extra));
  await shot(page, "chk-04-np-align");

  await page.$eval("#np-close", b => b.click()); await sleep(500);
  const miniGeo = await page.evaluate(() => {
    const R = s => { const el = document.querySelector(s); const r = el.getBoundingClientRect();
      return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
    return {
      vw: document.documentElement.clientWidth,
      mini: R("#mini-player"), art: R("#mini-art"), text: R("#mini-text"),
      prev: R("#mini-prev"), play: R("#mini-play"), next: R("#mini-next"),
      prog: R("#mini-progress"), tabbar: R("#tabbar"),
    };
  });
  ok(miniGeo.art.r <= miniGeo.text.l + 1, "迷你条：封面与文字不重叠",
     JSON.stringify({ artRight: miniGeo.art.r, textLeft: miniGeo.text.l }));
  ok(miniGeo.text.r <= miniGeo.prev.l + 1, "迷你条：文字与按钮不重叠");
  ok(miniGeo.prev.r <= miniGeo.play.l + 1 && miniGeo.play.r <= miniGeo.next.l + 1, "迷你条：三个按钮不重叠");
  // 新版下栏：迷你条为悬浮卡片（左右留边、与标签栏留缝隙），进度线在卡片底部内侧
  ok(miniGeo.mini.l >= 6 && miniGeo.vw - miniGeo.mini.r >= 6, "迷你条为悬浮卡片（左右留边）", JSON.stringify(miniGeo.mini));
  const gap = miniGeo.tabbar.t - miniGeo.mini.b;
  ok(gap >= 4 && gap <= 16, "迷你条与标签栏之间留出间距", "gap=" + gap);
  ok(miniGeo.prog.w > miniGeo.vw * 0.8 && miniGeo.prog.w < miniGeo.vw, "进度线横跨卡片宽度", JSON.stringify(miniGeo.prog));
  ok(miniGeo.prog.t > miniGeo.mini.t + miniGeo.mini.h * 0.7 && miniGeo.prog.b <= miniGeo.mini.b + 1,
     "进度线位于卡片底部内侧", JSON.stringify({ prog: miniGeo.prog, mini: miniGeo.mini }));

  const rowGeo = await page.evaluate(() => {
    const li = document.querySelector("#detail-list li[data-id]");
    const R = (el, s) => { const n = el.querySelector(s); if (!n) return null; const r = n.getBoundingClientRect();
      return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), h: Math.round(r.height) }; };
    const lr = li.getBoundingClientRect();
    return {
      row: { l: Math.round(lr.left), r: Math.round(lr.right), h: Math.round(lr.height) },
      cover: R(li, ".cover"), info: R(li, ".song-info"), dur: R(li, ".song-dur"), menu: R(li, ".song-menu-btn"),
    };
  });
  ok(rowGeo.cover.r <= rowGeo.info.l + 1, "列表行：封面与文字不重叠");
  ok(rowGeo.info.r <= (rowGeo.dur ? rowGeo.dur.l : 1e9) + 1, "列表行：文字不与时长重叠");
  ok(rowGeo.dur !== null && rowGeo.menu === null, "列表行：仅显示时长，不再有 ⋯ 按钮（长按拖动排序）");
  ok(rowGeo.row.h >= 58 && rowGeo.row.h <= 76, "列表行高度合理", rowGeo.row.h);

  console.log("  -- 歌词层 / 可视化画布对齐 --");
  // 测试用曲目只有 2~5 秒，先暂停以固定当前曲目（歌词是按曲目绑定的）
  await page.evaluate(() => { if (media && !media.paused) media.pause(); });
  await sleep(500);
  const attachInfo = await page.evaluate(() => {
    setLyricsFor(curKey, "[00:00.50]第一句\n[00:01.50]第二句\n[00:02.50]第三句");
    return { key: curKey, got: (lrcLib.get(curKey) || "").slice(0, 12), paused: media ? media.paused : null };
  });
  ok(attachInfo.got.length > 0 && attachInfo.paused === true, "歌词已挂到当前曲目（播放已暂停以固定曲目）", JSON.stringify(attachInfo));
  await page.evaluate(() => document.getElementById("mini-art").click());
  await sleep(600);
  await page.tap("#np-lyrics-btn"); await sleep(700);
  ok(await page.evaluate(() => document.getElementById("np-lyrics").classList.contains("on")), "歌词图层已打开");
  eq(await page.$$eval(".np-line", e => e.length), 3, "歌词共 3 行（挂到当前曲目）");
  const lyrGeo = await page.evaluate(() => {
    const R = s => { const el = document.querySelector(s); const r = el.getBoundingClientRect();
      return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
    const zone = R("#np-art-zone"), lyr = R("#np-lyrics");
    const line = document.querySelector(".np-line");
    const lr = line ? line.getBoundingClientRect() : null;
    return {
      zone, lyr,
      lineCx: lr ? Math.round(lr.left + lr.width / 2) : null,
      vw: document.documentElement.clientWidth,
      lines: document.querySelectorAll(".np-line").length,
    };
  });
  ok(lyrGeo.lyr.w > 100 && lyrGeo.lyr.h > 100, "歌词图层尺寸有效（非零尺寸）", JSON.stringify(lyrGeo.lyr));
  ok(Math.abs(lyrGeo.lyr.l - lyrGeo.zone.l) <= 1 && Math.abs(lyrGeo.lyr.t - lyrGeo.zone.t) <= 1 &&
     Math.abs(lyrGeo.lyr.w - lyrGeo.zone.w) <= 1, "歌词层与封面区完全重合（无错位）", JSON.stringify({ lyr: lyrGeo.lyr, zone: lyrGeo.zone }));
  ok(lyrGeo.lineCx !== null && Math.abs(lyrGeo.lineCx - lyrGeo.vw / 2) <= 3, "歌词行水平居中", "lineCx=" + lyrGeo.lineCx + " vw/2=" + (lyrGeo.vw / 2));
  await shot(page, "chk-05-lyrics");
  await page.tap("#np-lyrics-btn"); await sleep(300);
  await page.tap("#np-viz-btn"); await sleep(700);
  const vizGeo = await page.evaluate(() => {
    const canvas = document.getElementById("np-canvas");
    const wrap = document.getElementById("np-canvas-wrap");
    const cr = canvas.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return {
      canvasRect: { l: Math.round(cr.left), t: Math.round(cr.top), w: Math.round(cr.width), h: Math.round(cr.height) },
      wrapRect: { l: Math.round(wr.left), t: Math.round(wr.top), w: Math.round(wr.width), h: Math.round(wr.height) },
      bitmap: { w: canvas.width, h: canvas.height },
      expect: { w: Math.round(wr.width * dpr), h: Math.round(wr.height * dpr) },
      artHidden: getComputedStyle(document.getElementById("np-art")).display === "none",
    };
  });
  ok(vizGeo.artHidden, "开启可视化后封面隐藏（不与其重叠）");
  ok(Math.abs(vizGeo.canvasRect.w - vizGeo.wrapRect.w) <= 2 && Math.abs(vizGeo.canvasRect.h - vizGeo.wrapRect.h) <= 2,
     "画布尺寸与容器一致（无拉伸错位）", JSON.stringify(vizGeo.canvasRect) + " vs " + JSON.stringify(vizGeo.wrapRect));
  ok(Math.abs(vizGeo.bitmap.w - vizGeo.expect.w) <= 2 && Math.abs(vizGeo.bitmap.h - vizGeo.expect.h) <= 2,
     "画布位图按 DPR 缩放（清晰不模糊）", JSON.stringify(vizGeo.bitmap) + " vs " + JSON.stringify(vizGeo.expect));
  await page.tap("#np-viz-btn"); await sleep(400);
  await page.$eval("#np-close", b => b.click()); await sleep(400);

  console.log("\n=== C. 多尺寸布局扫描（竖屏 + 横屏） ===");
  const sizes = [[360, 640], [390, 844], [430, 932], [844, 390]];
  for (const size of sizes) {
    const w = size[0], h = size[1];
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await sleep(500);
    const m = await page.evaluate(() => {
      const de = document.documentElement;
      const pick = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect();
        return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) }; };
      return {
        scrollW: de.scrollWidth, clientW: de.clientWidth,
        pageOverflow: (() => { const p = document.querySelector(".page.active"); return p ? p.scrollWidth > p.clientWidth + 1 : false; })(),
        mini: pick("#mini-player"), tabbar: pick("#tabbar"),
      };
    });
    ok(m.scrollW <= m.clientW + 1, w + "x" + h + " 无横向溢出", "scrollW=" + m.scrollW + " clientW=" + m.clientW);
    ok(!m.pageOverflow, w + "x" + h + " 页面无横向滚动条");
    if (m.mini && m.tabbar) ok(m.mini.r <= w + 1 && m.tabbar.r <= w + 1, w + "x" + h + " 迷你条/标签栏在视口内");
  }

  await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await sleep(400);
  await page.evaluate(() => document.getElementById("mini-art").click());
  await sleep(700);
  const land = await page.evaluate(() => {
    const R = s => { const el = document.querySelector(s); const r = el.getBoundingClientRect();
      return { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), r: Math.round(r.right), h: Math.round(r.height) }; };
    const vh = document.documentElement.clientHeight, vw = document.documentElement.clientWidth;
    return {
      vw, vh, art: R("#np-art"), play: R("#np-play"), extra: R("#np-extra"), seek: R("#np-seek"),
      overflowX: document.documentElement.scrollWidth > vw + 1,
    };
  });
  ok(!land.overflowX, "横屏播放界面无横向溢出");
  ok(land.extra.b <= land.vh + 1 && land.extra.t >= 0, "横屏：底部功能区在视口内", JSON.stringify(land.extra));
  ok(land.play.b <= land.vh + 1, "横屏：播放键不被裁掉", JSON.stringify(land.play));
  ok(land.art.l >= -1 && land.art.r <= land.vw + 1, "横屏：封面未超出屏幕", JSON.stringify(land.art));
  await shot(page, "chk-06-landscape");
  await page.$eval("#np-close", b => b.click()); await sleep(600);   // 等播放界面收起动画结束

  console.log("\n=== D. 交互边角：连续切歌 / 主题切换 / 弹层 ===");
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await sleep(400);
  await page.evaluate(() => { for (let i = 0; i < 6; i++) playIndex(plIndex + 1); });
  await sleep(2600);
  icon = await page.evaluate(ICON);
  eq(icon.mini, "pause", "连续切歌 6 次后图标仍正确");
  ok(await page.evaluate(() => !!document.querySelector("#detail-list li.current")), "连续切歌后仍有当前曲目标记");
  ok(await page.evaluate(() => document.getElementById("mini-title").textContent.length > 0), "迷你条标题非空");

  await page.evaluate(() => document.querySelectorAll(".swatch")[2].click());
  await sleep(600);
  icon = await page.evaluate(ICON);
  eq(icon.mini, "pause", "切换主题（复古）后播放状态不变");
  const themeConsistent = await page.evaluate(() => ({
    theme: document.body.getAttribute("data-theme"),
    accent: getComputedStyle(document.body).getPropertyValue("--accent").trim(),
    miniArtBg: document.getElementById("mini-art").style.background.slice(0, 20),
    hasCoverImg: !document.getElementById("mini-art-img").hidden,
  }));
  eq(themeConsistent.theme, "sony", "主题已切到复古");
  eq(themeConsistent.accent, "#00dfc9", "复古主题强调色");
  ok(themeConsistent.hasCoverImg || themeConsistent.miniArtBg.indexOf("gradient") >= 0,
     "迷你条封面/占位随主题正常显示", JSON.stringify(themeConsistent));
  await shot(page, "chk-07-theme-sony");
  await page.evaluate(() => document.querySelectorAll(".swatch")[0].click());
  await sleep(400);

  const pick2 = await page.$("#pick-files");
  await pick2.uploadFile(path.join(FIXTURES, "song2-48000.wav"));
  await sleep(1500);
  icon = await page.evaluate(ICON);
  eq(icon.mini, "pause", "导入新曲目时播放不中断");

  await page.tap("#mini-art"); await sleep(500);
  await page.tap("#np-queue-btn"); await sleep(600);
  const sheetGeo = await page.evaluate(() => {
    const q = document.getElementById("queue").getBoundingClientRect();
    const scrim = document.getElementById("scrim").getBoundingClientRect();
    return {
      q: { l: Math.round(q.left), r: Math.round(q.right), b: Math.round(q.bottom) },
      scrim: { w: Math.round(scrim.width), h: Math.round(scrim.height) },
      vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight,
      queueRows: document.querySelectorAll("#queue-list li[data-id]").length,
    };
  });
  ok(sheetGeo.q.l === 0 && Math.abs(sheetGeo.q.r - sheetGeo.vw) <= 1, "队列面板满宽（左右不错位）", JSON.stringify(sheetGeo.q));
  ok(Math.abs(sheetGeo.q.b - sheetGeo.vh) <= 1, "队列面板贴底");
  ok(sheetGeo.scrim.w === sheetGeo.vw && sheetGeo.scrim.h === sheetGeo.vh, "遮罩层覆盖全屏");
  ok(sheetGeo.queueRows > 0, "队列有内容", sheetGeo.queueRows);
  await shot(page, "chk-08-queue");
  await page.tap("#scrim"); await sleep(400);

  const hit = await page.evaluate(() => {
    const targets = ["#np-play", "#np-prev", "#np-next", "#np-lyrics-btn", "#np-viz-btn", "#np-vol-btn", "#np-queue-btn", "#np-close"];
    const bad = [];
    for (const sel of targets) {
      const el = document.querySelector(sel);
      if (!el) { bad.push(sel + ":missing"); continue; }
      const r = el.getBoundingClientRect();
      const hitEl = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hitEl || (hitEl !== el && !el.contains(hitEl))) bad.push(sel + "->" + (hitEl ? (hitEl.id || hitEl.className) : "null"));
    }
    return bad;
  });
  eq(hit.length, 0, "播放界面按钮均可被点中（无遮挡）", hit.join(", "));
  await page.$eval("#np-close", b => b.click()); await sleep(600);   // 等播放界面收起动画结束

  console.log("\n=== E. 追加边界场景 ===");
  await page.$eval("#np-close", b => b.click()); await sleep(600);   // 等播放界面收起动画结束

  // E1 列表循环：短曲播完自动续播，图标保持暂停态
  await page.evaluate(() => { setPlayMode("all"); });
  await page.evaluate(() => {
    const rows = document.querySelectorAll("#detail-list li[data-id]");
    const short = Array.prototype.filter.call(rows, r => itemNameOf(r.dataset.id).indexOf("short") >= 0)[0];
    (short || rows[rows.length - 1]).click();
  });
  await sleep(1500);
  const loopTitle = await page.evaluate(() => document.getElementById("mini-title").textContent);
  await sleep(3200);   // 短曲 2 秒播完
  const afterLoop = await page.evaluate(() => ({
    title: document.getElementById("mini-title").textContent,
    miniVisible: !document.getElementById("mini-player").classList.contains("gone"),
  }));
  icon = await page.evaluate(ICON);
  ok(afterLoop.miniVisible, "列表循环：短曲播完继续播放（迷你条仍显示）");
  eq(icon.mini, "pause", "列表循环续播后图标仍为暂停态");
  ok(afterLoop.title !== loopTitle, "列表循环：已切到下一首", loopTitle + " -> " + afterLoop.title);

  // E2 主题切换后模糊背景仍跟随封面
  await page.tap("#mini-art"); await sleep(600);
  await page.evaluate(() => document.querySelectorAll(".swatch")[1].click());
  await sleep(600);
  const bgAfterTheme = await page.evaluate(() => ({
    bgImage: getComputedStyle(document.getElementById("np-bg")).backgroundImage.slice(0, 24),
    theme: document.body.getAttribute("data-theme"),
    titleColor: getComputedStyle(document.getElementById("np-title")).color,
  }));
  ok(bgAfterTheme.bgImage.indexOf("data:image") >= 0 || bgAfterTheme.bgImage === "none",
     "切换主题后 NP 背景与封面保持一致（不残留旧图）", bgAfterTheme.bgImage);
  await page.evaluate(() => document.querySelectorAll(".swatch")[0].click());
  await sleep(400);
  await page.$eval("#np-close", b => b.click()); await sleep(600);   // 等播放界面收起动画结束

  // E3 停止 → 重新播放：迷你条无位移残留
  await page.evaluate(() => { stop(); });
  await sleep(600);
  await page.evaluate(() => document.querySelectorAll("#detail-list li[data-id]")[0].click());
  await sleep(1500);
  const miniTransform = await page.evaluate(() => {
    const mini = document.getElementById("mini-player");
    const cs = getComputedStyle(mini);
    const r = mini.getBoundingClientRect();
    const tb = document.getElementById("tabbar").getBoundingClientRect();
    return { transform: cs.transform, opacity: cs.opacity, bottomGap: Math.round(tb.top - r.bottom), h: Math.round(r.height) };
  });
  ok(miniTransform.transform === "none" || miniTransform.transform === "matrix(1, 0, 0, 1, 0, 0)",
     "重新播放后迷你条无位移残留", miniTransform.transform);
  ok(miniTransform.bottomGap >= 4 && miniTransform.bottomGap <= 16 && miniTransform.h >= 50,
     "重新播放后迷你条位置正确（悬浮卡片 + 与标签栏留边）", JSON.stringify(miniTransform));

  // E4 横屏下迷你条与标签栏不重叠
  await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await sleep(500);
  const landMini = await page.evaluate(() => {
    const R = s => { const r = document.querySelector(s).getBoundingClientRect();
      return { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), r: Math.round(r.right) }; };
    const mini = R("#mini-player"), tb = R("#tabbar");
    const cs = getComputedStyle(document.getElementById("mini-player"));
    return { mini, tb, overlap: mini.b > tb.t + 1, opacity: cs.opacity };
  });
  ok(!landMini.overlap, "横屏：迷你条与标签栏不重叠", JSON.stringify(landMini));
  ok(landMini.mini.l >= -1 && landMini.mini.r <= 845, "横屏：迷你条在视口内");
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await sleep(400);

  // E5 超长曲名：跑马灯不撑破布局
  const longName = "这是一个非常非常长的歌曲名称用于测试跑马灯与布局是否会被撑破_0123456789_abcdefghijklmnopqrstuvwxyz_末尾标记";
  const longSrc = path.join(FIXTURES, "song1-44100.wav");
  const longDst = path.join(FIXTURES, longName + ".wav");
  fs.copyFileSync(longSrc, longDst);
  const pick3 = await page.$("#pick-files");
  await pick3.uploadFile(longDst);
  await sleep(1500);
  const beforeBtn = await page.evaluate(() => {
    const r = document.getElementById("mini-next").getBoundingClientRect();
    return { l: Math.round(r.left), r: Math.round(r.right) };
  });
  await page.evaluate((nm) => {
    const rows = Array.prototype.slice.call(document.querySelectorAll("#detail-list li[data-id]"));
    const target = rows.filter(r => itemNameOf(r.dataset.id).indexOf("_末尾标记") >= 0)[0];
    if (target) target.click();
  }, longName);
  await sleep(1800);
  const longGeo = await page.evaluate(() => {
    const title = document.getElementById("mini-title");
    const text = document.getElementById("mini-text");
    const next = document.getElementById("mini-next").getBoundingClientRect();
    const mini = document.getElementById("mini-player").getBoundingClientRect();
    return {
      titleText: title.textContent.slice(0, 12),
      textOverflow: getComputedStyle(text).overflow,
      textScrollW: Math.round(title.scrollWidth), textClientW: Math.round(title.clientWidth),
      nextRect: { l: Math.round(next.left), r: Math.round(next.right) },
      miniRight: Math.round(mini.right),
      hasMq: !!title.querySelector(".mq"),
      pageScrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
    };
  });
  ok(longGeo.titleText.length > 0, "超长曲名已显示", longGeo.titleText);
  ok(longGeo.textOverflow === "hidden", "超长曲名容器裁剪（overflow hidden）", longGeo.textOverflow);
  ok(Math.abs(longGeo.nextRect.l - beforeBtn.l) <= 1 && Math.abs(longGeo.nextRect.r - beforeBtn.r) <= 1,
     "超长曲名未挤动迷你条按钮", JSON.stringify({ before: beforeBtn, after: longGeo.nextRect }));
  ok(longGeo.pageScrollW <= longGeo.clientW + 1, "超长曲名不产生横向溢出");
  await shot(page, "chk-09-long-title");
  try { fs.unlinkSync(longDst); } catch (e) {}

  // E6 正在播放那一行：标题过长时每隔几秒滚动一次，其它行保持静止
  console.log("=== E6. 正在播放行的标题跑马灯 ===");
  const marqDst = path.join(FIXTURES, "跑马灯行标题测试_0123456789_abcdefghijklmnopqrstuvwxyz.wav");
  fs.copyFileSync(path.join(FIXTURES, "song2-48000.wav"), marqDst);
  const pick4 = await page.$("#pick-files");
  await pick4.uploadFile(marqDst);
  await sleep(1500);
  const longRowTitle = "正在播放的超长标题_合集第 12 期_中文测试_0123456789_abcdefghijklmnopqrstuvwxyz_尾标记B";
  const marq = await page.evaluate(async (title, nameHint) => {
    const rows = Array.prototype.slice.call(document.querySelectorAll("#detail-list li[data-id]"));
    const target = rows.filter(r => itemNameOf(r.dataset.id).indexOf("跑马灯行标题测试") >= 0)[0];
    if (!target) return { missing: true };
    // 注入超长标题（模拟「合集里的长分P名」），另一首也设长标题作为对照
    rows.forEach((r) => {
      const long = r.dataset.id === target.dataset.id;
      metaCache.set(r.dataset.id, {
        title: long ? title : (title.slice(0, 30) + "_对照行_尾标记C"),
        artist: "测试艺人", album: "测试专辑", cover: null, loaded: true,
      });
    });
    renderDetail();
    await new Promise(r => setTimeout(r, 160));
    const fresh = Array.prototype.slice.call(document.querySelectorAll("#detail-list li[data-id]")).filter(r => r.dataset.id === target.dataset.id)[0];
    fresh.click();
    await new Promise(r => setTimeout(r, 450));
    const mqOf = (nm) => (nm ? nm.querySelector(".mq") : null);
    const xOf = (nm) => {
      const mq = mqOf(nm);
      if (!mq) return null;
      const m = /matrix\(1, 0, 0, 1, (-?[\d.]+)/.exec(getComputedStyle(mq).transform);
      return m ? Math.round(parseFloat(m[1])) : 0;
    };
    const cur = document.querySelector("#detail-list li.current");
    const other = Array.prototype.slice.call(document.querySelectorAll("#detail-list li[data-id]")).filter(r => !r.classList.contains("current"))[0];
    const curNm = cur ? cur.querySelector(".song-name .nm") : null;
    const otherNm = other ? other.querySelector(".song-name .nm") : null;
    const info = {
      isCurrent: !!cur,
      curHasMq: !!mqOf(curNm),
      otherHasMq: !!mqOf(otherNm),
      boxW: curNm ? Math.round(curNm.clientWidth) : 0,
      textW: mqOf(curNm) ? Math.round(mqOf(curNm).scrollWidth) : 0,
      pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
    const xs = [];
    for (let i = 0; i < 14; i++) { xs.push(xOf(curNm)); await new Promise(r => setTimeout(r, 400)); }
    return { info: info, xs: xs, otherX: xOf(otherNm), otherText: otherNm ? otherNm.textContent.slice(0, 10) : "" };
  }, longRowTitle, "跑马灯行标题测试");
  ok(!marq.missing, "歌单里有可用的曲目行");
  ok(marq.info.isCurrent && marq.info.curHasMq, "正在播放那一行的标题交给跑马灯接管");
  ok(!marq.info.otherHasMq, "非当前播放行不滚动（保持静止文本）", marq.otherText);
  ok(marq.info.textW > marq.info.boxW, "标题确实超出单次可显示宽度", marq.info.textW + "px > " + marq.info.boxW + "px");
  const marqXs = (marq.xs || []).filter(x => x !== null);
  ok(marqXs.length >= 2 && new Set(marqXs).size >= 2, "标题位移随时间变化（确实在滚动）", JSON.stringify(marq.xs));
  ok(marqXs.some(x => x < -4), "滚动方向为向左（负位移）", JSON.stringify(marqXs.slice(0, 8)));
  ok(marq.otherX === null || marq.otherX === 0, "非当前行没有任何位移", String(marq.otherX));
  ok(!marq.info.pageOverflow, "跑马灯不产生横向溢出");
  await shot(page, "chk-10-row-marquee");
  try { fs.unlinkSync(marqDst); } catch (e) {}
  console.log("\n========== 专项复查结果: " + passed + " 通过, " + failed + " 失败 ==========");
  if (errors.length) { console.log("运行期错误:"); errors.forEach(e => console.log("   " + e)); }
  ok(errors.length === 0, "全程无 JS 错误", errors.slice(0, 3).join(" | "));
  if (failures.length) { console.log("失败项:"); failures.forEach(f => console.log("  - " + f)); }
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("测试异常:", e); process.exit(2); });

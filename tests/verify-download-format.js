// 本轮四项修复验证：下载保持原始格式并带封面、任务卡不重复动画、下载设置、图标尺寸一致
"use strict";
const puppeteer = require("puppeteer-core");
const path = require("path");
const fs = require("fs");
const { decodePNG, isRed } = require("./pngdec");

const CHROME = process.env.CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const URL = "file:///" + path.resolve(__dirname, "..", "www", "index.html").replace(/\\/g, "/");
const FIXTURES = path.resolve(__dirname, "fixtures");
const SHOTS = path.resolve(__dirname, "screenshots");

let passed = 0, failed = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) { passed++; console.log("  \u2713 " + name); }
  else { failed++; failures.push(name); console.log("  \u2717 FAIL: " + name + (extra !== undefined ? "  \u2014 " + extra : "")); }
}
function eq(a, b, name) { ok(a === b, name + " (got=" + JSON.stringify(a) + " want=" + JSON.stringify(b) + ")"); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function shot(page, n) { try { await page.screenshot({ path: path.join(SHOTS, n + ".png") }); } catch (e) {} }
/** 截图里成片的红色区域（CSS 像素）；只统计列表右半边、且 ≥30×30 的块
 *  —— 左滑露出的删除按钮是 84×62，列表左侧的封面/图标不会误判 */
function bigReds(file, minX) {
  let img;
  try { img = decodePNG(fs.readFileSync(file)); } catch (e) { return [{ err: String(e).slice(0, 60) }]; }
  const comps = [];
  for (let y = 0; y < img.h; y++) {
    let run = null;
    for (let x = 0; x < img.w; x++) {
      if (isRed(img, x, y)) { if (!run) run = { x0: x, x1: x }; else run.x1 = x; }
      else if (run) { comps.push({ y0: y, y1: y, x0: run.x0, x1: run.x1 }); run = null; }
    }
    if (run) comps.push({ y0: y, y1: y, x0: run.x0, x1: run.x1 });
  }
  const merged = [];
  for (const c of comps) {
    const m = merged.find(m => c.y0 <= m.y1 + 1 && !(c.x1 < m.x0 - 2 || c.x0 > m.x1 + 2));
    if (m) { m.y1 = c.y1; m.x0 = Math.min(m.x0, c.x0); m.x1 = Math.max(m.x1, c.x1); }
    else merged.push(Object.assign({}, c));
  }
  const scale = 2;   // deviceScaleFactor
  return merged
    .map(m => ({ x: Math.round(m.x0 / scale), y: Math.round(m.y0 / scale), w: Math.round((m.x1 - m.x0 + 1) / scale), h: Math.round((m.y1 - m.y0 + 1) / scale) }))
    .filter(r => r.w >= 30 && r.h >= 30 && r.x >= (minX === undefined ? 240 : minX));
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errors = [];
  page.on("console", m => { if (m.type() === "error") errors.push("[console.error] " + m.text()); });
  page.on("pageerror", e => errors.push("[pageerror] " + e.message));
  await page.goto(URL, { waitUntil: "load" });
  await sleep(900);

  console.log("=== 1. 下载成品：原始容器 + 前置 ID3v2 封面/标签 ===");
  const fixture = path.join(FIXTURES, "dolby-eac3-id3.eac3");
  ok(fs.existsSync(fixture), "测试夹具存在（E-AC-3 + ID3v2/APIC）", fixture.split(path.sep).pop());
  await page.tap("#lib-empty-new"); await sleep(320);
  await page.type("#dialog-input", "杜比成品");
  await page.tap("#dialog-ok"); await sleep(420);
  const input = await page.$("#pick-files");
  // 同时导入一首普通音频：浏览器模式下特殊格式会被跳过，播放相关的断言需要普通曲目
  await input.uploadFile(fixture, path.join(FIXTURES, "song1-44100.wav"));
  await sleep(2600);
  const meta = await page.evaluate(() => {
    const it = lib[0].items[0];
    const m = metaCache.get(it.id) || {};
    const li = document.querySelector('#detail-list li[data-id="' + CSS.escape(it.id) + '"]');
    return {
      name: it.name,
      title: m.title || "", artist: m.artist || "", album: m.album || "",
      cover: m.cover ? m.cover.slice(0, 22) : "",
      coverLen: m.cover ? m.cover.length : 0,
      tag: li ? ((li.querySelector(".fmt-tag") || {}).textContent || "") : "(行缺失)",
      special: isSpecialTrack(it.id),
    };
  });
  eq(meta.title, "杜比测试曲目", "从裸流 ID3v2 读出标题");
  eq(meta.artist, "测试UP主", "读出 UP 主");
  eq(meta.album, "Bilibili", "读出专辑");
  ok(meta.cover.indexOf("data:image/jpeg") === 0 && meta.coverLen > 100000, "读出内嵌封面（APIC）", meta.coverLen + "B");
  eq(meta.tag, "EAC3", "行内显示 EAC3 标签");
  ok(meta.special, "仍按特殊格式走内置解码器");

  console.log("=== 1b. 乱码标签兜底：回退到文件名 ===");
  const garbled = path.join(FIXTURES, "garbled-tag.eac3");
  const input2 = await page.$("#pick-files");
  await input2.uploadFile(garbled);
  await sleep(2200);
  const gRow = await page.evaluate(() => {
    const it = lib[0].items.filter(x => /garbled-tag/.test(x.name))[0];
    if (!it) return { missing: true };
    const m = metaCache.get(it.id) || {};
    const li = document.querySelector('#detail-list li[data-id="' + CSS.escape(it.id) + '"]');
    return {
      title: m.title || "",
      shown: li ? li.querySelector(".song-name").textContent : "(行缺失)",
      name: it.name,
    };
  });
  eq(gRow.title, "", "乱码标签被判为空（不进入界面）");
  eq(String(gRow.shown).replace("EAC3", ""), "garbled-tag", "行内显示文件名而不是乱码");

  console.log("=== 2. 任务卡：进度更新不再重播入场动画 ===");
  const card = await page.evaluate(async () => {
    biliState.tasks = {};
    for (let i = 1; i <= 3; i++) {
      biliState.tasks["t" + i] = { id: "t" + i, title: "测试" + i, part: "", quality: "192K",
        state: "downloading", bytes: 0, total: 1000, speed: 0, message: "", entryId: "", entrySize: 0, fileName: "" };
    }
    biliRenderTasks();
    const first = document.querySelectorAll(".bili-task");
    const ref = first[0];
    // 模拟 6 次进度推送
    for (let p = 1; p <= 6; p++) {
      biliState.tasks["t1"].bytes = p * 100;
      biliState.tasks["t2"].bytes = p * 50;
      biliRenderTasks();
      await new Promise(r => setTimeout(r, 30));
    }
    await new Promise(r => setTimeout(r, 600));   // 等首次入场动画播完
    const after = document.querySelectorAll(".bili-task");
    const running = (ref.getAnimations ? ref.getAnimations() : []).filter(a => a.playState === "running").length;
    return {
      count: after.length,
      sameNode: after[0] === ref,       // 同一个 DOM 节点（未被重建）
      anim: running > 0 ? "running" : "",
      width: after[0].querySelector(".bar i").style.width,
      title: after[0].querySelector(".tt").textContent,
    };
  });
  eq(card.count, 3, "任务卡数量稳定");
  ok(card.sameNode, "进度更新复用同一个 DOM 节点（不再整栏重建）");
  ok(card.anim === "", "进度更新期间没有正在播放的入场动画（不会每次进度都跳）", card.anim || "(无)");
  eq(card.width, "60%", "进度条宽度随之更新");
  await shot(page, "53-bili-task-cards");

  console.log("=== 3. 下载设置（文件夹 / 速率） ===");
  await page.evaluate(() => showPage("settings"));
  await sleep(400);
  const ui = await page.evaluate(() => ({
    dir: document.getElementById("set-bili-dir-val").textContent,
    speed: document.getElementById("set-bili-speed-val").textContent,
    hasBiliRows: !!document.getElementById("bili-set-dir-val") && !!document.getElementById("bili-set-speed-val"),
  }));
  eq(ui.dir, "默认（音乐/Hibiki Player）", "设置页显示默认下载文件夹");
  eq(ui.speed, "不限", "默认不限速");
  ok(ui.hasBiliRows, "下载页也有同样两项设置");
  await page.tap("#set-bili-speed"); await sleep(350);
  const afterSpeed = await page.evaluate(() => ({
    text: document.getElementById("set-bili-speed-val").textContent,
    biliText: document.getElementById("bili-set-speed-val").textContent,
    persisted: JSON.parse(localStorage.getItem("hpa.prefs.v1") || "{}").biliSpeed,
    value: biliSpeed,
  }));
  eq(afterSpeed.text, "512 KB/s", "点击后切到 512 KB/s（两处同步）");
  eq(afterSpeed.biliText, "512 KB/s", "下载页同步显示");
  eq(afterSpeed.persisted, 512, "速率写入偏好设置");
  // 文件夹菜单（浏览器模式给出提示，不崩溃）
  await page.evaluate(() => showPage("settings"));
  await sleep(200);
  await page.tap("#set-bili-dir"); await sleep(400);
  const dirMenu = await page.$$eval("#menu-items .menu-item", els => els.map(e => e.textContent));
  ok(dirMenu.some(t => /选择文件夹/.test(t)) && dirMenu.some(t => /恢复默认/.test(t)), "下载文件夹菜单含选择/恢复默认", JSON.stringify(dirMenu));
  await page.evaluate(() => document.getElementById("menu-cancel").click());
  await sleep(300);
  await shot(page, "54-download-settings");

  console.log("=== 3b. 收起播放界面动画：封面交接与分层收起 ===");
  await page.evaluate(() => showPage("library"));
  await sleep(300);
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("#detail-list li[data-id]"));
    const normal = rows.filter(r => /wav/.test((r.querySelector(".song-sub") || {}).textContent || "") || !r.querySelector(".fmt-tag"))[0] || rows[0];
    normal.click();
  });
  await sleep(1800);
  await page.evaluate(() => document.getElementById("mini-art").click());
  await sleep(80);
  const entering = await page.evaluate(() => ({
    open: document.getElementById("np").classList.contains("open"),
    inZone: document.getElementById("np-art").parentElement.id,
    flying: document.getElementById("mini-art").classList.contains("flying"),
  }));
  ok(entering.open, "播放界面已打开");
  ok(!entering.flying, "进场不做封面飞行（整屏上滑）");
  eq(entering.inZone, "np-art-zone", "封面始终留在播放界面内");
  await sleep(600);
  await page.evaluate(() => document.getElementById("np-close").click());
  await sleep(120);
  const closing = await page.evaluate(() => ({
    closing: document.getElementById("np").classList.contains("closing"),
    open: document.getElementById("np").classList.contains("open"),
    flying: document.getElementById("mini-art").classList.contains("flying"),
    inLayer: document.getElementById("np-art").parentElement.id,
    tf: getComputedStyle(document.getElementById("np-art")).transform,
  }));
  ok(closing.closing && !closing.open, "收起时播放界面标记 closing 并开始下滑");
  eq(closing.inLayer, "np-art-zone", "封面不脱离播放界面（整屏一起下滑）");
  await sleep(260);
  const mid = await page.evaluate(() => getComputedStyle(document.getElementById("np")).transform);
  ok(mid !== closing.tf, "播放界面在持续缓动（整屏下滑）", String(closing.tf).slice(0, 30) + " -> " + String(mid).slice(0, 30));
  await sleep(700);
  const done = await page.evaluate(() => ({
    inZone: document.getElementById("np-art").parentElement.id,
    closing: document.getElementById("np").classList.contains("closing"),
    layerOn: document.getElementById("np-art-layer").classList.contains("on"),
    open: document.getElementById("np").classList.contains("open"),
  }));
  ok(done.inZone === "np-art-zone" && !done.closing && !done.layerOn && !done.open,
    "动画结束后状态复位", JSON.stringify(done));
  await shot(page, "55-np-close");

  console.log("=== 4. 主页顶部两个图标尺寸一致 ===");
  await page.evaluate(() => showPage("library"));   // 图标在资料库页，先切回去
  await sleep(300);
  const icons = await page.evaluate(() => {
    const svg = (sel) => {
      const s = document.querySelector(sel + " svg");
      const r = s.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    };
    const add = svg("#lib-add-btn"), bili = svg("#lib-bili-btn");
    return { add: add, bili: bili };
  });
  eq(icons.add.w, icons.bili.w, "＋ 与下载图标宽度一致");
  eq(icons.add.h, icons.bili.h, "＋ 与下载图标高度一致");
  eq(icons.add.w, 22, "图标为 22px（与设计一致）");

  console.log("=== 5. 封面显示（background-size: cover）===");
  const coverCss = await page.evaluate(() => {
    const g = (sel) => {
      const n = document.querySelector(sel);
      if (!n) return "(缺失)";
      const cs = getComputedStyle(n);
      return cs.backgroundSize + "|" + cs.backgroundPosition;
    };
    showPage("library");
    return {
      row: g("#detail-list .song-row .cover"),
      lib: g(".lib-card .lib-cover"),
      hero: g("#detail-hero-cover"),
      mini: g("#mini-art"),
    };
  });
  for (const [k, v] of Object.entries(coverCss)) {
    ok(String(v).indexOf("cover") === 0, "封面容器 " + k + " 使用 background-size: cover", v);
  }
  const coverPixels = await page.evaluate(() => {
    const n = document.querySelector("#detail-list .song-row .cover");
    const cs = getComputedStyle(n);
    return cs.backgroundImage.slice(0, 24);
  });
  ok(coverPixels.length > 0, "行封面确实设置了图片（或渐变占位）", coverPixels);

  console.log("=== 6. 左滑删除：一整块红色按钮从右侧滑入（只影响当前歌单）===");
  // 新建第二个歌单并放入同一首歌，验证从 A 删除后 B 仍在
  await page.evaluate(async () => {
    const first = lib[0];
    const file = first.items[0];
    const second = { id: "plX" + Date.now().toString(36), name: "另一个歌单", coverMode: "first", coverImageId: null, items: [{ id: file.id, name: file.name, dur: file.dur }] };
    lib.push(second);
    saveLib();
    openDetail(first.id);
    await new Promise(r => setTimeout(r, 400));
  });
  // 6a. 未滑动：删除块整块藏在行外，列表里不该看到任何红色
  const shotClosed = path.join(SHOTS, "56a-swipe-closed.png");
  await page.screenshot({ path: shotClosed });
  eq(bigReds(shotClosed).length, 0, "未滑动时列表里看不到红色删除块（默认停在行外）", JSON.stringify(bigReds(shotClosed)));

  // 6b. 拖动中：红块必须紧贴行内容右缘（视觉上是一整块），宽度=拖动距离
  const half = await page.evaluate(async () => {
    const li = document.querySelector("#detail-list li[data-id]");
    const r = li.getBoundingClientRect();
    const y = r.top + r.height / 2;
    const ev = (t, x) => li.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 61, pointerType: "touch", isPrimary: true }));
    ev("pointerdown", r.right - 20);
    for (let i = 1; i <= 4; i++) ev("pointermove", r.right - 20 - i * 9);      // 拖 36px
    await new Promise(res => setTimeout(res, 160));
    const inner = li.querySelector(".row-inner").getBoundingClientRect();
    const del = li.querySelector(".row-del").getBoundingClientRect();
    return { rowTop: Math.round(r.top), rowH: Math.round(r.height), innerRight: inner.right, delLeft: del.left, delW: Math.round(del.width) };
  });
  ok(Math.abs(half.innerRight - half.delLeft) < 2, "拖动中红块左缘紧贴行内容右缘（一整块，不是两个分离按钮）", JSON.stringify(half));
  const shotHalf = path.join(SHOTS, "56b-swipe-half.png");
  await page.screenshot({ path: shotHalf });
  const halfReds = bigReds(shotHalf);
  eq(halfReds.length, 1, "拖动中列表里只有一块红色", JSON.stringify(halfReds));
  ok(!!halfReds[0] && Math.abs(halfReds[0].w - 36) <= 4, "红色宽度≈拖动距离（跟着手指从右侧滑入）", JSON.stringify(halfReds[0]));
  ok(!!halfReds[0] && Math.abs(halfReds[0].h - half.rowH) <= 3, "红块高度贴合行高", JSON.stringify(halfReds[0]) + " rowH=" + half.rowH);

  // 6b-4. 过度左划：行内容停住不再左移（不露背景），多出的位移把红块拉长，松手回弹
  const over = await page.evaluate(async () => {
    const li = document.querySelector("#detail-list li[data-id]");
    const r = li.getBoundingClientRect();
    const y = r.top + r.height / 2;
    const ev = (t, x) => li.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 61, pointerType: "touch", isPrimary: true }));
    const snap = () => {
      const inner = li.querySelector(".row-inner");
      const del = li.querySelector(".row-del");
      const ir = inner.getBoundingClientRect(), dr = del.getBoundingClientRect();
      return {
        innerTf: inner.style.transform || "",
        innerLeft: Math.round(ir.left),
        delWidth: Math.round(dr.width), delLeft: Math.round(dr.left), delRight: Math.round(dr.right),
        rowLeft: Math.round(r.left), rowRight: Math.round(r.right),
      };
    };
    for (let i = 5; i <= 10; i++) ev("pointermove", r.right - 20 - i * 12);   // 继续拖到 120px（超过 84px）
    await new Promise(res => setTimeout(res, 120));
    return { stretched: snap() };
  });
  const st = over.stretched;
  ok(/translateX\(-84px\)/.test(st.innerTf), "过度左划时行内容停在 -84px（不再继续左移）", st.innerTf);
  ok(st.innerLeft <= st.rowLeft + 8, "行整体没有继续向左跑（左侧留白不变化）",
     "inner.left=" + st.innerLeft + " row.left=" + st.rowLeft);
  ok(st.delWidth > 84, "红块被拉长（宽度 > 84px）", st.delWidth + "px");
  ok(Math.abs(st.delRight - st.rowRight) <= 1, "红块右缘仍固定在行的右边缘（右侧不露背景）", "delRight=" + st.delRight + " rowRight=" + st.rowRight);
  ok(Math.abs(st.delLeft - (st.rowRight - st.delWidth)) <= 1, "红块左缘跟着手指走", "delLeft=" + st.delLeft + " width=" + st.delWidth);
  const shotOver = path.join(SHOTS, "56c-swipe-stretch.png");
  await page.screenshot({ path: shotOver });
  const overReds = bigReds(shotOver);
  eq(overReds.length, 1, "过度左划时仍然只有一整块红色", JSON.stringify(overReds));
  ok(!!overReds[0] && Math.abs((overReds[0].x + overReds[0].w) - st.rowRight) <= 3,
     "像素上红色右缘也贴着行的右边缘（没有露出黑色背景）", JSON.stringify(overReds[0]) + " rowRight=" + st.rowRight);
  ok(!!overReds[0] && overReds[0].w > 84, "像素上也能看到红块被拉长", JSON.stringify(overReds[0]));
  // 松手回弹：宽度回到 84，行内容仍停在 -84
  const springBack = await page.evaluate(async () => {
    const li = document.querySelector("#detail-list li[data-id]");
    const r = li.getBoundingClientRect();
    const y = r.top + r.height / 2;
    const ev = (t, x) => li.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 61, pointerType: "touch", isPrimary: true }));
    ev("pointerup", r.right - 140);
    await new Promise(res => setTimeout(res, 520));
    const del = li.querySelector(".row-del").getBoundingClientRect();
    const inner = li.querySelector(".row-inner");
    return { delWidth: Math.round(del.width), delRight: Math.round(del.right), rowRight: Math.round(r.right),
      innerTf: inner.style.transform || "", swiped: li.classList.contains("swiped") };
  });
  ok(springBack.swiped && /translateX\(-84px\)/.test(springBack.innerTf), "松手后行内容吸附在 -84px", JSON.stringify(springBack));
  ok(springBack.delWidth === 84, "松手后红块回弹到 84px（拉长被收回）", springBack.delWidth + "px");
  ok(Math.abs(springBack.delRight - springBack.rowRight) <= 1, "回弹后红块右缘仍贴着行的右边缘", JSON.stringify(springBack));

  // 6b-5. 行必须能接管横向手势（默认 auto 会被浏览器判成滚动 → pointercancel → 松手即回弹）
  const touchAction = await page.$eval("#detail-list li.song-row", e => getComputedStyle(e).touchAction);
  eq(touchAction, "pan-y", "歌曲行 touch-action: pan-y（横向手势归 JS，真机才不会一划就回弹）");

  // 6b-3. 轻扫（位移不到一半、但速度快）也应吸附为打开
  const flick = await page.evaluate(async () => {
    const li = document.querySelector("#detail-list li[data-id]");
    const r = li.getBoundingClientRect();
    const y = r.top + r.height / 2;
    const ev = (t, x) => li.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 62, pointerType: "touch", isPrimary: true }));
    // 先拖到 -110 再松手（这一次故意往右快速扫回 → 应回到收起）
    ev("pointerdown", r.right - 20);
    for (let i = 1; i <= 5; i++) { ev("pointermove", r.right - 20 - i * 22); await new Promise(res => setTimeout(res, 16)); }
    ev("pointerup", r.right - 130);
    await new Promise(res => setTimeout(res, 420));
    const openedByDrag = li.classList.contains("swiped");
    // 快速右扫收回
    ev("pointerdown", r.right - 130);
    for (let i = 1; i <= 4; i++) { ev("pointermove", r.right - 130 + i * 24); await new Promise(res => setTimeout(res, 16)); }
    ev("pointerup", r.right - 34);
    await new Promise(res => setTimeout(res, 420));
    const closedByFlickBack = !li.classList.contains("swiped");
    // 短距离快速左扫（仅 40px，不到一半）→ 应按「轻扫」打开
    ev("pointerdown", r.right - 20);
    for (let i = 1; i <= 4; i++) { ev("pointermove", r.right - 20 - i * 10); await new Promise(res => setTimeout(res, 16)); }
    ev("pointerup", r.right - 60);
    await new Promise(res => setTimeout(res, 420));
    return { openedByDrag: openedByDrag, closedByFlickBack: closedByFlickBack, openedByFlick: li.classList.contains("swiped") };
  });
  ok(flick.openedByDrag, "拖动过半 → 打开");
  ok(flick.closedByFlickBack, "打开后快速右扫 → 收起");
  ok(flick.openedByFlick, "短距离快速左扫（40px < 84px 的一半）也能打开 —— iOS 轻扫手感");

  // 6c. 前半段：右扫把上一行收回；后半段：左滑过半 → 松手吸附打开
  const swipeState = await page.evaluate(async () => {
    const li = document.querySelector("#detail-list li[data-id]");
    const r = li.getBoundingClientRect();
    const y = r.top + r.height / 2;
    const ev = (t, x) => li.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 65, pointerType: "touch", isPrimary: true }));
    if (li.classList.contains("swiped")) {                       // 先按用户习惯用右扫收回上一行
      ev("pointerdown", r.right - 120);
      for (let i = 1; i <= 4; i++) { ev("pointermove", r.right - 120 + i * 26); await new Promise(res => setTimeout(res, 16)); }
      ev("pointerup", r.right - 16);
      await new Promise(res => setTimeout(res, 420));
    }
    const closedBefore = !li.classList.contains("swiped");
    // 左滑 96px（> 84 的一半）→ 松手吸附为完全打开
    ev("pointerdown", r.right - 20);
    for (let i = 1; i <= 6; i++) { ev("pointermove", r.right - 20 - i * 16); await new Promise(res => setTimeout(res, 16)); }
    ev("pointerup", r.right - 116);
    // 真实浏览器在 pointerup 之后几乎立刻补发一个 click（按同样时序紧跟其后）：
    // 它不能把刚打开的行又收回去 ——「松手立马回弹」的根因就在这里
    li.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise(res => setTimeout(res, 420));
    return {
      closedBefore: closedBefore,
      opened: li.classList.contains("swiped"),
      stillOpenAfterClick: li.classList.contains("swiped"),
      innerTf: li.querySelector(".row-inner").style.transform,
      delTf: li.querySelector(".row-del") ? (li.querySelector(".row-del").style.transform || "") : "",
      delVisible: !!li.querySelector(".row-del"),
      swipedCount: document.querySelectorAll("#detail-list li.swiped").length,
      rowH: Math.round(r.height),
    };
  });
  ok(swipeState.closedBefore, "右扫后上一行回到收起状态");
  ok(swipeState.stillOpenAfterClick, "滑动结束后浏览器补发的 click 不会让行弹回去");
  ok(swipeState.delVisible, "行内存在红色「删除」按钮");
  ok(swipeState.opened && /translateX\(-84px\)/.test(swipeState.innerTf), "左滑后行内容左移 84px（露出删除）", swipeState.innerTf);
  ok(/translateX\(0px\)/.test(swipeState.delTf), "红块滑入到位 translateX(0)", swipeState.delTf);
  eq(swipeState.swipedCount, 1, "同时只有一行处于打开状态");
  const shotOpen = path.join(SHOTS, "56-swipe-delete.png");
  await page.screenshot({ path: shotOpen });
  const openReds = bigReds(shotOpen);
  eq(openReds.length, 1, "打开后列表里只有一整块红色删除按钮", JSON.stringify(openReds));
  ok(!!openReds[0] && openReds[0].w >= 80 && openReds[0].w <= 90 && Math.abs(openReds[0].h - swipeState.rowH) <= 3,
    "红块 = 84 × 行高（不是每行各露一个小红块）", JSON.stringify(openReds[0]) + " rowH=" + swipeState.rowH);

  // 6c-2. 点击画面其它地方 → 自动回弹（iOS 行为）
  const tapElsewhere = await page.evaluate(async () => {
    const li = document.querySelector("#detail-list li[data-id]");
    const before = li.classList.contains("swiped");
    document.querySelector("#tabbar").dispatchEvent(new PointerEvent("pointerdown",
      { bubbles: true, cancelable: true, pointerId: 63, pointerType: "touch", isPrimary: true }));
    await new Promise(res => setTimeout(res, 450));
    return { before: before, after: li.classList.contains("swiped"), innerTf: li.querySelector(".row-inner").style.transform || "(空)" };
  });
  ok(tapElsewhere.before && !tapElsewhere.after, "点击画面其它部分 → 行自动收起", JSON.stringify(tapElsewhere));
  ok(!/translateX/.test(tapElsewhere.innerTf), "收起后行内容回到原位", tapElsewhere.innerTf);

  // 6d. 再次左滑 → 删除按钮可点击 → 只从当前歌单移除
  const afterDel = await page.evaluate(async () => {
    const li = document.querySelector("#detail-list li[data-id]");
    const r = li.getBoundingClientRect();
    const y = r.top + r.height / 2;
    const ev = (t, x) => li.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 64, pointerType: "touch", isPrimary: true }));
    ev("pointerdown", r.right - 20);
    for (let i = 1; i <= 5; i++) { ev("pointermove", r.right - 20 - i * 20); await new Promise(res => setTimeout(res, 16)); }
    ev("pointerup", r.right - 120);
    await new Promise(res => setTimeout(res, 420));
    const reopened = li.classList.contains("swiped");
    const del = document.querySelector("#detail-list li.swiped .row-del");
    if (del) del.click();
    await new Promise(res => setTimeout(res, 700));
    return {
      reopened: reopened,
      countA: lib[0].items.length,
      countB: lib.find(p => p.name === "另一个歌单").items.length,
      rows: document.querySelectorAll("#detail-list li[data-id]").length,
      leftRed: document.querySelectorAll("#detail-list li.swiped").length,
    };
  });
  ok(afterDel.reopened, "再次左滑可重新打开（删除键按得到）");
  eq(afterDel.rows, afterDel.countA, "列表行数与歌单曲目数一致（已移除）");
  eq(afterDel.countB, 1, "另一个歌单里的同一首歌不受影响");
  eq(afterDel.leftRed, 0, "删除后没有残留的打开行");

  ok(errors.length === 0, "全程无 JS 错误", errors.slice(0, 3).join(" | "));
  console.log("");
  console.log("通过 " + passed + " / " + (passed + failed));
  if (failed) console.log("失败：" + failures.join("; "));
  await browser.close();
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });

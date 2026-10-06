// Hibiki Player 安卓版 — 无头浏览器端到端验证
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
function ok(cond, name, extra) {
  if (cond) { passed++; console.log("  \u2713 " + name); }
  else { failed++; failures.push(name); console.log("  \u2717 FAIL: " + name + (extra !== undefined ? " \u2014 " + extra : "")); }
}
function eq(a, b, name) { ok(a === b, name + " (got=" + JSON.stringify(a) + " want=" + JSON.stringify(b) + ")"); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function shot(page, name) {
  try { await page.screenshot({ path: path.join(SHOTS, name + ".png") }); } catch (e) {}
}

async function launch() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: [
      "--no-sandbox", "--disable-gpu",
      "--autoplay-policy=no-user-gesture-required",
      "--mute-audio",
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  return { browser, page };
}

// 把元素滚到视口中央再点击：避免被固定在底部的迷你播放条 / 标签栏遮挡
async function tapCentered(page, sel) {
  await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "center" });
  }, sel);
  await sleep(200);
  await page.tap(sel);
}

// 在页面里注入指针事件序列（用于拖动 / 长按）
async function pointerDrag(page, sel, fromFrac, toFrac, holdMs) {
  await page.evaluate((sel, fromFrac, toFrac, holdMs) => {
    const el = document.querySelector(sel);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width * 0.5;
    const y0 = r.top + r.height * fromFrac;
    const y1 = r.top + r.height * toFrac;
    const fire = (type, cx, cy) =>
      el.dispatchEvent(new PointerEvent(type, { clientX: cx, clientY: cy, bubbles: true, cancelable: true, pointerId: 7, pointerType: "touch", isPrimary: true }));
    fire("pointerdown", x, y0);
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      window.__dragStep = () => fire("pointermove", x, y0 + (y1 - y0) * t);
      setTimeout(() => { try { window.__dragStep(); } catch (e) {} }, holdMs + (40 * i));
    }
    setTimeout(() => fire("pointerup", x, y1), holdMs + 40 * (steps + 1));
  }, sel, fromFrac, toFrac, holdMs);
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { browser, page } = await launch();
  const errors = [];
  page.on("console", m => { if (m.type() === "error") errors.push("[console.error] " + m.text()); });
  page.on("pageerror", e => errors.push("[pageerror] " + e.message));
  page.on("requestfailed", r => {
    const u = r.url();
    // 切歌时旧媒体请求被主动中断属于正常行为（blob: ERR_ABORTED），不视为错误
    if (/favicon/.test(u)) return;
    if (/^blob:/.test(u) && r.failure() && r.failure().errorText === "net::ERR_ABORTED") return;
    errors.push("[requestfailed] " + u + " " + (r.failure() && r.failure().errorText));
  });

  console.log("=== 1. 启动 ===");
  await page.goto(URL, { waitUntil: "load" });
  await sleep(900);
  eq(await page.title(), "Hibiki Player", "页面标题");
  eq(await page.$$eval("#tabbar .tab", els => els.length), 3, "底部 3 个标签");
  ok(errors.length === 0, "启动无 JS 错误", errors.join(" | "));
  await shot(page, "01-boot");

  console.log("=== 2. 新建歌单（自动进入详情页） ===");
  await page.tap("#lib-empty-new");
  await sleep(350);
  await page.type("#dialog-input", "我的收藏");
  await page.tap("#dialog-ok");
  await sleep(400);
  eq(await page.$eval("#detail-title", el => el.textContent), "我的收藏", "进入新歌单详情");
  ok(await page.$eval("#detail-empty", el => !el.classList.contains("hidden")), "空歌单引导可见");
  await shot(page, "02-new-playlist");

  console.log("=== 3. 导入音频 ===");
  const input = await page.$("#pick-files");
  await input.uploadFile(
    path.join(FIXTURES, "song1-44100.wav"),
    path.join(FIXTURES, "song2-48000.wav"),
    path.join(FIXTURES, "song3-96000.wav"),
    path.join(FIXTURES, "song4-tagged.mp3"),
    path.join(FIXTURES, "song5-tagged.flac"),
    path.join(FIXTURES, "song6-tagged.m4a")
  );
  await sleep(2500);
  const rows = await page.$$eval("#detail-list li[data-id]", els => els.length);
  eq(rows, 6, "导入 6 首");
  const durs = await page.$$eval("#detail-list .song-dur", els => els.map(e => e.textContent).filter(Boolean).length);
  ok(durs >= 6, "6 首时长探测完成", "durs=" + durs);
  const meta = await page.$eval("#detail-meta", el => el.textContent);
  console.log("    歌单元信息:", meta);
  await shot(page, "03-imported");

  console.log("=== 4. 播放与迷你条 ===");
  await page.tap("#detail-list li[data-id]");
  await sleep(2200);
  ok(await page.evaluate(() => !document.getElementById("mini-player").classList.contains("gone")), "迷你条出现");
  const w1 = await page.$eval("#mini-progress-fill", el => el.style.width);
  await sleep(800);
  const w2 = await page.$eval("#mini-progress-fill", el => el.style.width);
  ok(parseFloat(w2) > parseFloat(w1), "迷你条进度前进", w1 + " -> " + w2);
  await shot(page, "04-mini-playing");

  console.log("=== 5. 正在播放界面 ===");
  await page.tap("#mini-art");
  await sleep(700);
  ok(await page.$eval("#np", el => el.classList.contains("open")), "播放界面打开");
  const npTitle = await page.$eval("#np-title", el => el.textContent);
  ok(npTitle.length > 0 && npTitle !== "未在播放", "标题显示", npTitle);
  await shot(page, "05-now-playing");

  console.log("=== 6. 封面（带标签文件） ===");
  // 跳到 MP3（第 4 首，有内嵌封面）
  await page.evaluate(() => { document.querySelectorAll("#detail-list li[data-id]")[3].click(); });
  await sleep(2000);
  const artShown = await page.$eval("#np-art-img", el => !el.hidden && el.src.indexOf("data:image") === 0);
  ok(artShown, "MP3 内嵌封面提取显示");
  const npBg = await page.$eval("#np-bg", el => el.style.backgroundImage);
  ok(npBg && npBg.indexOf("data:image") === 5 || (npBg && npBg.indexOf("url") >= 0), "模糊背景跟随封面", npBg.slice(0, 60));
  const artTitle = await page.$eval("#np-title", el => el.textContent);
  ok(/星空之下/.test(artTitle), "ID3 标题读取", artTitle);
  await shot(page, "06-cover");

  console.log("=== 7. 控制：暂停/继续/切歌 ===");
  await page.tap("#np-play"); await sleep(300);
  ok(await page.evaluate(() => document.getElementById("np-play").innerHTML.indexOf("M8 5.5") >= 0), "暂停图标");
  await page.tap("#np-play"); await sleep(500);
  const tPrev = await page.$eval("#np-title", el => el.textContent);
  await page.tap("#np-next"); await sleep(1400);
  const tNext = await page.$eval("#np-title", el => el.textContent);
  ok(tNext !== tPrev, "下一首", tNext);
  await page.tap("#np-prev"); await sleep(1400);
  ok((await page.$eval("#np-title", el => el.textContent)) === tPrev, "上一首");
  await page.tap("#np-back15"); await sleep(300);
  ok(await page.evaluate(() => { const m = document.querySelector("#np-cur"); return /^0:/.test(m.textContent); }), "快退 15 秒");
  await page.tap("#np-fwd15"); await sleep(300);
  const curTxt = await page.$eval("#np-cur", el => el.textContent);
  console.log("    快进后时间:", curTxt);
  await shot(page, "07-controls");

  console.log("=== 8. 拖动进度条 ===");
  await page.evaluate(() => {
    const bar = document.getElementById("np-seek");
    const r = bar.getBoundingClientRect();
    const x = r.left + r.width * 0.5, y = r.top + r.height / 2;
    bar.dispatchEvent(new PointerEvent("pointerdown", { clientX: x, clientY: y, bubbles: true, pointerId: 2 }));
    bar.dispatchEvent(new PointerEvent("pointerup", { clientX: x, clientY: y, bubbles: true, pointerId: 2 }));
  });
  await sleep(400);
  const fill = await page.$eval("#np-seek-fill", el => parseFloat(el.style.width));
  ok(fill > 40 && fill < 60, "跳转到 ~50%", "fill=" + fill);
  await page.$eval("#np-close", b => b.click());
  await sleep(500);
  ok(await page.evaluate(() => !document.getElementById("np").classList.contains("open")), "收起播放界面");

  console.log("=== 9. 音量 ===");
  await page.evaluate(() => document.getElementById("mini-art").click());
  await sleep(500);
  await page.tap("#np-vol-btn");
  await sleep(300);
  await page.evaluate(() => {
    const s = document.getElementById("np-vol");
    s.value = "0.42";
    s.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(200);
  eq(await page.$eval("#np-vol-label", el => el.textContent), "42%", "音量 42%");
  await page.tap("#np-mute");
  eq(await page.$eval("#np-vol-label", el => el.textContent), "0%", "静音 0%");
  await page.tap("#np-mute");
  eq(await page.$eval("#np-vol-label", el => el.textContent), "42%", "取消静音");
  await page.$eval("#np-close", b => b.click());
  await sleep(300);

  console.log("=== 10. 播放队列 ===");
  await page.evaluate(() => document.getElementById("mini-art").click());
  await sleep(500);
  await page.tap("#np-queue-btn");
  await sleep(500);
  ok(await page.$eval("#queue", el => el.classList.contains("open")), "队列面板打开");
  eq(await page.$$eval("#queue-list li[data-id]", els => els.length), 6, "队列 6 首");
  const qCur = await page.$eval("#queue-list .song-row.current .song-name", el => el.textContent);
  ok(qCur.length > 0, "当前曲目高亮", qCur);
  await page.evaluate(() => document.querySelectorAll("#queue-list li[data-id]")[4].click());
  await sleep(1500);
  const qTitle = await page.$eval("#np-title", el => el.textContent);
  console.log("    队列点选后:", qTitle);
  await shot(page, "10-queue");
  await page.tap("#scrim"); await sleep(300);
  await page.$eval("#np-close", b => b.click()); await sleep(600);   // 等播放界面收起动画结束

  console.log("=== 11. 播放模式（短曲目验证循环） ===");
  // 追加一首 2 秒短曲
  const input2 = await page.$("#pick-files");
  await input2.uploadFile(path.join(FIXTURES, "short-2s.wav"));
  await sleep(1200);
  // 切到最后一首（短曲），设为单曲循环，等它自然结束 → 应该重播同一首
  await page.evaluate(() => document.querySelectorAll("#detail-list li[data-id]")[6].click());
  await sleep(800);
  await page.evaluate(() => { /* 播放模式切到单曲循环 */ });
  await page.evaluate(() => document.getElementById("set-mode").click()); // all -> one
  await sleep(200);
  eq(await page.$eval("#set-mode-val", el => el.textContent), "单曲循环", "模式切换为单曲循环");
  const sTitle = await page.$eval("#np-title", el => el.textContent);
  await sleep(3500); // 2 秒曲目自然结束
  const sTitle2 = await page.$eval("#np-title", el => el.textContent);
  ok(sTitle === sTitle2, "单曲循环生效", sTitle);
  const playing2 = await page.evaluate(() => !document.getElementById("mini-player").classList.contains("gone"));
  ok(playing2, "循环后仍在播放");
  // 切回列表循环
  await page.evaluate(() => document.getElementById("set-mode").click());
  await sleep(200);
  eq(await page.$eval("#set-mode-val", el => el.textContent), "顺序播放", "模式切换为顺序播放");
  await page.evaluate(() => document.getElementById("set-mode").click());
  await sleep(200);
  eq(await page.$eval("#set-mode-val", el => el.textContent), "随机播放", "模式切换为随机播放");
  await page.evaluate(() => document.getElementById("set-mode").click());
  await sleep(200);
  eq(await page.$eval("#set-mode-val", el => el.textContent), "列表循环", "模式回到列表循环");
  await shot(page, "11-modes");

  console.log("=== 12. 长按拖拽排序 ===");
  const before = await page.$$eval("#detail-list li[data-id]", els => els.map(e => e.dataset.id));
  const first = before[0];
  await pointerDrag(page, "#detail-list li[data-id]", 0.5, 2.7, 400); // 按住第 1 行拖到第 3 行之后
  await sleep(1400);
  const after = await page.$$eval("#detail-list li[data-id]", els => els.map(e => e.dataset.id));
  ok(after[0] === before[1] && after[1] === before[2] && after[2] === first, "拖拽换位", before.slice(0, 3).join(",") + " -> " + after.slice(0, 3).join(","));
  await shot(page, "12-reordered");

  console.log("=== 13. 多选管理（歌单菜单入口） ===");
  eq(await page.$$eval("#detail-list .song-menu-btn", els => els.length), 0, "歌单行不再有 ⋯ 按钮");
  // 队列面板点歌后会保持打开，先收起，避免表头按钮被遮罩挡住
  await page.evaluate(() => { if (document.getElementById("scrim").classList.contains("on")) closeSheet(); });
  await sleep(400);
  console.log("    前置状态:", JSON.stringify(await page.evaluate(() => ({
    page: document.getElementById("page-detail").classList.contains("active"),
    scrim: document.getElementById("scrim").classList.contains("on"),
    npOpen: document.getElementById("np").classList.contains("open"),
    rows: document.querySelectorAll("#detail-list li[data-id]").length,
  }))));
  await page.tap("#detail-menu-btn");
  await sleep(400);
  ok(await page.$eval("#menu", el => el.classList.contains("open")), "歌单菜单打开");
  await shot(page, "13-playlist-menu");
  await page.evaluate(() => {
    const items = Array.prototype.slice.call(document.querySelectorAll("#menu-items .menu-item"));
    const m = items.filter(i => /多选管理/.test(i.textContent))[0];
    if (m) m.click();
  });
  await sleep(400);
  ok(await page.$eval("#msel-bar", el => el.classList.contains("on")), "多选条出现");
  // 勾选第 1、2、3 行 → 共 3 首
  await page.evaluate(() => document.querySelectorAll("#detail-list li[data-id]")[0].click());
  await page.evaluate(() => document.querySelectorAll("#detail-list li[data-id]")[1].click());
  await page.evaluate(() => document.querySelectorAll("#detail-list li[data-id]")[2].click());
  await sleep(300);
  ok(await page.$eval("#msel-del", el => !el.disabled && /3/.test(el.textContent)), "选中 3 首",
    await page.$eval("#msel-del", el => el.textContent + " disabled=" + el.disabled));
  const rowsBeforeMsel = await page.$$eval("#detail-list li[data-id]", els => els.length);
  await page.tap("#msel-del");
  await sleep(500);
  eq(await page.$$eval("#detail-list li[data-id]", els => els.length), rowsBeforeMsel - 3, "多选删除 3 首");
  ok(await page.evaluate(() => !document.getElementById("msel-bar").classList.contains("on")), "多选条收起");
  await shot(page, "14-multiselect");

  console.log("=== 14. 歌单菜单 / 删除歌单 ===");
  await page.tap("#detail-menu-btn");
  await sleep(400);
  ok(await page.$eval("#menu", el => el.classList.contains("open")), "歌单菜单打开");
  await shot(page, "15-playlist-menu");
  await page.evaluate(() => {
    const items = Array.prototype.slice.call(document.querySelectorAll("#menu-items .menu-item"));
    const m = items.filter(i => /删除歌单/.test(i.textContent))[0];
    if (m) m.click();
  });
  await sleep(400);
  ok(await page.$eval("#dialog", el => el.classList.contains("on")), "删除确认弹窗");
  await shot(page, "16-delete-confirm");
  await page.tap("#dialog-cancel");
  await sleep(300);

  console.log("=== 14b. 主页面：长按歌单封面 → 多选管理 = 歌单多选 ===");
  // 用两个专用歌单做多选测试，避免删掉后面用例还要用的歌单
  const plReady = await page.evaluate(async () => {
    closeSheet();
    showPage("library"); setLibTab("lists");
    await new Promise(r => setTimeout(r, 250));
    const keepId = curPlId;
    const mk = (id, name) => ({ id: id, name: name, coverMode: "first", coverImageId: null, items: [] });
    const a = "plA" + Date.now().toString(36), b = "plB" + Date.now().toString(36);
    lib.push(mk(a, "多选测试A"));
    lib.push(mk(b, "多选测试B"));
    saveLib(); renderLibrary();
    await new Promise(r => setTimeout(r, 300));
    const card = document.querySelector('#lib-grid .lib-card[data-pl-id="' + a + '"]');
    const r = card.getBoundingClientRect();
    return { keepId: keepId, a: a, b: b, cards: document.querySelectorAll("#lib-grid .lib-card[data-pl-id]").length, x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  ok(plReady.cards >= 3, "主页面有多个歌单卡片", JSON.stringify({ cards: plReady.cards }));
  await page.mouse.move(plReady.x, plReady.y);
  await page.mouse.down();
  await sleep(700);
  await page.mouse.up();
  await sleep(450);
  ok(await page.$eval("#menu", el => el.classList.contains("open")), "长按歌单封面打开歌单设置");
  const plMenuLabel = await page.evaluate(() => {
    const items = Array.prototype.slice.call(document.querySelectorAll("#menu-items .menu-item"));
    const m = items.filter(i => /多选管理/.test(i.textContent))[0];
    return m ? m.textContent : "";
  });
  ok(/多选管理（歌单）/.test(plMenuLabel), "主页面菜单里的多选管理是「歌单」多选", plMenuLabel);
  await page.evaluate(() => {
    const items = Array.prototype.slice.call(document.querySelectorAll("#menu-items .menu-item"));
    const m = items.filter(i => /多选管理/.test(i.textContent))[0];
    if (m) m.click();
  });
  await sleep(500);
  const plMs = await page.evaluate(() => ({
    bar: document.getElementById("msel-bar").classList.contains("on"),
    page: document.getElementById("page-library").classList.contains("active"),
    checks: document.querySelectorAll("#lib-grid.msel .lib-card .check").length,
    sel: document.querySelectorAll("#lib-grid .lib-card.sel").length,
    delText: document.getElementById("msel-del").textContent,
    newCard: !!document.querySelector("#lib-grid .lib-card.new"),
  }));
  ok(plMs.bar && plMs.page, "歌单多选条出现，并回到主页面", JSON.stringify(plMs));
  ok(plMs.checks >= 3, "歌单卡片显示勾选圈（是歌单多选，不是歌曲多选）", JSON.stringify(plMs));
  eq(plMs.sel, 1, "长按的那个歌单已预先勾选");
  ok(!plMs.newCard, "多选时隐藏「新建歌单」卡片");
  await page.evaluate((b) => document.querySelector('#lib-grid .lib-card[data-pl-id="' + b + '"]').click(), plReady.b);
  await sleep(300);
  const plMs2 = await page.evaluate(() => ({
    sel: document.querySelectorAll("#lib-grid .lib-card.sel").length,
    detail: document.getElementById("page-detail").classList.contains("active"),
    delText: document.getElementById("msel-del").textContent,
  }));
  eq(plMs2.sel, 2, "点击卡片是勾选，而不是进入歌单");
  ok(!plMs2.detail, "多选中不会打开歌单内页");
  ok(/2/.test(plMs2.delText), "删除按钮显示已选 2 个", plMs2.delText);
  await shot(page, "57-pl-multiselect");

  console.log("=== 14c. 批量删除歌单（确认后真的删除） ===");
  const plBefore = await page.evaluate(() => ({ lib: lib.length, cards: document.querySelectorAll("#lib-grid .lib-card[data-pl-id]").length }));
  await page.tap("#msel-del");
  await sleep(450);
  ok(await page.$eval("#dialog", el => el.classList.contains("on")), "批量删除弹窗出现");
  ok(await page.$eval("#dialog-note", el => /保留/.test(el.textContent)), "弹窗显示说明文案（歌曲会保留）",
    await page.$eval("#dialog-note", el => el.textContent));
  await page.tap("#dialog-ok");
  await sleep(800);
  const plAfter = await page.evaluate((ids) => ({
    lib: lib.length,
    cards: document.querySelectorAll("#lib-grid .lib-card[data-pl-id]").length,
    bar: document.getElementById("msel-bar").classList.contains("on"),
    goneA: !plById(ids.a), goneB: !plById(ids.b), keep: !!plById(ids.keepId),
  }), plReady);
  eq(plAfter.lib, plBefore.lib - 2, "确认后真的删除了 2 个歌单");
  eq(plAfter.cards, plBefore.cards - 2, "卡片同步减少");
  ok(plAfter.goneA && plAfter.goneB, "两个被选中的歌单都已删除");
  ok(plAfter.keep, "没被选中的歌单不受影响");
  ok(!plAfter.bar, "多选条自动收起");

  console.log("=== 14d. 歌单内页删除歌单（单删）===");
  const pd = await page.evaluate(async () => {
    const id = "plD" + Date.now().toString(36);
    lib.push({ id: id, name: "内页删除测试", coverMode: "first", coverImageId: null, items: [] });
    saveLib(); renderLibrary();
    await new Promise(r => setTimeout(r, 250));
    const keepId = curPlId;
    const c = document.querySelector('#lib-grid .lib-card[data-pl-id="' + id + '"]');
    c.click();
    await new Promise(r => setTimeout(r, 400));
    const n = lib.length;
    document.getElementById("detail-menu-btn").click();
    await new Promise(r => setTimeout(r, 350));
    const items = Array.prototype.slice.call(document.querySelectorAll("#menu-items .menu-item"));
    const multLabel = (items.filter(i => /多选管理/.test(i.textContent))[0] || { textContent: "" }).textContent;
    const del = items.filter(i => /删除歌单/.test(i.textContent))[0];
    if (del) del.click();
    await new Promise(r => setTimeout(r, 400));
    return { id: id, n: n, keepId: keepId, multLabel: multLabel, dialog: document.getElementById("dialog").classList.contains("on") };
  });
  ok(/多选管理（歌曲）/.test(pd.multLabel), "歌单内页菜单仍是「歌曲」多选（未被改动）", pd.multLabel);
  ok(pd.dialog, "内页删除歌单同样弹确认框");
  await page.tap("#dialog-ok");
  await sleep(800);
  const pdAfter = await page.evaluate((d) => ({ n: lib.length, gone: !plById(d.id), keep: !!plById(d.keepId) }), pd);
  eq(pdAfter.n, pd.n - 1, "内页确认后歌单被删除");
  ok(pdAfter.gone, "被删的歌单已不在资料库里");
  ok(pdAfter.keep, "其它歌单不受影响");
  // 回到一个有歌的歌单，后面的用例还要用
  await page.evaluate((id) => { const c = document.querySelector('#lib-grid .lib-card[data-pl-id="' + id + '"]'); if (c) c.click(); }, plReady.keepId);
  await sleep(400);
  console.log("=== 15. 皮肤切换 ===");
  await page.tap("#tabbar .tab[data-page='settings']");
  await sleep(400);
  await page.evaluate(() => document.querySelectorAll(".swatch")[1].click()); // 白色
  await sleep(300);
  eq(await page.evaluate(() => document.body.getAttribute("data-theme")), "white", "白色主题");
  await shot(page, "17-theme-white");
  await page.evaluate(() => document.querySelectorAll(".swatch")[2].click()); // 复古
  await sleep(300);
  eq(await page.evaluate(() => document.body.getAttribute("data-theme")), "sony", "复古主题");
  await page.evaluate(() => document.querySelectorAll(".swatch")[0].click());
  await sleep(300);

  console.log("=== 16. 自定义背景 ===");
  await tapCentered(page, "#set-bg-row");
  await sleep(300);
  const bgInput = await page.$("#pick-img");
  await bgInput.uploadFile(path.join(FIXTURES, "..", "bg.jpg"));
  await sleep(1200);
  ok(await page.evaluate(() => document.body.classList.contains("has-bg")), "背景已应用");
  await page.evaluate(() => {
    const s = document.getElementById("set-bg-dim");
    s.value = "0.8";
    s.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(200);
  eq(await page.$eval("#set-bg-dim-val", el => el.textContent), "80%", "背景浓度 80%");
  await shot(page, "18-custom-bg");
  await tapCentered(page, "#set-bg-clear");
  await sleep(300);
  ok(await page.evaluate(() => !document.body.classList.contains("has-bg")), "背景已清除");

  console.log("=== 17. 可视化 ===");
  await tapCentered(page, "#set-viz-row");
  await sleep(200);
  ok(await page.$eval("#set-viz", el => el.classList.contains("on")), "可视化开关");
  await page.evaluate(() => document.getElementById("mini-art").click());
  await sleep(500);
  ok(await page.$eval("#np-viz", el => el.classList.contains("on")), "可视化面板随设置开关显示");
  await sleep(600);
  const pixelInfo = await page.evaluate(() => {
    const c = document.getElementById("np-canvas");
    const ctx = c.getContext("2d");
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonZero = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) nonZero++;
    return { w: c.width, h: c.height, nonZero: nonZero };
  });
  ok(pixelInfo.nonZero > 500, "频谱画出内容", JSON.stringify(pixelInfo));
  await shot(page, "19-viz-spectrum");
  await page.tap("#np-viz-tabs button[data-tab='wave']");
  await sleep(600);
  const pixelInfo2 = await page.evaluate(() => {
    const c = document.getElementById("np-canvas");
    const ctx = c.getContext("2d");
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonZero = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) nonZero++;
    return nonZero;
  });
  ok(pixelInfo2 > 100, "波形画出内容", "pixels=" + pixelInfo2);
  await shot(page, "20-viz-wave");
  await page.tap("#np-viz-btn");
  await sleep(400);
  ok(await page.evaluate(() => !document.getElementById("np-viz").classList.contains("on")), "NP 内开关可关闭可视化");
  await page.tap("#np-viz-btn");
  await sleep(400);
  ok(await page.$eval("#np-viz", el => el.classList.contains("on")), "NP 内开关重新打开");
  await page.$eval("#np-close", b => b.click());
  await sleep(300);

  console.log("=== 18. 歌词 ===");
  // 先播放一首（当前是短曲可能已结束，点第一首）
  await page.tap("#tabbar .tab[data-page='library']");
  await sleep(300);
  await page.tap(".lib-card:not(.new)");
  await sleep(500);
  await page.evaluate(() => document.querySelectorAll("#detail-list li[data-id]")[0].click());
  await sleep(1200);
  const lrcId = await page.evaluate(() => {
    // 直接调用内部接口载入歌词文本（避免依赖文件选择器）
    const items = document.querySelectorAll("#detail-list li[data-id]");
    return items[0].dataset.id;
  });
  await page.evaluate(() => {
    const t = document.querySelectorAll("#detail-list li[data-id]")[0].dataset.id;
    setLyricsFor(t, "[00:00.50]第一句歌词\n[00:01.50]第二句歌词\n[00:02.50]第三句歌词\n[00:03.50]第四句歌词\n[00:04.50]第五句歌词");
  });
  await page.evaluate(() => document.getElementById("mini-art").click());
  await sleep(500);
  // 可视化与歌词互斥：先关掉可视化再开歌词
  await page.tap("#np-viz-btn");
  await sleep(300);
  await page.tap("#np-lyrics-btn");
  await sleep(500);
  ok(await page.$eval("#np-lyrics", el => el.classList.contains("on")), "歌词浮层显示");
  eq(await page.$$eval(".np-line", els => els.length), 5, "5 行歌词");
  await page.evaluate(() => { seekTo(0.9); });
  await sleep(500);
  const curLine = await page.evaluate(() => {
    const c = document.querySelector(".np-line.cur");
    return c ? c.textContent : "(none)";
  });
  eq(curLine, "第一句歌词", "当前歌词行高亮", curLine);
  await shot(page, "21-lyrics");
  await page.tap("#np-lyrics-btn");
  await sleep(300);
  await page.$eval("#np-close", b => b.click());
  await sleep(600);   // 等播放界面收起动画结束，否则点击会落在遮罩上

  console.log("=== 19. 搜索 ===");
  await page.tap("#tabbar .tab[data-page='search']");
  await sleep(400);
  await page.type("#search-input", "song5");
  await sleep(500);
  const searchRows = await page.$$eval("#search-results .song-row", els => els.length);
  ok(searchRows >= 1, "歌曲搜索结果", "rows=" + searchRows);
  await page.evaluate(() => { document.getElementById("search-input").value = ""; });
  await page.type("#search-input", "我的收藏");
  await sleep(500);
  const searchPl = await page.$$eval("#search-results .song-row", els => els.length);
  ok(searchPl >= 1, "歌单搜索结果");
  await shot(page, "22-search");

  console.log("=== 20. 特殊格式（AC3 跳过） ===");
  await page.tap("#tabbar .tab[data-page='library']");
  await sleep(300);
  await page.tap(".lib-card:not(.new)");
  await sleep(500);
  const input3 = await page.$("#pick-files");
  await input3.uploadFile(path.join(FIXTURES, "tone-5.1.ac3"));
  await sleep(800);
  const fmtTag = await page.$eval("#detail-list li:last-child .fmt-tag", el => el.textContent).catch(() => null);
  eq(fmtTag, "AC3", "AC3 特殊格式标签");
  const rowsBefore = await page.$$eval("#detail-list li[data-id]", els => els.length);
  // 用实时节点点击：标签解析完成会重渲染列表，page.tap 可能命中已被替换的节点
  await page.evaluate((n) => {
    const rows = document.querySelectorAll("#detail-list li[data-id]");
    if (rows[n - 1]) rows[n - 1].click();
  }, rowsBefore);
  await sleep(600);
  const toastTxt = await page.$eval("#toast", el => el.textContent);
  ok(/解码器|跳过/.test(toastTxt), "AC3 提示跳过", toastTxt);

  console.log("=== 21. 音频数据（播放界面 ⋯ 菜单） ===");
  await page.evaluate(() => document.querySelectorAll("#detail-list li[data-id]")[0].click());
  await sleep(1600);
  await page.evaluate(() => document.getElementById("mini-art").click());
  await sleep(800);
  await page.evaluate(() => document.getElementById("np-menu").click());
  await sleep(400);
  await page.evaluate(() => {
    const items = Array.prototype.slice.call(document.querySelectorAll("#menu-items .menu-item"));
    const ai = items.filter(i => /音频数据/.test(i.textContent))[0];
    if (ai) ai.click();
  });
  await sleep(600);
  const aiRows = await page.$$eval("#menu-items .ai-row", els => els.map(e => e.textContent));
  ok(aiRows.length === 7, "音频数据 7 行（含新增「解码输出」）", "rows=" + aiRows.length);
  ok(aiRows.some(t => /解码输出/.test(t)), "包含解码输出行");
  console.log("    ", aiRows.join(" | "));
  await shot(page, "23-audio-info");
  await page.tap("#menu-cancel");
  await sleep(300);

  console.log("=== 22. 持久化（重载） ===");
  await sleep(800); // 等 IDB 落盘
  await page.reload({ waitUntil: "load" });
  await sleep(1800);
  const plCards = await page.$$eval(".lib-card:not(.new)", els => els.length);
  ok(plCards >= 1, "歌单持久化恢复", "cards=" + plCards);
  const themeRestored = await page.evaluate(() => document.body.getAttribute("data-theme"));
  eq(themeRestored, "green", "主题恢复");
  const vizRestored = await page.$eval("#set-viz", el => el.classList.contains("on"));
  ok(!vizRestored, "可视化开关恢复（保持关闭）");
  const modeRestored = await page.$eval("#set-mode-val", el => el.textContent);
  eq(modeRestored, "列表循环", "播放模式恢复");
  // 重载后应恢复到上次打开的歌单详情页
  ok(await page.$eval("#page-detail", el => el.classList.contains("active")), "恢复打开的歌单详情页");
  const restoredTitle = await page.$eval("#detail-title", el => el.textContent);
  eq(restoredTitle, "我的收藏", "恢复的歌单", restoredTitle);
  const rowsRestored = await page.$$eval("#detail-list li[data-id]", els => els.length);
  ok(rowsRestored >= 3, "曲目持久化恢复", "rows=" + rowsRestored);
  const miniGone = await page.$eval("#mini-player", el => el.classList.contains("gone"));
  ok(miniGone, "重启后不自动播放");
  const missingRows = await page.$$eval("#detail-list li.missing", els => els.length);
  eq(missingRows, 0, "重启后无缺失标记");
  const lrcRestored = await page.evaluate(() => {
    const items = document.querySelectorAll("#detail-list li[data-id]");
    return items.length ? (lrcLib.get(items[0].dataset.id) || "") : "";
  });
  ok(lrcRestored.indexOf("第一句歌词") >= 0, "歌词持久化恢复");
  await shot(page, "24-restored");

  console.log("=== 23. 缺失文件处理 ===");
  // 删除「当前歌单中第一首」对应的 IDB 记录，模拟文件被移走
  const victimId = await page.$eval("#detail-list li[data-id]", el => el.dataset.id);
  await page.evaluate(async (vid) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("hibiki-player-files", 1);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    await new Promise((res) => {
      const tx = db.transaction("files", "readwrite");
      tx.objectStore("files").delete(vid);
      tx.oncomplete = () => res();
    });
  }, victimId);
  await page.reload({ waitUntil: "load" });
  await sleep(1800);
  const missingNow = await page.$$eval("#detail-list li.missing", els => els.length);
  ok(missingNow >= 1, "缺失文件标记 ⚠️", "missing=" + missingNow);
  await page.evaluate(() => {
    const m = document.querySelector("#detail-list li.missing");
    if (m) m.click();
  });
  await sleep(600);
  const skipToast = await page.$eval("#toast", el => el.textContent);
  ok(/不可读/.test(skipToast), "缺失点击提示", skipToast);
  await shot(page, "25-missing");

  console.log("=== 24. 麦克风（无设备时的优雅失败） ===");
  await page.tap("#tabbar .tab[data-page='settings']");
  await sleep(300);
  await tapCentered(page, "#set-mic-row");
  await sleep(1500);
  const micToast = await page.$eval("#toast", el => el.textContent);
  ok(/无法访问麦克风|NotFoundError|Permission/.test(micToast), "麦克风失败提示", micToast);
  const micStillOk = await page.evaluate(() => {
    const sw = document.getElementById("set-mic");
    sw.classList.remove("on");
    return true;
  });
  await shot(page, "26-settings");

  console.log("=== 25. 文件夹导入（webkitdirectory） ===");
  await page.tap("#tabbar .tab[data-page='library']");
  await sleep(300);
  await page.tap(".lib-card:not(.new)");
  await sleep(500);
  const dirInput = await page.$("#pick-dir");
  // uploadFile 对 webkitdirectory 输入同样可用：给文件加 relativePath
  await dirInput.uploadFile(
    path.join(FIXTURES, "short-2s.wav"),
    path.join(FIXTURES, "tone-5.1.ac3")
  );
  await sleep(1000);
  const finalRows = await page.$$eval("#detail-list li[data-id]", els => els.length);
  console.log("    文件夹导入后行数:", finalRows);

  console.log("=== 26. 歌单封面设置 ===");
  await page.tap("#detail-menu-btn");
  await sleep(400);
  await page.evaluate(() => {
    const items = Array.prototype.slice.call(document.querySelectorAll("#menu-items .menu-item"));
    const m = items.filter(i => /封面设置/.test(i.textContent))[0];
    if (m) m.click();
  });
  await sleep(400);
  await page.evaluate(() => {
    const items = Array.prototype.slice.call(document.querySelectorAll("#menu-items .menu-item"));
    const m = items.filter(i => /最后一首/.test(i.textContent))[0];
    if (m) m.click();
  });
  await sleep(500);
  await shot(page, "27-cover-last");

  console.log("=== 27. 返回资料库 / 卡片计数 ===");
  await page.tap("#detail-back");
  await sleep(400);
  ok(await page.$eval("#page-library", el => el.classList.contains("active")), "返回资料库");
  const counts = await page.$$eval(".lib-card:not(.new) .lib-card-count", els => els.map(e => e.textContent));
  console.log("    卡片计数:", counts.join(","));
  await shot(page, "28-library-final");

  console.log("=== 28. 系统返回键（popstate 栈） ===");
  // 打开播放界面 → back → 关闭
  await page.evaluate(() => document.getElementById("mini-art").click());
  await sleep(600);
  ok(await page.$eval("#np", el => el.classList.contains("open")), "NP 打开");
  await page.goBack();
  await sleep(400);
  ok(await page.evaluate(() => !document.getElementById("np").classList.contains("open")), "返回键关闭 NP");
  // 打开队列 → back → 关闭
  await page.evaluate(() => document.getElementById("mini-art").click());
  await sleep(500);
  await page.tap("#np-queue-btn");
  await sleep(500);
  ok(await page.$eval("#queue", el => el.classList.contains("open")), "队列打开");
  await page.goBack();
  await sleep(400);
  ok(await page.evaluate(() => !document.getElementById("queue").classList.contains("open")), "返回键关闭队列");
  ok(await page.$eval("#np", el => el.classList.contains("open")), "NP 仍在");
  await page.goBack();
  await sleep(400);
  ok(await page.evaluate(() => !document.getElementById("np").classList.contains("open")), "返回键关闭 NP");
  // 打开歌单详情 → back → 回资料库
  await page.tap("#tabbar .tab[data-page='library']");
  await sleep(300);
  await page.tap(".lib-card:not(.new)");
  await sleep(500);
  ok(await page.$eval("#page-detail", el => el.classList.contains("active")), "详情页打开");
  await page.goBack();
  await sleep(400);
  ok(await page.$eval("#page-library", el => el.classList.contains("active")), "返回键回资料库");
  // 弹窗 → back → 关闭
  await page.evaluate(() => { showDialog("测试弹窗", ""); });
  await sleep(400);
  ok(await page.$eval("#dialog", el => el.classList.contains("on")), "弹窗打开");
  await page.goBack();
  await sleep(400);
  ok(await page.evaluate(() => !document.getElementById("dialog").classList.contains("on")), "返回键关闭弹窗");
  await shot(page, "29-back-stack");

  console.log("\n========== 结果: " + passed + " 通过, " + failed + " 失败 ==========");
  if (errors.length) {
    console.log("累计 JS 错误:");
    errors.forEach(e => console.log("  " + e.slice(0, 200)));
    ok(errors.length === 0, "全程无 JS 错误", errors.slice(0, 3).join(" | "));
  } else {
    ok(true, "全程无 JS 错误");
  }
  if (failures.length) { console.log("失败项:"); failures.forEach(f => console.log("  - " + f)); }
  await browser.close();
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error("测试异常:", e); process.exit(2); });

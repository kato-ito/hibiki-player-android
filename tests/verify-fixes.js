// 本轮六项修复的专项验证：B站登录入口/保存二维码、行内覆盖动画、播放键居中、
// 收起动画同步、首页＋导入新歌单、歌单行 ⋯ 移除与重命名
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
  else { failed++; failures.push(name); console.log("  \u2717 FAIL: " + name + (extra !== undefined ? "  \u2014 " + extra : "")); }
}
function eq(a, b, name) { ok(a === b, name + " (got=" + JSON.stringify(a) + " want=" + JSON.stringify(b) + ")"); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function shot(page, name) { try { await page.screenshot({ path: path.join(SHOTS, name + ".png") }); } catch (e) {} }

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

  console.log("=== 1. 首页右上角 ＋：导入并自动新建歌单 ===");
  ok(await page.$("#lib-add-btn") !== null, "资料库右上角有 ＋ 按钮");
  const plusIcon = await page.$eval("#lib-add-btn svg path", e => e.getAttribute("d"));
  eq(plusIcon, "M12 5v14M5 12h14", "＋ 使用与「新建歌单」一致的加号图形");
  await page.evaluate(() => document.getElementById("lib-add-btn").click());
  await sleep(400);
  const menu0 = await page.$$eval("#menu-items .menu-item", els => els.map(e => e.textContent));
  eq(menu0.length, 2, "＋ 菜单两项（音频文件 / 文件夹）", JSON.stringify(menu0));
  ok(/音频文件/.test(menu0[0]) && /文件夹/.test(menu0[1]), "菜单文案正确", JSON.stringify(menu0));

  // 先验证「取消选择」不会留下空歌单
  let chooser = page.waitForFileChooser();
  await page.evaluate(() => {
    const items = document.querySelectorAll("#menu-items .menu-item");
    items[0].click();
  });
  let fc = await chooser;
  await fc.cancel();
  await sleep(400);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));   // 模拟窗口重新获得焦点
  await sleep(2200);
  const cancelled = await page.evaluate(() => ({ playlists: lib.length, onDetail: document.getElementById("page-detail").classList.contains("active") }));
  eq(cancelled.playlists, 0, "取消选择后不留下空歌单", JSON.stringify(cancelled));
  ok(!cancelled.onDetail, "取消选择后回到资料库");

  // 真正导入
  chooser = page.waitForFileChooser();
  await page.evaluate(() => {
    const items = document.querySelectorAll("#menu-items .menu-item");
    items[0].click();
  });
  fc = await chooser;
  await fc.accept([path.join(FIXTURES, "song1-44100.wav"), path.join(FIXTURES, "song2-48000.wav")]);
  await sleep(2800);
  const imported = await page.evaluate(() => ({
    playlists: lib.length, name: lib[0] && lib[0].name, items: lib[0] ? lib[0].items.length : 0,
    detailActive: document.getElementById("page-detail").classList.contains("active"),
    title: document.getElementById("detail-title").textContent,
    rows: document.querySelectorAll("#detail-list li[data-id]").length,
    toast: document.getElementById("toast").textContent,
  }));
  ok(imported.playlists === 1 && imported.items === 2, "自动新建歌单并放入 2 首", JSON.stringify(imported));
  ok(imported.detailActive && imported.rows === 2, "导入后直接打开新歌单", imported.title);
  ok(/已新建歌单/.test(imported.toast), "提示新建歌单", imported.toast);
  await shot(page, "50-add-import");

  console.log("=== 2. 歌单行：绿色标注 + 无覆盖动画 + 无 ⋯ ===");
  await page.evaluate(() => document.querySelectorAll("#detail-list li[data-id]")[0].click());
  await sleep(1800);
  const rowState = await page.evaluate(() => ({
    menuBtn: document.querySelectorAll("#detail-list .song-menu-btn").length,
    eq: document.querySelectorAll("#detail-list .row-eq").length,
    current: document.querySelectorAll("#detail-list li.current").length,
    color: getComputedStyle(document.querySelector("#detail-list li.current .song-name")).color,
    folder: document.querySelectorAll("#group-list .song-menu-btn").length,
  }));
  eq(rowState.menuBtn, 0, "歌单行内 ⋯ 按钮已移除");
  eq(rowState.eq, 0, "行内均衡器覆盖层已移除");
  eq(rowState.current, 1, "当前曲目用 .current 标注");
  ok(/\(55, 214, 122\)|\(0, 223, 201\)|\(250, 45, 72\)/.test(rowState.color), "当前曲目为强调色（绿色/主题色）", rowState.color);

  console.log("=== 3. 播放 / 暂停按钮居中 ===");
  await page.evaluate(() => document.getElementById("mini-art").click());
  await sleep(900);
  const center = () => page.evaluate(() => {
    const b = document.getElementById("np-play").getBoundingClientRect();
    const s = document.querySelector("#np-play svg").getBoundingClientRect();
    return { dx: +(s.left + s.width / 2 - (b.left + b.width / 2)).toFixed(2),
             dy: +(s.top + s.height / 2 - (b.top + b.height / 2)).toFixed(2),
             disp: getComputedStyle(document.getElementById("np-play")).display };
  });
  const cPause = await center();
  ok(Math.abs(cPause.dx) <= 1 && Math.abs(cPause.dy) <= 1, "暂停图标居中（按钮为 flex 居中）", JSON.stringify(cPause));
  await page.evaluate(() => document.getElementById("np-play").click());
  await sleep(500);
  const cPlay = await center();
  ok(Math.abs(cPlay.dx) <= 1 && Math.abs(cPlay.dy) <= 1, "播放图标居中", JSON.stringify(cPlay));
  await page.evaluate(() => document.getElementById("np-play").click());
  await sleep(500);

  console.log("=== 4. 收起动画：面板与封面同时进行 ===");
  const openAt = await page.evaluate(() => document.getElementById("np-art").parentElement.id);
  eq(openAt, "np-art-zone", "收起前封面在播放界面内");
  await page.evaluate(() => document.getElementById("np-close").click());
  await sleep(90);
  const mid = await page.evaluate(() => ({
    open: document.getElementById("np").classList.contains("open"),
    layerOn: document.getElementById("np-art-layer").classList.contains("on"),
    inLayer: document.getElementById("np-art").parentElement.id,
    tf: getComputedStyle(document.getElementById("np")).transform,
  }));
  ok(!mid.open, "收起瞬间播放界面即开始下滑");
  eq(mid.inLayer, "np-art-zone", "封面不再脱离播放界面（整屏一起滑动）");
  ok(!mid.layerOn, "不再使用独立的封面图层（已按需求移除封面飞行动画）");
  await sleep(300);
  const mid2 = await page.evaluate(() => getComputedStyle(document.getElementById("np")).transform);
  ok(mid2 !== mid.tf, "播放界面在持续缓动（整屏下滑）", String(mid.tf).slice(0, 26) + " -> " + String(mid2).slice(0, 26));
  await sleep(900);
  const settled = await page.evaluate(() => ({
    home: document.getElementById("np-art").parentElement.id,
    layerOn: document.getElementById("np-art-layer").classList.contains("on"),
    pos: document.getElementById("np-art").style.position,
    w: document.getElementById("np-art").style.width,
    npHidden: !document.getElementById("np").classList.contains("open"),
  }));
  ok(settled.home === "np-art-zone" && !settled.layerOn && !settled.pos && !settled.w && settled.npHidden,
    "动画结束后封面复位、样式清理、面板已收起", JSON.stringify(settled));

  console.log("=== 5. 歌单重命名 ===");
  await page.evaluate(() => document.getElementById("detail-menu-btn").click());
  await sleep(400);
  const pm = await page.$$eval("#menu-items .menu-item", els => els.map(e => e.textContent));
  ok(pm.some(t => /重命名/.test(t)), "歌单设置里有重命名", JSON.stringify(pm));
  ok(pm.some(t => /多选管理/.test(t)), "多选管理入口保留（替代行内 ⋯）");
  await page.evaluate(() => {
    const items = document.querySelectorAll("#menu-items .menu-item");
    for (const it of items) if (/重命名/.test(it.textContent)) { it.click(); return; }
  });
  await sleep(500);
  ok(await page.$eval("#dialog", e => e.classList.contains("on")), "重命名弹窗出现");
  eq(await page.$eval("#dialog-input", e => e.value), "新歌单 1", "输入框预填当前名称");
  await page.evaluate(() => { document.getElementById("dialog-input").value = ""; });
  await page.type("#dialog-input", "重命名测试");
  await page.tap("#dialog-ok");
  await sleep(700);
  const renamed = await page.evaluate(() => ({
    title: document.getElementById("detail-title").textContent,
    lib: lib[0].name,
    card: document.querySelector(".lib-card:not(.new) .lib-card-name").textContent,
    toast: document.getElementById("toast").textContent,
  }));
  ok(renamed.title === "重命名测试" && renamed.lib === "重命名测试" && renamed.card === "重命名测试",
    "标题 / 卡片 / 数据三处同步", JSON.stringify(renamed));
  // 重命名后仍可正常播放
  await page.evaluate(() => document.querySelectorAll("#detail-list li[data-id]")[1].click());
  await sleep(1600);
  ok(await page.evaluate(() => !document.getElementById("mini-player").classList.contains("gone")), "重命名后播放正常");
  await shot(page, "52-rename");

  console.log("=== 6. B 站：账号入口下移 + 保存二维码 ===");
  await page.evaluate(() => { closeDetail(); openBili(); });
  await sleep(700);
  const biliUi = await page.evaluate(() => {
    const head = document.querySelector("#page-bili .detail-head");
    const acct = document.getElementById("bili-account-btn").getBoundingClientRect();
    const parse = document.getElementById("bili-parse").getBoundingClientRect();
    const input = document.getElementById("bili-input").getBoundingClientRect();
    return {
      inHeader: !!(head && head.querySelector("#bili-account-btn")),
      belowInput: acct.top > input.bottom,
      belowParse: acct.top > parse.bottom,
      label: document.getElementById("bili-account-name").textContent,
      state: document.getElementById("bili-account-state").textContent,
      saveBtn: !!document.getElementById("qr-save"),
    };
  });
  ok(!biliUi.inHeader, "上栏不再有账号按钮");
  ok(biliUi.belowInput && biliUi.belowParse, "账号入口位于链接解析下方", JSON.stringify(biliUi));
  eq(biliUi.label, "B 站账号", "账号行文案");
  ok(biliUi.saveBtn, "扫码面板有「保存二维码到相册」");
  // 账号行点击仍能打开扫码面板
  await page.tap("#bili-account-btn");
  await sleep(600);
  ok(await page.$eval("#qr-sheet", e => e.classList.contains("open")), "点账号行打开扫码面板");
  // 浏览器（非安卓）下没有原生二维码：点保存应给出守卫提示而不是报错
  await page.tap("#qr-save");
  await sleep(400);
  ok(/二维码|保存/.test(await page.$eval("#toast", e => e.textContent)), "无二维码时给出提示",
    await page.$eval("#toast", e => e.textContent));
  await page.screenshot({ path: path.join(SHOTS, "51-bili-account.png") }).catch(() => {});
  await page.evaluate(() => closeSheet());
  await sleep(400);

  console.log("=== 7. 播放界面菜单补偿入口 ===");
  await page.evaluate(() => document.getElementById("mini-art").click());
  await sleep(800);
  await page.evaluate(() => document.getElementById("np-menu").click());
  await sleep(400);
  const npMenu = await page.$$eval("#menu-items .menu-item", els => els.map(e => e.textContent));
  ok(npMenu.some(t => /音频数据/.test(t)), "播放界面菜单含音频数据", JSON.stringify(npMenu));
  ok(npMenu.some(t => /从歌单移除/.test(t)), "播放界面菜单含从歌单移除");
  await page.evaluate(() => document.getElementById("menu-cancel").click());
  await sleep(300);

  ok(errors.length === 0, "全程无 JS 错误", errors.slice(0, 3).join(" | "));

  console.log("");
  console.log("通过 " + passed + " / " + (passed + failed));
  if (failed) console.log("失败：" + failures.join("; "));
  await browser.close();
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });

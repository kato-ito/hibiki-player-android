// 进度条拖动专项：真机上「划不动 / 拖不动」的场景逐个复现（手指滑出进度条、手指停住、
// 手势被系统打断、轻点、连续拖动、播放中拖动），并覆盖 Pointer / Touch / Mouse 三套事件模型
"use strict";
const puppeteer = require("puppeteer-core");
const path = require("path");
const fs = require("fs");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const URL = "file:///" + path.resolve(__dirname, "..", "www", "index.html").replace(/\\/g, "/");
const FIXTURES = path.resolve(__dirname, "fixtures");
const SHOTS = path.resolve(__dirname, "screenshots");

let passed = 0, failed = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) { passed++; console.log("  \u2713 " + name); }
  else { failed++; failures.push(name); console.log("  \u2717 FAIL: " + name + (extra !== undefined ? "  \u2014 " + extra : "")); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function shot(page, n) { try { await page.screenshot({ path: path.join(SHOTS, n + ".png") }); } catch (e) {} }

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("console", m => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
  page.on("pageerror", e => errors.push("pageerror: " + e.message.slice(0, 160)));
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const cdp = await page.target().createCDPSession();
  await page.goto(URL, { waitUntil: "load" });
  await sleep(900);
  await page.tap("#lib-empty-new"); await sleep(320);
  await page.type("#dialog-input", "拖动验证");
  await page.tap("#dialog-ok"); await sleep(420);
  const input = await page.$("#pick-files");
  await input.uploadFile(path.join(FIXTURES, "song1-44100.wav"), path.join(FIXTURES, "song2-48000.wav"), path.join(FIXTURES, "song3-96000.wav"));
  await sleep(2600);
  await page.evaluate(() => { playFromItems(curPlId, lib[0].items[0].id); });
  await sleep(1500);
  await page.evaluate(() => openNP());
  await sleep(900);

  const boxes = () => page.evaluate(() => {
    const R = id => { const r = document.getElementById(id).getBoundingClientRect();
      return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height, y: r.top + r.height / 2 }; };
    return { bar: R("np-seek"), row: R("np-progress"), times: R("np-times"), mini: R("mini-progress") };
  });
  const st = () => page.evaluate(() => ({
    frac: (media && isFinite(media.duration) && media.duration > 0) ? media.currentTime / media.duration : -1,
    dragging: document.getElementById("np-seek").classList.contains("dragging"),
    fill: parseFloat(document.getElementById("np-seek-fill").style.width) || 0,
    miniFill: parseFloat(document.getElementById("mini-progress-fill").style.width) || 0,
    cur: document.getElementById("np-cur").textContent,
    paused: media ? media.paused : null,
  }));
  const pause = () => page.evaluate(() => { if (media && !media.paused) media.pause(); });
  const seekTo = f => page.evaluate(ff => { media.currentTime = media.duration * ff; updateProgressUI(); }, f);
  const near = (a, b, tol) => Math.abs(a - b) <= tol;

  // CDP 真触摸：points = [[x, y], ...]，最后一点松手（cancel=true 时改为 touchCancel）
  async function touchDrag(points, cancel) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: points[0][0], y: points[0][1] }] });
    await sleep(70);
    for (let i = 1; i < points.length; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: points[i][0], y: points[i][1] }] });
      await sleep(60);
    }
    if (cancel) await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    else await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }

  const B = await boxes();
  ok(B.bar.w > 300 && B.bar.h >= 32, "进度条可拖区域够高（" + Math.round(B.bar.w) + "×" + Math.round(B.bar.h) + "）",
     JSON.stringify(B.bar));
  ok(B.row.h >= B.times.h + B.bar.h, "「时间 + 进度条」整块都是拖动区域", JSON.stringify({ row: B.row, times: B.times }));

  console.log("\n=== 1. 手感：细进度线（填充不再铺成一条粗块） ===");
  const look = await page.evaluate(() => {
    const cs = s => getComputedStyle(document.querySelector(s));
    return {
      fillH: document.getElementById("np-seek-fill").getBoundingClientRect().height,
      trackH: document.querySelector("#np-seek .track").getBoundingClientRect().height,
      barTa: cs("#np-seek").touchAction, rowTa: cs("#np-progress").touchAction,
      fillBg: cs("#np-seek-fill").backgroundImage.slice(0, 26),
    };
  });
  ok(look.fillH <= 5 && Math.abs(look.fillH - look.trackH) <= 1,
     "填充与进度线同粗（" + look.fillH + "px / " + look.trackH + "px），不再是一条粗进度条", JSON.stringify(look));
  ok(/gradient/.test(look.fillBg), "填充仍是强调色渐变", look.fillBg);
  ok(look.barTa === "none" && look.rowTa === "none", "进度条与整块区域都自己接管手势（touch-action: none）",
     JSON.stringify({ bar: look.barTa, row: look.rowTa }));

  await pause();
  await seekTo(0.2);
  await sleep(200);

  console.log("\n=== 2. 任意位置起拖：从时间行按下也能拖 ===");
  {
    const x0 = B.row.l + B.row.w * 0.1, y0 = B.times.t + B.times.h / 2;      // 手指落在时间文字上
    const x1 = B.bar.l + B.bar.w * 0.72;
    await touchDrag([[x0, y0], [x1, y0]]);
    await sleep(350);
    const s = await st();
    ok(near(s.frac, 0.72, 0.09), "从时间行开始拖动也能跳到手指位置（" + Math.round(s.frac * 100) + "%）", JSON.stringify(s));
    ok(!s.dragging, "松手后退出 dragging 状态");
  }

  console.log("\n=== 3. 拖动中：界面跟手 + 声音跟着走（节流真跳转） ===");
  {
    await seekTo(0.1);
    await sleep(200);
    const y = B.bar.y;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: B.bar.l + B.bar.w * 0.15, y: y }] });
    await sleep(70);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: B.bar.l + B.bar.w * 0.6, y: y }] });
    await sleep(420);                                   // 手指停住不动，等节流点
    const mid = await st();
    ok(mid.dragging, "拖动中（未松手）进度条处于 dragging 状态", JSON.stringify(mid));
    ok(near(mid.fill, 60, 3), "界面跟手：填充停在手指位置（" + mid.fill.toFixed(1) + "%）", JSON.stringify(mid));
    ok(near(mid.frac, 0.6, 0.1), "拖动过程中声音已经跳到手指位置（" + Math.round(mid.frac * 100) + "%）", JSON.stringify(mid));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(320);
  }

  console.log("\n=== 4. 手指滑出进度条（斜着拖）再松手 ===");
  {
    const y = B.bar.y;
    await touchDrag([
      [B.bar.l + B.bar.w * 0.2, y],
      [B.bar.l + B.bar.w * 0.4, B.bar.t - 50],
      [B.bar.l + B.bar.w * 0.6, B.bar.t - 110],
      [B.bar.l + B.bar.w * 0.83, B.bar.t - 150],
    ]);
    await sleep(350);
    const s = await st();
    ok(near(s.frac, 0.83, 0.09), "手指离开进度条后继续拖动仍然有效（" + Math.round(s.frac * 100) + "%）", JSON.stringify(s));
    ok(!s.dragging, "松手后 dragging 已清掉");
  }
  await shot(page, "80-seek-drag-out");

  console.log("\n=== 5. 手势被系统打断（touchCancel） ===");
  {
    await seekTo(0.2);
    await sleep(200);
    const y = B.bar.y;
    await touchDrag([[B.bar.l + B.bar.w * 0.2, y], [B.bar.l + B.bar.w * 0.55, y]], true);
    await sleep(300);
    const s = await st();
    ok(!s.dragging, "被打断后不会卡在 dragging（进度条还能继续拖）", JSON.stringify(s));
    ok(near(s.frac, 0.55, 0.12), "被打断时保留手指走过的位置（" + Math.round(s.frac * 100) + "%）", JSON.stringify(s));
    const x1 = B.bar.l + B.bar.w * 0.28;
    await touchDrag([[B.bar.l + B.bar.w * 0.85, y], [x1, y]]);
    await sleep(320);
    const s2 = await st();
    ok(near(s2.frac, 0.28, 0.09), "被打断之后紧接着再拖一次照样生效（" + Math.round(s2.frac * 100) + "%）", JSON.stringify(s2));
  }

  console.log("\n=== 6. 轻点一下就跳转 ===");
  {
    const y = B.bar.y;
    await touchDrag([[B.bar.l + B.bar.w * 0.7, y]]);
    await sleep(320);
    const s = await st();
    ok(near(s.frac, 0.7, 0.09), "轻点进度条跳到手指位置（" + Math.round(s.frac * 100) + "%）", JSON.stringify(s));
  }

  console.log("\n=== 7. 连续拖动 ===");
  {
    const y = B.bar.y;
    await touchDrag([[B.bar.l + B.bar.w * 0.3, y], [B.bar.l + B.bar.w * 0.78, y]]);
    await sleep(300);
    const a = await st();
    await touchDrag([[B.bar.l + B.bar.w * 0.78, y], [B.bar.l + B.bar.w * 0.22, y]]);
    await sleep(300);
    const b = await st();
    ok(near(a.frac, 0.78, 0.09) && near(b.frac, 0.22, 0.09),
       "连续两次拖动（右 → 左）都被接受", JSON.stringify({ a: a.frac, b: b.frac }));
  }

  console.log("\n=== 8. 播放中拖动：不暂停、位置照跳 ===");
  {
    await page.evaluate(() => { if (media.paused) media.play().catch(() => {}); });
    await sleep(500);
    const y = B.bar.y;
    await touchDrag([[B.bar.l + B.bar.w * 0.85, y], [B.bar.l + B.bar.w * 0.45, y]]);
    await sleep(320);
    const s = await st();
    ok(s.paused === false, "拖动进度条不会把播放变成暂停", JSON.stringify(s));
    ok(near(s.frac, 0.45, 0.12), "播放中拖动同样跳到手指位置（" + Math.round(s.frac * 100) + "%）", JSON.stringify(s));
    await pause();
  }

  console.log("\n=== 9. 旧 WebView：只有 touch 事件（没有 PointerEvent）也能拖 ===");
  {
    await seekTo(0.15);
    await sleep(200);
    const s = await page.evaluate(async (x0frac, x1frac) => {
      const bar = document.getElementById("np-seek");
      const r = bar.getBoundingClientRect(), y = r.top + r.height / 2;
      const ev = (type, frac) => {
        const x = r.left + r.width * frac;
        const t = new Touch({ identifier: 7, target: bar, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y });
        const live = type === "touchend" ? [] : [t];
        return new TouchEvent(type, { bubbles: true, cancelable: true, composed: true, touches: live, targetTouches: live, changedTouches: [t] });
      };
      bar.dispatchEvent(ev("touchstart", x0frac));
      await new Promise(r2 => setTimeout(r2, 60));
      const midDragging = bar.classList.contains("dragging");
      bar.dispatchEvent(ev("touchmove", x1frac));
      await new Promise(r2 => setTimeout(r2, 60));
      const midFill = parseFloat(document.getElementById("np-seek-fill").style.width) || 0;
      bar.dispatchEvent(ev("touchend", x1frac));
      await new Promise(r2 => setTimeout(r2, 60));
      return { midDragging: midDragging, midFill: midFill, endDragging: bar.classList.contains("dragging") };
    }, 0.15, 0.58);
    await sleep(300);
    const after = await st();
    ok(s.midDragging && s.midFill > 50, "只有 touch 事件时：拖动预览照样跟手", JSON.stringify(s));
    ok(!s.endDragging, "只有 touch 事件时：松手能正常收尾");
    ok(near(after.frac, 0.58, 0.09), "只有 touch 事件时：位置同样跳到手指处（" + Math.round(after.frac * 100) + "%）", JSON.stringify(after));
  }

  console.log("\n=== 10. 桌面浏览器：鼠标拖动 ===");
  {
    await seekTo(0.1);
    await sleep(200);
    const s = await page.evaluate(async () => {
      const bar = document.getElementById("np-seek");
      const r = bar.getBoundingClientRect(), y = r.top + r.height / 2;
      const x0 = r.left + r.width * 0.15, x1 = r.left + r.width * 0.68;
      const M = (type, node, x) => node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1 }));
      M("mousedown", bar, x0);
      await new Promise(r2 => setTimeout(r2, 60));
      M("mousemove", document.body, x1);
      await new Promise(r2 => setTimeout(r2, 60));
      M("mouseup", document.body, x1);
      await new Promise(r2 => setTimeout(r2, 60));
      return { dragging: bar.classList.contains("dragging") };
    });
    await sleep(300);
    const after = await st();
    ok(!s.dragging, "鼠标拖动松手后收尾正常");
    ok(near(after.frac, 0.68, 0.09), "鼠标也能拖到目标位置（" + Math.round(after.frac * 100) + "%）", JSON.stringify(after));
  }

  console.log("\n=== 11. 迷你条：手指从迷你条一路滑到播放界面也能拖 ===");
  {
    await seekTo(0.2);
    await sleep(200);
    const mini = await boxes();
    await page.evaluate(() => closeNP());
    await sleep(600);
    const m = await page.evaluate(() => {
      const r = document.getElementById("mini-progress").getBoundingClientRect();
      return { l: r.left, t: r.top, b: r.bottom, w: r.width };
    });
    const y = m.b - 5;
    await touchDrag([[m.l + m.w * 0.25, y], [m.l + m.w * 0.5, m.t - 20], [m.l + m.w * 0.75, m.t - 90]]);
    await sleep(350);
    const s = await st();
    ok(near(s.frac, 0.75, 0.1), "迷你条拖出条外松手照样跳到手指位置（" + Math.round(s.frac * 100) + "%）", JSON.stringify(s));
    ok(!s.dragging, "迷你条拖动结束后状态已清掉");
    await page.evaluate(() => openNP());
    await sleep(600);
  }

  console.log("\n=== 12. 拖动结束后进度继续正常走 ===");
  {
    await page.evaluate(() => { if (media.paused) media.play().catch(() => {}); });
    const y = B.bar.y;
    await touchDrag([[B.bar.l + B.bar.w * 0.2, y], [B.bar.l + B.bar.w * 0.5, y]]);
    await sleep(1500);
    const s = await st();
    ok(!s.dragging, "拖动后 dragging 标记没有残留");
    ok(s.frac > 0.5, "拖动后播放位置继续前进（" + Math.round(s.frac * 100) + "%）", JSON.stringify(s));
    ok(Math.abs(s.fill - s.frac * 100) < 8, "界面进度跟随播放（fill " + s.fill.toFixed(1) + "% vs " + (s.frac * 100).toFixed(1) + "%）",
       JSON.stringify(s));
    await shot(page, "81-seek-after-drag");
  }

  ok(errors.length === 0, "全程无 JS 错误", errors.slice(0, 3).join(" | "));

  console.log("\n合计：" + (passed + failed) + " 项，通过 " + passed + "，失败 " + failed);
  if (failed) console.log("失败项：" + failures.join("、"));
  await browser.close();
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });

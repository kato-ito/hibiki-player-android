// 界面美术专项校验：新下栏（悬浮迷你卡片 + 标签栏）、分段控件、动效参数
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
const ok = (c, name, extra) => {
  if (c) { passed++; console.log("  \u2713 " + name); }
  else { failed++; failures.push(name); console.log("  \u2717 FAIL: " + name + (extra !== undefined ? "  \u2014 " + extra : "")); }
};
const eq = (a, b, name) => ok(a === b, name + (a === b ? "" : "  (got=" + JSON.stringify(a) + " want=" + JSON.stringify(b) + ")"));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = (page, n) => page.screenshot({ path: path.join(SHOTS, n + ".png") }).catch(() => {});

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(URL, { waitUntil: "load" });
  await sleep(800);

  console.log("=== 1. 标签栏（Apple Music 风格） ===");
  const tab = await page.evaluate(() => {
    const tb = document.getElementById("tabbar");
    const cs = getComputedStyle(tb);
    const before = getComputedStyle(tb, "::before");
    const tabEl = document.querySelector(".tab");
    const active = document.querySelector(".tab.active");
    const activeSvg = getComputedStyle(active.querySelector("svg"));
    return {
      backdrop: cs.backdropFilter || cs.webkitBackdropFilter,
      bg: cs.backgroundColor,
      hairline: before.height + " " + before.backgroundColor,
      fontSize: getComputedStyle(tabEl).fontSize,
      label: getComputedStyle(tabEl).fontWeight,
      iconSize: getComputedStyle(tabEl.querySelector("svg")).width,
      activeFill: activeSvg.fillOpacity,
      transition: getComputedStyle(tabEl).transitionDuration,
    };
  });
  ok(/blur/.test(tab.backdrop) && /saturate/.test(tab.backdrop), "标签栏为毛玻璃（blur + saturate）", tab.backdrop);
  ok(/rgba?\(/.test(tab.bg), "标签栏半透明底色", tab.bg);
  ok(/1px/.test(tab.hairline), "顶部发丝分隔线（0.5px 视觉）", tab.hairline);
  eq(tab.fontSize, "10.5px", "标签文字 10.5px（iOS 规范）");
  eq(tab.iconSize, "26px", "图标 26px（iOS 规范）");
  ok(parseFloat(tab.activeFill) > 0, "选中标签图标为填充态（SF Symbols 观感）", tab.activeFill);
  const tbGeo = await page.evaluate(() => {
    const tb = document.getElementById("tabbar");
    const cs = getComputedStyle(tb);
    const r = tb.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    return {
      left: Math.round(r.left), right: Math.round(vw - r.right), bottom: Math.round(vh - r.bottom),
      radius: cs.borderRadius, shadow: cs.boxShadow.slice(0, 40),
      insetX: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tabbar-inset")),
    };
  });
  ok(tbGeo.left >= 10 && tbGeo.right >= 10 && tbGeo.bottom >= 6,
    "标签栏为悬浮胶囊（离底、左右留边）", JSON.stringify(tbGeo));
  ok(parseFloat(tbGeo.radius) >= 20, "标签栏为圆角胶囊", tbGeo.radius);
  ok(/rgba?\(/.test(tbGeo.shadow), "标签栏带投影（浮起感）", tbGeo.shadow);
  await shot(page, "art-01-library");

  console.log("=== 2. 迷你播放条（悬浮卡片） ===");
  await page.tap("#lib-empty-new"); await sleep(300);
  await page.type("#dialog-input", "美术校验"); await page.tap("#dialog-ok"); await sleep(400);
  const pick = await page.$("#pick-files");
  await pick.uploadFile(path.join(FIXTURES, "song4-tagged.mp3"), path.join(FIXTURES, "song1-44100.wav"));
  await sleep(2000);
  await page.evaluate(() => document.querySelectorAll("#detail-list li[data-id]")[0].click());
  await sleep(2000);
  const mini = await page.evaluate(() => {
    const mp = document.getElementById("mini-player");
    const cs = getComputedStyle(mp);
    const r = mp.getBoundingClientRect();
    const tb = document.getElementById("tabbar").getBoundingClientRect();
    const art = document.getElementById("mini-art").getBoundingClientRect();
    const prog = document.getElementById("mini-progress").getBoundingClientRect();
    return {
      radius: cs.borderRadius, shadow: cs.boxShadow.slice(0, 40), backdrop: cs.backdropFilter || cs.webkitBackdropFilter,
      transition: cs.transitionDuration + " / " + cs.transitionTimingFunction,
      left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width),
      height: Math.round(r.height), gapToTabbar: Math.round(tb.top - r.bottom),
      artSize: Math.round(art.width), artRadius: getComputedStyle(document.getElementById("mini-art")).borderRadius,
      progBottom: Math.round(r.bottom - prog.bottom),
      vw: document.documentElement.clientWidth,
    };
  });
  ok(parseFloat(mini.radius) >= 12, "迷你条为大圆角卡片", mini.radius);
  ok(/rgba?\(/.test(mini.shadow), "卡片带投影", mini.shadow);
  ok(/blur/.test(mini.backdrop), "卡片毛玻璃", mini.backdrop);
  ok(mini.left >= 8 && mini.vw - mini.right >= 8, "左右悬浮留边", mini.left + "/" + (mini.vw - mini.right));
  ok(mini.gapToTabbar >= 5 && mini.gapToTabbar <= 14, "与标签栏留出间距", "gap=" + mini.gapToTabbar);
  ok(mini.height <= 62, "卡片高度紧凑（AM 观感）", mini.height);
  eq(mini.artSize, 44, "封面 44px");
  ok(parseFloat(mini.artRadius) >= 8, "封面圆角", mini.artRadius);
  ok(mini.progBottom <= 8, "进度线位于卡片底部", "距底 " + mini.progBottom);
  ok(/0\.42s/.test(mini.transition), "卡片动效使用 iOS 曲线", mini.transition);
  await shot(page, "art-02-miniplayer");
  await page.screenshot({ path: path.join(SHOTS, "art-02b-bottom-bar.png"), clip: { x: 0, y: 700, width: 390, height: 144 } }).catch(() => {});

  console.log("=== 3. 播放界面转场与控件 ===");
  await page.evaluate(() => document.getElementById("mini-art").click());
  await sleep(120);
  // 转场：整个播放界面从下往上滑入（Apple Music 的 sheet），封面不再单独做 Morph
  const entering = await page.evaluate(() => {
    const np = document.getElementById("np");
    const art = document.getElementById("np-art");
    return {
      npTransition: getComputedStyle(np).transitionProperty + " " + getComputedStyle(np).transitionDuration,
      artInline: art.style.transform,
      artParent: art.parentElement.id,
      artTop: Math.round(art.getBoundingClientRect().top),
    };
  });
  ok(/transform/.test(entering.npTransition), "打开时播放界面整屏滑入（transform 过渡）", entering.npTransition);
  ok(entering.artInline === "" && entering.artParent === "np-art-zone",
    "封面不做单独飞行（始终在播放界面内）", JSON.stringify(entering));
  await sleep(900);
  const npSettled = await page.evaluate(() => {
    const art = document.getElementById("np-art");
    const r = art.getBoundingClientRect();
    const cs = getComputedStyle(art);
    return {
      transform: cs.transform, width: Math.round(r.width),
      cx: Math.round(r.left + r.width / 2), vw: document.documentElement.clientWidth,
      entries: ["#np-play", "#np-prev", "#np-next", "#np-back15", "#np-fwd15"].map(s => {
        const el = document.querySelector(s);
        return el ? el.querySelector("svg").getAttribute("viewBox") : "missing";
      }),
    };
  });
  eq(npSettled.transform, "none", "动画结束后无残留变换（不会错位）");
  ok(Math.abs(npSettled.cx - npSettled.vw / 2) <= 2, "封面居中", npSettled.cx + " vs " + npSettled.vw / 2);
  ok(npSettled.entries.every(v => v === "0 0 24 24"), "控制按钮均为统一图标体系", JSON.stringify(npSettled.entries));
  await shot(page, "art-03-nowplaying");
  await page.evaluate(() => document.getElementById("np-close").click());
  await sleep(700);
  eq(await page.evaluate(() => getComputedStyle(document.getElementById("np-art")).transform), "none", "收起后封面无残留变换");

  console.log("=== 4. 设置页：杜比输出分段控件 ===");
  await page.tap("#tabbar .tab[data-page='settings']"); await sleep(500);
  const seg = await page.evaluate(() => {
    const box = document.getElementById("dolby-seg");
    const cs = getComputedStyle(box);
    const btns = Array.from(box.querySelectorAll("button"));
    const on = btns.filter(b => b.classList.contains("on"))[0];
    const thumb = on ? getComputedStyle(on) : null;
    return {
      radius: cs.borderRadius, track: cs.backgroundColor, count: btns.length,
      labels: btns.map(b => b.textContent),
      onLabel: on ? on.textContent : null,
      thumbBg: thumb ? thumb.backgroundColor : null,
      cur: document.getElementById("dolby-cur").textContent,
      note: document.getElementById("dolby-note").textContent.slice(0, 40),
    };
  });
  eq(seg.count, 2, "两个选项");
  eq(seg.labels.join("/"), "原生输出/下混输出", "选项文案为「原生输出 / 下混输出」");
  eq(seg.onLabel, "原生输出", "默认选中原生输出");
  ok(parseFloat(seg.radius) >= 7, "分段控件圆角", seg.radius);
  ok(seg.thumbBg !== seg.track, "选中项有独立底色（滑块）", seg.thumbBg + " vs " + seg.track);
  ok(/输出设备/.test(seg.note), "显示当前输出设备", seg.note);
  await shot(page, "art-04-settings");
  // 切换到下混
  await page.evaluate(() => document.querySelector("#dolby-seg button[data-mode='device']").click());
  await sleep(400);
  const after = await page.evaluate(() => ({
    on: document.querySelector("#dolby-seg button.on").textContent,
    cur: document.getElementById("dolby-cur").textContent,
    mode: dolbyMode,
  }));
  eq(after.on, "下混输出", "点击后切换到「下混输出」");
  eq(after.cur, "下混输出", "标题栏同步");
  eq(after.mode, "device", "模式持久化值正确");
  await page.evaluate(() => document.querySelector("#dolby-seg button[data-mode='native']").click());
  await sleep(300);

  console.log("=== 5. 动效参数一致性 ===");
  const motion = await page.evaluate(() => ({
    page: getComputedStyle(document.querySelector(".page.active")).animationDuration,
    sheet: getComputedStyle(document.getElementById("queue")).transitionDuration,
    row: getComputedStyle(document.querySelector("#detail-list li")).transitionDuration || "0s",
    ease: getComputedStyle(document.body).getPropertyValue("--ios-ease").trim(),
  }));
  ok(parseFloat(motion.page) >= 0.3, "页面切换动画时长 ≥0.3s", motion.page);
  ok(/0\.46s/.test(motion.sheet), "面板滑入 0.46s", motion.sheet);
  eq(motion.ease, "cubic-bezier(0.32, 0.72, 0, 1)", "统一使用 iOS 缓动曲线");

  console.log("\n========== 美术校验: " + passed + " 通过, " + failed + " 失败 ==========");
  if (failures.length) { console.log("失败项:"); failures.forEach(f => console.log("  - " + f)); }
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("测试异常:", e); process.exit(2); });

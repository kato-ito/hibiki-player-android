// 布局审计：检查关键元素几何与视觉参数（无需读图）
"use strict";
const puppeteer = require("puppeteer-core");
const path = require("path");
const CHROME = process.env.CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const URL = "file:///" + path.resolve(__dirname, "..", "www", "index.html").replace(/\\/g, "/");
const FIXTURES = path.resolve(__dirname, "fixtures");
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(URL, { waitUntil: "load" });
  await sleep(800);
  await page.tap("#lib-empty-new"); await sleep(300);
  await page.type("#dialog-input", "审计歌单"); await page.tap("#dialog-ok"); await sleep(400);
  const input = await page.$("#pick-files");
  await input.uploadFile(
    path.join(FIXTURES, "song1-44100.wav"),
    path.join(FIXTURES, "song4-tagged.mp3"),
    path.join(FIXTURES, "song6-tagged.m4a")
  );
  await sleep(2000);

  const audit = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const rect = el => { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
    const out = { vw, vh, problems: [] };
    const P = (name, cond, info) => { out[name] = cond; if (!cond) out.problems.push(name + ": " + info); };
    // 无横向溢出
    P("noHorizontalOverflow", document.documentElement.scrollWidth <= vw, "scrollWidth=" + document.documentElement.scrollWidth);
    // 标签栏
    const tb = rect(document.getElementById("tabbar"));
    // iOS 18 风格：悬浮胶囊标签栏（左右各 12px、离底 8px、高 58px）
    P("tabbarFloating", Math.abs(tb.l - 12) <= 1 && Math.abs(tb.r - (vw - 12)) <= 1 &&
      Math.abs(tb.b - (vh - 8)) <= 1 && tb.h >= 54 && tb.h <= 62, JSON.stringify({ tb, vw, vh }));
    // 详情头部
    const dh = rect(document.querySelector(".detail-head"));
    P("detailHeadSticky", dh.t >= 0 && dh.h >= 40, JSON.stringify(dh));
    // 行元素
    const row = document.querySelector("#detail-list .song-row");
    const rr = rect(row);
    P("rowHeight", rr.h >= 60 && rr.h <= 72, "h=" + rr.h);
    const cover = rect(row.querySelector(".cover"));
    P("rowCoverSquare", Math.abs(cover.w - cover.h) <= 2 && cover.w >= 44, JSON.stringify(cover));
    // 播放并检查迷你条 + NP
    return out;
  });
  console.log("视口:", audit.vw, "x", audit.vh);
  console.log("审计:", JSON.stringify(audit, null, 1));

  // 播放 → 迷你条 / NP 几何
  await page.evaluate(() => document.querySelectorAll("#detail-list li[data-id]")[0].click());
  await sleep(1500);
  const audit2 = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    const rect = el => { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
    const out = { problems: [] };
    const P = (name, cond, info) => { out[name] = cond; if (!cond) out.problems.push(name + ": " + info); };
    const mp = rect(document.getElementById("mini-player"));
    const tb = rect(document.getElementById("tabbar"));
    P("miniAboveTabbar", (tb.t - mp.b) >= 4 && (tb.t - mp.b) <= 16 && mp.h >= 50, JSON.stringify({ mp, tb }));
    P("miniInViewport", mp.l >= 0 && mp.r <= vw, JSON.stringify(mp));
    const progress = rect(document.getElementById("mini-progress"));
    P("miniProgressInside", progress.t > mp.t + mp.h * 0.6 && progress.b <= mp.b + 1, JSON.stringify(progress));
    return out;
  });
  console.log("迷你条:", JSON.stringify(audit2, null, 1));

  await page.evaluate(() => document.getElementById("mini-art").click());
  await sleep(700);
  const audit3 = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    const rect = el => { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
    const out = { problems: [] };
    const P = (name, cond, info) => { out[name] = cond; if (!cond) out.problems.push(name + ": " + info); };
    const np = rect(document.getElementById("np"));
    P("npFullscreen", Math.abs(np.l) <= 1 && Math.abs(np.t) <= 1 && Math.abs(np.r - vw) <= 1 && Math.abs(np.b - vh) <= 1, JSON.stringify(np));
    const art = rect(document.getElementById("np-art"));
    P("artSquareCentered", Math.abs(art.w - art.h) <= 3, JSON.stringify(art));
    P("artWithinViewport", art.l >= 0 && art.r <= vw && art.t > 40 && art.b < vh - 120, JSON.stringify(art));
    const play = rect(document.getElementById("np-play"));
    P("playButtonRound", Math.abs(play.w - play.h) <= 2 && play.w >= 66, JSON.stringify(play));
    const seek = rect(document.getElementById("np-seek"));
    P("seekWidth", seek.w > vw * 0.7, JSON.stringify(seek));
    const extra = rect(document.getElementById("np-extra"));
    P("extraAboveBottom", extra.b <= vh && extra.t < vh - 40, JSON.stringify(extra));
    // 封面或占位可见
    const artVisible = document.getElementById("np-art").style.display !== "none";
    P("artVisible", artVisible, "");
    return out;
  });
  console.log("NP:", JSON.stringify(audit3, null, 1));

  // 歌词 + 可视化几何
  await page.evaluate(() => {
    const t = document.querySelectorAll("#detail-list li[data-id]")[0].dataset.id;
    setLyricsFor(t, "[00:00.50]第一句\n[00:01.50]第二句\n[00:02.50]第三句");
  });
  await page.evaluate(() => document.getElementById("np-lyrics-btn").click());
  await sleep(500);
  const audit4 = await page.evaluate(() => {
    const rect = el => { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
    const out = { problems: [] };
    const P = (name, cond, info) => { out[name] = cond; if (!cond) out.problems.push(name + ": " + info); };
    const lyr = rect(document.getElementById("np-lyrics"));
    P("lyricsCoverArtZone", lyr.w > 200 && lyr.h > 200, JSON.stringify(lyr));
    const lines = document.querySelectorAll(".np-line");
    P("lyricsLines", lines.length === 3, "n=" + lines.length);
    return out;
  });
  console.log("歌词:", JSON.stringify(audit4, null, 1));

  await page.evaluate(() => document.getElementById("np-viz-btn").click());
  await sleep(700);
  const audit5 = await page.evaluate(() => {
    const rect = el => { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
    const out = { problems: [] };
    const P = (name, cond, info) => { out[name] = cond; if (!cond) out.problems.push(name + ": " + info); };
    const cv = rect(document.getElementById("np-canvas"));
    P("canvasSized", cv.w > 200 && cv.h > 200, JSON.stringify(cv));
    const axis = document.getElementById("np-viz-axis").textContent;
    P("axisLabel", /kHz/.test(axis), axis);
    out.axis = axis;
    return out;
  });
  console.log("可视化:", JSON.stringify(audit5, null, 1));

  // 皮肤颜色一致性
  await page.evaluate(() => document.getElementById("np-close").click());
  await sleep(300);
  await page.tap("#tabbar .tab[data-page='settings']");
  await sleep(300);
  const themeCheck = await page.evaluate(() => {
    const out = { problems: [] };
    const P = (name, cond, info) => { out[name] = cond; if (!cond) out.problems.push(name + ": " + info); };
    applyTheme("white");
    const bg = getComputedStyle(document.body).backgroundColor;
    const accent = getComputedStyle(document.body).getPropertyValue("--accent").trim();
    P("whiteThemeBg", bg === "rgb(245, 245, 247)", bg);
    P("whiteThemeAccent", accent === "#fa2d48", accent);
    applyTheme("sony");
    const bg2 = getComputedStyle(document.body).backgroundColor;
    const accent2 = getComputedStyle(document.body).getPropertyValue("--accent").trim();
    P("sonyThemeBg", bg2 === "rgb(25, 22, 17)", bg2);
    P("sonyThemeAccent", accent2 === "#00dfc9", accent2);
    applyTheme("green");
    const accent3 = getComputedStyle(document.body).getPropertyValue("--accent").trim();
    P("greenThemeAccent", accent3 === "#37d67a", accent3);
    return out;
  });
  console.log("皮肤:", JSON.stringify(themeCheck, null, 1));

  const all = [audit, audit2, audit3, audit4, audit5, themeCheck];
  const totalProblems = all.reduce((n, a) => n + (a.problems ? a.problems.length : 0), 0);
  console.log("\n布局问题总数:", totalProblems);
  await browser.close();
  process.exit(totalProblems ? 1 : 0);
})().catch(e => { console.error("EXC:", e); process.exit(2); });

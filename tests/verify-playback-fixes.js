// 本轮 5 项修复的验证：进度条拖动、后台/锁屏通道、点封面收起、冷启动播放、解码中提示
"use strict";
const puppeteer = require("puppeteer-core");
const path = require("path");
const fs = require("fs");
const http = require("http");

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
function eq(a, b, name) { ok(a === b, name + (a === b ? "" : "  (got=" + JSON.stringify(a) + " want=" + JSON.stringify(b) + ")")); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function shot(page, n) { try { await page.screenshot({ path: path.join(SHOTS, n + ".png") }); } catch (e) {} }

// 原生模式用的本地服务：/decoded/<key> 一律返回一个真实 WAV，页面拿它当解码结果播放
function startServer() {
  const wav = fs.readFileSync(path.join(FIXTURES, "song2-48000.wav"));
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const range = req.headers.range;
      const total = wav.length;
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        const start = m ? parseInt(m[1], 10) : 0;
        const end = m && m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
        res.writeHead(206, {
          "Content-Type": "audio/wav", "Accept-Ranges": "bytes",
          "Access-Control-Allow-Origin": "*",
          "Content-Range": "bytes " + start + "-" + end + "/" + total,
          "Content-Length": String(end - start + 1),
        });
        res.end(wav.subarray(start, end + 1));
      } else {
        res.writeHead(200, { "Content-Type": "audio/wav", "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*", "Content-Length": String(total) });
        res.end(wav);
      }
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv: srv, base: "http://127.0.0.1:" + srv.address().port }));
  });
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  });
  const errors = [];

  /* ================= 页面 A：浏览器模式（拖进度条 / 点封面 / 冷启动播放） ================= */
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.on("console", m => { if (m.type() === "error") errors.push(m.text().slice(0, 140)); });
  page.on("pageerror", e => errors.push("pageerror: " + e.message.slice(0, 160)));
  const cdp = await page.target().createCDPSession();
  await page.goto(URL, { waitUntil: "load" });
  await sleep(900);
  await page.tap("#lib-empty-new"); await sleep(320);
  await page.type("#dialog-input", "播放修复");
  await page.tap("#dialog-ok"); await sleep(420);
  const input = await page.$("#pick-files");
  await input.uploadFile(path.join(FIXTURES, "song1-44100.wav"), path.join(FIXTURES, "song2-48000.wav"), path.join(FIXTURES, "song3-96000.wav"));
  await sleep(2600);

  console.log("=== 1. 进度条可以随意滑动 ===");
  const seekCss = await page.evaluate(() => ({
    np: getComputedStyle(document.getElementById("np-seek")).touchAction,
    mini: getComputedStyle(document.getElementById("mini-progress")).touchAction,
  }));
  eq(seekCss.np, "none", "播放界面进度条自己接管手势（touch-action: none）", seekCss.np);
  eq(seekCss.mini, "none", "迷你条进度条同样接管手势", seekCss.mini);
  await page.evaluate(async () => { playFromItems(curPlId, lib[0].items[0].id); });
  await sleep(1500);
  await page.evaluate(() => openNP());
  await sleep(700);
  const dur = await page.evaluate(() => (media && isFinite(media.duration)) ? media.duration : 0);
  ok(dur > 0.2, "已有可播放的音频（时长 " + (Math.round(dur * 100) / 100) + "s）", String(dur));
  const bar = await page.evaluate(() => {
    const r = document.getElementById("np-seek").getBoundingClientRect();
    return { x: r.left, y: r.top + r.height / 2, w: r.width };
  });
  const x1 = bar.x + bar.w * 0.15, x2 = bar.x + bar.w * 0.65;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x1, y: bar.y }] });
  await sleep(80);
  for (let i = 1; i <= 5; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x1 + (x2 - x1) * i / 5, y: bar.y }] });
    await sleep(50);
  }
  const during = await page.evaluate(() => ({
    dragging: document.getElementById("np-seek").classList.contains("dragging"),
    preview: document.getElementById("np-cur").textContent,
    fill: document.getElementById("np-seek-fill").style.width,
  }));
  ok(during.dragging, "拖动中进度条处于 dragging 状态");
  ok(parseFloat(during.fill) > 50, "拖动时预览跟手（填充 " + during.fill + "）", during.fill);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(400);
  const afterSeek = await page.evaluate(() => ({
    frac: (media && isFinite(media.duration) && media.duration > 0) ? media.currentTime / media.duration : -1,
    dragging: document.getElementById("np-seek").classList.contains("dragging"),
  }));
  ok(Math.abs(afterSeek.frac - 0.65) < 0.15, "松手后跳到了手指位置（" + Math.round(afterSeek.frac * 100) + "%）", JSON.stringify(afterSeek));
  ok(!afterSeek.dragging, "松手后退出 dragging 状态");
  await shot(page, "70-seek-drag");
  await page.evaluate(() => closeNP());          // 收起播放界面，迷你条才点得到
  await sleep(500);
  const mini = await page.evaluate(() => {
    const box = document.getElementById("mini-progress");
    const r = box.getBoundingClientRect();
    const y = r.bottom - 3;                       // 靠近进度线，避开迷你条的按钮
    const hit = document.elementFromPoint(r.left + r.width * 0.3, y);
    return { x: r.left, y: y, w: r.width, hit: hit ? (hit.id || hit.className) : "none", box: [Math.round(r.width), Math.round(r.height)] };
  });
  console.log("    迷你条诊断：" + JSON.stringify(mini));
  await page.evaluate(() => { if (media && !media.paused) media.pause(); });   // 暂停，避免播放中位置漂移影响断言
  await sleep(200);
  const mx = mini.x + mini.w * 0.3;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: mx - 12, y: mini.y }] });
  await sleep(60);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: mx, y: mini.y }] });
  await sleep(60);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(350);
  const miniFrac = await page.evaluate(() => (media && isFinite(media.duration) && media.duration > 0) ? media.currentTime / media.duration : -1);
  ok(Math.abs(miniFrac - 0.3) < 0.16, "迷你条也能拖动跳转（" + Math.round(miniFrac * 100) + "%）", String(miniFrac));

  console.log("=== 2. 点专辑封面退出播放界面 ===");
  await page.evaluate(() => openNP());            // 上一节为了点迷你条收起了面板，这里重新打开
  await sleep(600);
  const coverTap = await page.evaluate(() => {
    const r = document.getElementById("np-art").getBoundingClientRect();
    return { open: document.getElementById("np").classList.contains("open"), x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  ok(coverTap.open, "播放界面已打开（前置）");
  await page.mouse.click(coverTap.x, coverTap.y);
  await sleep(500);
  eq(await page.evaluate(() => document.getElementById("np").classList.contains("open")), false, "点封面后播放界面收起");
  await page.evaluate(() => openNP());
  await sleep(500);
  await page.evaluate(() => { document.getElementById("np-lyrics-btn").click(); });
  await sleep(700);
  const lyricTap = await page.evaluate(() => {
    const box = document.getElementById("np-lyrics");
    const r = box.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + Math.min(60, Math.max(10, r.height / 2)) };
  });
  await page.mouse.click(lyricTap.x, lyricTap.y);
  await sleep(400);
  eq(await page.evaluate(() => document.getElementById("np").classList.contains("open")), true, "点歌词区域不会误退出");

  console.log("=== 3. 冷启动（被杀后台）后点播放键能播 ===");
  await page.evaluate(() => closeNP());          // 收起播放界面，迷你条才点得到
  await sleep(500);
  const cold = await page.evaluate(() => {
    const target = lib[0].items[1].id;
    stopPlayback();
    media = null; pl = []; plIndex = 0; lastIdx = 1; curKey = null;   // 模拟被杀后台后重开
    return { target: target, plLen: pl.length };
  });
  eq(cold.plLen, 0, "冷启动状态：队列为空");
  await page.evaluate(() => { document.getElementById("mini-player").classList.remove("gone"); });
  await page.tap("#mini-play");
  await sleep(1800);
  const afterCold = await page.evaluate(() => ({
    hasMedia: !!media, plLen: pl.length, cur: curKey || "",
    playing: !!(media && !media.paused),
    pausedIcon: document.getElementById("mini-play").innerHTML.indexOf("M7 5h4v14H7z") >= 0,   // 暂停图标的两条竖线
    iconHtml: document.getElementById("mini-play").innerHTML.slice(0, 90),
    wantHtml: svgPause().slice(0, 90),
  }));
  ok(afterCold.hasMedia, "点播放键后建立了音频对象");
  ok(afterCold.plLen === 3, "自动用当前歌单恢复了播放队列", String(afterCold.plLen));
  eq(afterCold.cur, cold.target, "从上次播放到的位置继续（第 2 首）");
  ok(afterCold.pausedIcon, "迷你条按钮切换成暂停图标（正在播放）", JSON.stringify({ html: afterCold.iconHtml }));
  await shot(page, "71-cold-start-play");

  /* ================= 页面 B：原生模式（解码中提示 + 通知栏/锁屏通道） ================= */
  console.log("=== 4. 原生模式：切歌「解码中」提示 + 播放状态/命令通道 ===");
  const srvInfo = await startServer();
  const page2 = await browser.newPage();
  await page2.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page2.on("pageerror", e => errors.push("pageerror2: " + e.message.slice(0, 160)));
  await page2.evaluateOnNewDocument((base) => {
    window.__HIBIKI_BOOT__ = { base: base };
    window.__playerCalls = [];
    const reply = (id, okk, json) => setTimeout(() => window.__hbpBridgeResult(id, okk, json), 15);
    window.AndroidBridge = {
      call(method, requestId, payload) {
        if (method === "playerState") {
          window.__playerCalls.push(JSON.parse(payload || "{}"));
          return reply(requestId, true, JSON.stringify("ok"));
        }
        if (method === "importedAudio") {
          return reply(requestId, true, JSON.stringify([{ id: "ac3_1", name: "dolby-track.ac3", size: 4096 }]));
        }
        if (method === "decodeAudio") {
          let pct = 0;
          const timer = setInterval(() => {
            pct += 25;
            window.__hbdDecodeProgress && window.__hbdDecodeProgress(requestId, Math.min(pct, 99));
            if (pct >= 100) {
              clearInterval(timer);
              reply(requestId, true, JSON.stringify({ key: "k1", rate: 48000, channels: 2, bytes: 4096, codec: "eac3", layout: "立体声", duration: 2 }));
            }
          }, 220);
          return;
        }
        if (method === "probeAudio") return reply(requestId, true, JSON.stringify({ codec: "eac3", channels: 2, rate: 48000, duration: 2 }));
        return reply(requestId, true, JSON.stringify({}));
      }
    };
  }, srvInfo.base);
  await page2.goto(URL, { waitUntil: "load" });
  await sleep(1400);
  const nativeReady = await page2.evaluate(() => ({ native: NATIVE, base: BOOT && BOOT.base, tracks: songUniverse().length, busyHidden: document.getElementById("np-busy").classList.contains("hidden") }));
  ok(nativeReady.native, "页面处于原生模式（桥已注入）", JSON.stringify(nativeReady));
  ok(nativeReady.tracks >= 1, "原生登记表里的 .ac3 曲目已进资料库", String(nativeReady.tracks));
  ok(nativeReady.busyHidden, "默认不显示「解码中」提示");
  await page2.evaluate(() => {
    const p = { id: "plA", name: "杜比测试", coverMode: "first", coverImageId: null, items: [{ id: "ac3_1", name: "dolby-track.ac3", dur: null }] };
    lib.push(p); curPlId = p.id; saveLib(); renderLibrary();
    openDetail(p.id);
  });
  await sleep(600);
  await page2.evaluate(() => { playFromItems("plA", "ac3_1"); openNP(); });
  await sleep(420);
  const busyState = await page2.evaluate(() => ({
    shown: !document.getElementById("np-busy").classList.contains("hidden"),
    text: document.getElementById("np-busy-text").textContent,
    npOpen: document.getElementById("np").classList.contains("open"),
  }));
  ok(busyState.npOpen, "播放界面已打开（前置）");
  ok(busyState.shown, "切到需要解码的曲目后，播放界面显示「解码中」", JSON.stringify(busyState));
  ok(/解码中/.test(busyState.text), "提示文案包含「解码中」", busyState.text);
  ok(/EAC3|AC3/.test(busyState.text), "提示里带上编码名", busyState.text);
  await shot(page2, "72-np-decoding");
  await sleep(3200);
  const doneState = await page2.evaluate(() => ({
    hidden: document.getElementById("np-busy").classList.contains("hidden"),
    curKey: curKey || "",
    hasMedia: !!media,
    playing: !!(media && !media.paused),
    calls: window.__playerCalls.slice(-3),
  }));
  ok(doneState.hidden, "解码完成后提示自动消失");
  eq(doneState.curKey, "ac3_1", "解码完成后开始播放该曲目");
  ok(doneState.hasMedia && doneState.playing, "确实在播放（媒体对象已建立并播放）", JSON.stringify(doneState));
  ok(doneState.calls.length > 0, "播放状态已上报原生（playerState）", JSON.stringify(doneState.calls));
  const reported = doneState.calls[doneState.calls.length - 1] || {};
  ok(!!reported.title && reported.playing === true, "上报内容含标题与播放中标记", JSON.stringify(reported));
  ok(typeof reported.cover === "string" && reported.cover.indexOf("/cover/") >= 0, "上报内容含通知栏封面地址", String(reported.cover).slice(0, 70));
  const cmdPause = await page2.evaluate(async () => {
    window.__hbdPlayerCmd("pause");
    await new Promise(r => setTimeout(r, 250));
    return !!(media && media.paused);
  });
  ok(cmdPause, "锁屏「暂停」命令生效");
  const cmdPlay = await page2.evaluate(async () => {
    window.__hbdPlayerCmd("play");
    await new Promise(r => setTimeout(r, 300));
    return !!(media && !media.paused);
  });
  ok(cmdPlay, "锁屏「播放」命令生效");
  const cmdToggle = await page2.evaluate(async () => {
    window.__hbdPlayerCmd("toggle");
    await new Promise(r => setTimeout(r, 250));
    return !!(media && media.paused);
  });
  ok(cmdToggle, "锁屏「播放/暂停」切换生效");

  console.log("=== 5. 锁屏进度条拖动 + 本地内嵌封面直传 ===");
  const seekCmd = await page2.evaluate(async () => {
    window.__hbdPlayerCmd("play");
    await new Promise(r => setTimeout(r, 200));
    window.__hbdPlayerCmd("seek:1.25");            // 原生 onSeekTo 折算出的命令格式
    await new Promise(r => setTimeout(r, 250));
    return {
      t: media ? media.currentTime : -1,
      dur: (media && isFinite(media.duration)) ? media.duration : 0,
      playing: !!(media && !media.paused),
    };
  });
  ok(seekCmd.dur > 1.5, "可 seek 的音频已就绪（时长 " + Math.round(seekCmd.dur * 100) / 100 + "s）", JSON.stringify(seekCmd));
  ok(Math.abs(seekCmd.t - 1.25) < 0.4, "锁屏进度条 seek 命令跳到指定位置（" + Math.round(seekCmd.t * 100) / 100 + "s）", JSON.stringify(seekCmd));

  const coverRes = await page2.evaluate(async () => {
    // 造一张「内嵌封面」（页面读到的标签封面就是 data URL），塞进元数据缓存
    const cv = document.createElement("canvas");
    cv.width = 96; cv.height = 96;
    const g = cv.getContext("2d");
    g.fillStyle = "#3366cc"; g.fillRect(0, 0, 96, 96);
    const small = cv.toDataURL("image/png");
    metaCache.set("ac3_1", { title: "封面测试", artist: "UP", album: "", cover: small, loaded: true });
    npCoverBig = ""; npCoverBigFor = ""; npCoverBigTried = ""; npCoverBigBusy = ""; npCoverBigSent = "";
    reportPlayerState();
    await new Promise(r => setTimeout(r, 600));    // 下采样是异步的，完成后会补报一次
    const calls = window.__playerCalls;
    const withData = calls.filter(c => c.coverData && c.coverData.indexOf("data:image/jpeg") === 0);
    const n = calls.length;
    reportPlayerState();                           // 再上报一次：同一首不该重复传图
    await new Promise(r => setTimeout(r, 300));
    const again = window.__playerCalls.slice(n).filter(c => c.coverData);
    return { count: withData.length, size: (withData[withData.length - 1] || {}).coverData.length || 0, again: again.length };
  });
  ok(coverRes.count >= 1, "本地文件的内嵌封面已下采样后直传原生", JSON.stringify(coverRes));
  ok(coverRes.size > 200 && coverRes.size < 400000, "封面体积适合走 Intent 传输（" + Math.round(coverRes.size / 1024) + " KB）", String(coverRes.size));
  eq(coverRes.again, 0, "同一首曲目不会每 5 秒重复传图");

  ok(errors.length === 0, "全程无 JS 错误", errors.slice(0, 3).join(" | "));
  console.log("");
  console.log("通过 " + passed + " / " + (passed + failed));
  if (failed) console.log("失败：" + failures.join("; "));
  await browser.close();
  srvInfo.srv.close();
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });

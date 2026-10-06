// 杜比 / DTS 解码链路验证：模拟原生桥 + 真实 5.1 PCM 服务（Range）
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const CHROME = process.env.CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const WWW = path.resolve(__dirname, "..", "www", "index.html");
const FIXTURES = path.resolve(__dirname, "fixtures");
const SHOTS = path.resolve(__dirname, "screenshots");
const PORT = 39881;
// 「杜比下载成品」夹具：E-AC-3 码流 + covr 封面 + 中文标签的 MP4（由 verify-dolby-mux.js 用与 App 相同的参数生成）
const M4A_FIX = path.join(FIXTURES, "dolby-eac3-mp4.m4a");
if (!fs.existsSync(M4A_FIX)) {
  console.log("（缺少杜比 MP4 夹具，先运行 verify-dolby-mux.js 生成）");
  try { require("child_process").execFileSync(process.execPath, [path.join(__dirname, "verify-dolby-mux.js")], { stdio: "inherit" }); } catch (e) {}
  if (!fs.existsSync(M4A_FIX)) { console.log("无法生成夹具，测试中止"); process.exit(2); }
}
const M4A_SIZE = fs.statSync(M4A_FIX).size;

let passed = 0, failed = 0;
const failures = [];
const ok = (c, name, extra) => {
  if (c) { passed++; console.log("  \u2713 " + name); }
  else { failed++; failures.push(name); console.log("  \u2717 FAIL: " + name + (extra !== undefined ? "  \u2014 " + extra : "")); }
};
const eq = (a, b, name) => ok(a === b, name + (a === b ? "" : "  (got=" + JSON.stringify(a) + " want=" + JSON.stringify(b) + ")"));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = (page, n) => page.screenshot({ path: path.join(SHOTS, n + ".png") }).catch(() => {});
// 把元素滚到视口中央再点击：避免被固定在底部的迷你播放条 / 标签栏遮挡
async function tapCentered(page, sel) {
  await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "center" });
  }, sel);
  await sleep(200);
  await page.tap(sel);
}

async function waitFor(page, fn, timeout = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await page.evaluate(fn)) return true; await sleep(80); }
  return false;
}

function parseRange(header, size) {
  const spec = header.replace("bytes=", "").split(",")[0].trim();
  const dash = spec.indexOf("-");
  if (dash < 0) return null;
  const s = spec.slice(0, dash).trim(), e = spec.slice(dash + 1).trim();
  let start = 0, end = size - 1;
  if (s !== "") {
    start = parseInt(s, 10);
    if (e !== "") end = Math.min(parseInt(e, 10), size - 1);
    if (start > end || start >= size) return null;
  } else if (e !== "") {
    const n = parseInt(e, 10);
    if (n <= 0) return null;
    start = Math.max(0, size - n);
  } else return null;
  return [start, end];
}

const rangeLog = [];
const server = http.createServer((req, res) => {
  const p = new URL(req.url, "http://127.0.0.1").pathname;
  if (p === "/" || p === "/index.html") {
    const data = fs.readFileSync(WWW);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": data.length, "Cache-Control": "no-store" });
    return res.end(data);
  }
  if (p.startsWith("/decoded/")) {
    const key = p.slice("/decoded/".length);
    const file = path.join(FIXTURES, key === "k2" ? "decoded-2ch.wav" : "decoded-51.wav");
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    const size = fs.statSync(file).size;
    let start = 0, end = size - 1, partial = false;
    if (req.headers.range) {
      rangeLog.push(req.headers.range);
      const pr = parseRange(req.headers.range, size);
      if (!pr) { res.writeHead(416, { "Content-Range": "bytes */" + size }); return res.end(); }
      start = pr[0]; end = pr[1]; partial = true;
    }
    res.writeHead(partial ? 206 : 200, {
      "Content-Type": "audio/wav", "Content-Length": end - start + 1, "Accept-Ranges": "bytes",
      ...(partial ? { "Content-Range": "bytes " + start + "-" + end + "/" + size } : {}),
      "Cache-Control": "no-store",
    });
    if (req.method === "HEAD") return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  if (p.startsWith("/audio/")) {
    const id = decodeURIComponent(p.slice("/audio/".length));
    const name = id === "ac3a" ? "tone-51.ac3"
      : (id === "dolbymp4" ? "tone-51.eac3"
      : (id === "dolbym4a" ? "dolby-eac3-mp4.m4a"
      : (id === "norm2" ? "song2-48000.wav" : "song1-44100.wav")));
    const file = path.join(FIXTURES, name);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    const size = fs.statSync(file).size;
    let start = 0, end = size - 1, partial = false;
    if (req.headers.range) {
      rangeLog.push(req.headers.range);
      const pr = parseRange(req.headers.range, size);
      if (!pr) { res.writeHead(416, { "Content-Range": "bytes */" + size }); return res.end(); }
      start = pr[0]; end = pr[1]; partial = true;
    }
    res.writeHead(partial ? 206 : 200, {
      "Content-Type": name.endsWith(".wav") ? "audio/wav" : (id === "dolbymp4" ? "audio/mp4" : (id === "dolbym4a" ? "audio/mp4" : "audio/ac3")),
      "Content-Length": end - start + 1, "Accept-Ranges": "bytes",
      ...(partial ? { "Content-Range": "bytes " + start + "-" + end + "/" + size } : {}),
      "Cache-Control": "no-store",
    });
    if (req.method === "HEAD") return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(404); res.end();
});

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await new Promise(r => server.listen(PORT, "127.0.0.1", r));

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errors = [];
  page.on("console", m => { if (m.type() === "error" && !/416/.test(m.text())) errors.push(m.text().slice(0, 140)); });
  page.on("pageerror", e => errors.push("pageerror: " + e.message.slice(0, 160)));

  // 模拟原生桥（含解码能力）
  await page.evaluateOnNewDocument((m4aSize) => {
    window.__decodeCalls = [];
    window.__cancelCalls = 0;
    window.__callLog = [];
    const logCall = (m, extra) => window.__callLog.push(Math.round(performance.now()) + " " + m + (extra ? " " + extra : ""));
    window.__mock = {
      delayMs: 350,
      slowIds: {},
      failIds: {},
      pickEntries: [
        { id: "ac3a", name: "tone-51.ac3", size: 168448 },
        { id: "norm", name: "song1-44100.wav", size: 1058478 },
        { id: "norm2", name: "song2-48000.wav", size: 384078 },
        // B 站杜比下载的容器形态：E-AC-3 装在 .mp4 里（扩展名看不出编码）
        { id: "dolbymp4", name: "dolby-atmos.mp4", size: 471520 },
        // 真实下载成品：E-AC-3 + 内嵌封面 + 中文标签（保存到手机时用 .m4a 文件名）
        { id: "dolbym4a", name: "杜比成品.m4a", size: m4aSize },
      ],
    };
    const reply = (id, okk, json) => setTimeout(() => window.__hbpBridgeResult(id, okk, json), 5);
    window.AndroidBridge = {
      call(method, requestId, payload) {
        let p = {};
        try { p = payload ? JSON.parse(payload) : {}; } catch (e) {}
        if (method === "importedAudio") return reply(requestId, true, "[]");
        if (method === "pickAudioFiles")
          return reply(requestId, true, JSON.stringify({ entries: window.__mock.pickEntries, lrc: {} }));
        if (method === "pickAudioFolder") return reply(requestId, true, JSON.stringify({ entries: [], lrc: {} }));
        if (method === "pickImage") return reply(requestId, true, JSON.stringify({ id: "img_x", name: "x.jpg" }));
        if (method === "readTextFile") return reply(requestId, true, JSON.stringify({ name: "x.lrc", content: "" }));
        if (method === "probeAudio") {
          // .mp4 容器里装的是 E-AC-3（杜比全景声），扩展名看不出来，只由探测结果决定
          const codec = (p.id === "dolbymp4" || p.id === "dolbym4a") ? "eac3" : "ac3";
          return reply(requestId, true, JSON.stringify({ codec: codec, channels: 6, layout: "5.1(side)", rate: 48000, duration: 3.0 }));
        }
        if (method === "cancelDecode") { window.__cancelCalls++; logCall("cancelDecode"); return reply(requestId, true, "{}"); }
        if (method === "decodeAudio") {
          const ch = p.channels | 0;
          window.__decodeCalls.push({ id: p.id, channels: ch });
          logCall("decodeAudio", p.id + " ac=" + ch + (window.__mock.slowIds[p.id] ? " (slow)" : ""));
          const slow = window.__mock.slowIds[p.id];
          const delay = slow ? 5000 : window.__mock.delayMs;
          setTimeout(() => {
            if (window.__mock.failIds[p.id]) return reply(requestId, false, "解码失败：unsupported codec");
            const two = ch === 2;
            reply(requestId, true, JSON.stringify({
              key: two ? "k2" : "k0",
              url: "/decoded/" + (two ? "k2" : "k0"),
              channels: two ? 2 : 6,
              rate: 48000,
              bytes: two ? 576044 : 1728044,
              duration: 3.0,
              codec: "ac3",
              layout: "5.1(side)",
              sourceChannels: 6,
              target: ch,
            }));
          }, slow ? delay : delay);
          return;
        }
        return reply(requestId, false, "unknown " + method);
      },
    };
  }, M4A_SIZE);

  await page.goto("http://127.0.0.1:" + PORT + "/", { waitUntil: "load" });
  await sleep(900);

  console.log("=== 1. 导入杜比格式 ===");
  await page.tap("#lib-empty-new"); await sleep(300);
  await page.type("#dialog-input", "杜比测试"); await page.tap("#dialog-ok"); await sleep(400);
  // 走原生桥导入（与真实 App 一致；uploadFile 会走浏览器回退路径）
  await page.evaluate(() => doImportFiles());
  await sleep(1200);
  eq(await page.$$eval("#detail-list li[data-id]", e => e.length), 5, "导入 5 首（含 AC-3、.mp4 里的杜比、带封面的杜比 m4a）");
  eq(await page.evaluate(() => document.querySelector("#detail-list li[data-id]").dataset.id), "ac3a", "曲目 id 来自原生注册表");
  ok(await page.$eval("#detail-list li .fmt-tag", e => e.textContent) === "AC3", "AC-3 行显示编码标签");

  console.log("=== 2. 点击 AC-3 → 触发解码播放 ===");
  await page.evaluate(() => document.querySelectorAll("#detail-list li[data-id]")[0].click());
  await sleep(150);
  const busyShown = await page.evaluate(() => {
    const row = document.querySelector("#detail-list li[data-id]");
    return row.querySelector(".song-dur").textContent;
  });
  eq(busyShown, "解码…", "解码期间行内显示「解码…」");
  ok(await waitFor(page, () => !document.getElementById("mini-player").classList.contains("gone"), 6000), "解码完成后开始播放");
  await sleep(1200);
  const calls = await page.evaluate(() => window.__decodeCalls);
  eq(calls.length, 1, "只调用一次 decodeAudio");
  eq(calls[0].channels, 0, "首轮按原始声道布局解码（channels=0）");

  console.log("=== 3. 多声道输出与运行时信息 ===");
  const info = await page.evaluate(() => ({
    note: window.lastLayoutNote,
    rate: window.audioCtx ? window.audioCtx.sampleRate : 0,
    axis: document.getElementById("np-viz-axis").textContent,
    dur: document.querySelector("#detail-list li[data-id] .song-dur").textContent,
    destCh: window.audioCtx ? window.audioCtx.destination.channelCount : 0,
  }));
  eq(info.rate, 48000, "音频上下文按解码文件采样率重建（48 kHz）");
  eq(info.axis, "0–24 kHz", "频谱上限跟随采样率（24 kHz）");
  eq(info.dur, "0:03", "时长由 PCM 体积换算（3 秒）");
  ok(/5\.1/.test(info.note), "声道去向说明包含 5.1", info.note);
  const devMax = await page.evaluate(() => (window.audioCtx && window.audioCtx.destination.maxChannelCount) || 2);
  eq(info.destCh, Math.min(6, devMax), "输出声道数 = min(源声道, 设备能力)",
    "dest=" + info.destCh + " 设备=" + devMax);
  if (devMax < 6) {
    ok(/下混/.test(info.note), "设备不足时说明已下混（当前设备 " + devMax + " 声道）", info.note);
  } else {
    ok(/直出/.test(info.note), "设备支持时多声道直出", info.note);
  }
  await shot(page, "dolby-01-playing");

  console.log("=== 4. 播放控制（解码后的 PCM 走本地服务） ===");
  const w1 = await page.$eval("#mini-progress-fill", e => parseFloat(e.style.width));
  await sleep(700);
  const w2 = await page.$eval("#mini-progress-fill", e => parseFloat(e.style.width));
  ok(w2 > w1, "进度前进", w1 + " → " + w2);
  await page.evaluate(() => document.getElementById("mini-art").click());
  await sleep(600);
  await page.evaluate(() => {
    const bar = document.getElementById("np-seek");
    const r = bar.getBoundingClientRect();
    const x = r.left + r.width * 0.5, y = r.top + r.height / 2;
    bar.dispatchEvent(new PointerEvent("pointerdown", { clientX: x, clientY: y, bubbles: true, pointerId: 5 }));
    bar.dispatchEvent(new PointerEvent("pointerup", { clientX: x, clientY: y, bubbles: true, pointerId: 5 }));
  });
  await sleep(300);
  const fill = await page.$eval("#np-seek-fill", e => parseFloat(e.style.width));
  ok(fill > 40 && fill < 62, "拖动进度条跳转（PCM 支持 Range）", "fill=" + fill);
  ok(rangeLog.length > 0, "服务端收到 Range 请求", "count=" + rangeLog.length);
  eq(await page.evaluate(() => document.getElementById("np-play").innerHTML.indexOf("M7 5h4") >= 0), true, "播放中图标为暂停态");
  await page.$eval("#np-close", b => b.click()); await sleep(600);   // 等播放界面收起动画结束

  console.log("=== 5. 解码缓存（切回不重复解码） ===");
  await page.evaluate(() => document.querySelectorAll("#detail-list li[data-id]")[1].click());
  await sleep(1500);
  await page.evaluate(() => document.querySelectorAll("#detail-list li[data-id]")[0].click());
  await sleep(1500);
  const calls2 = await page.evaluate(() => window.__decodeCalls);
  eq(calls2.length, 1, "再次播放同一杜比曲目不重复解码");
  ok(await page.evaluate(() => !document.getElementById("mini-player").classList.contains("gone")), "缓存命中后可正常播放");

  console.log("=== 6. 输出方式：原生输出 / 下混输出（分段控件） ===");
  await page.tap("#tabbar .tab[data-page='settings']"); await sleep(400);
  await tapCentered(page, "#dolby-seg button[data-mode='device']"); await sleep(400);
  const modeUI = await page.evaluate(() => ({
    deviceOn: document.querySelector("#dolby-seg button[data-mode='device']").classList.contains("on"),
    nativeOn: document.querySelector("#dolby-seg button[data-mode='native']").classList.contains("on"),
    cur: document.getElementById("dolby-cur").textContent,
    note: document.getElementById("dolby-note").textContent,
    mode: dolbyMode,
  }));
  ok(modeUI.deviceOn && !modeUI.nativeOn, "「下混输出」被选中（分段控件）", JSON.stringify(modeUI));
  eq(modeUI.cur, "下混输出", "标题栏文案同步为下混输出");
  eq(modeUI.mode, "device", "内部模式切换为 device");
  ok(/输出设备/.test(modeUI.note), "设置页显示当前输出设备", modeUI.note);
  await shot(page, "dolby-02-settings");
  // 再次播放同一曲目：应重新解码（按设备声道）
  await page.tap("#tabbar .tab[data-page='library']"); await sleep(300);
  await page.evaluate(() => document.querySelectorAll("#detail-list li[data-id]")[1].click());
  await sleep(800);
  await page.evaluate(() => document.querySelectorAll("#detail-list li[data-id]")[0].click());
  await sleep(2000);
  await sleep(1500);
  const calls3 = await page.evaluate(() => window.__decodeCalls);
  const maxCh = await page.evaluate(() => (window.audioCtx && window.audioCtx.destination.maxChannelCount) || 2);
  ok(calls3.length >= 3, "切换输出模式后按新模式重新解码", "calls=" + calls3.length);
  const lastCall = calls3[calls3.length - 1];
  eq(lastCall.channels, maxCh, "二次解码使用设备声道数（多声道降混）", JSON.stringify(calls3));
  console.log("      设备 maxChannelCount =", maxCh, " 末次解码 channels =", lastCall.channels);
  // 回到「原生输出」（此时在资料库页，设置项不可见 → 用 DOM 点击）
  await page.evaluate(() => document.querySelector("#dolby-seg button[data-mode='native']").click());
  await sleep(400);
  eq(await page.evaluate(() => dolbyMode), "native", "输出模式切回原生输出");
  eq(await page.evaluate(() => document.getElementById("dolby-cur").textContent), "原生输出", "文案同步为原生输出");

  console.log("=== 7. 音频数据面板显示解码信息（分类列表 ⋯ 菜单） ===");
  // 歌单行内 ⋯ 已移除：改为在「歌曲」分类列表里对该曲目查看音频数据
  // （不依赖当前播放曲目，杜比测试曲目只有 3 秒，播完会自动切歌）
  await page.tap("#tabbar .tab[data-page='library']");
  await sleep(400);
  await page.tap('#lib-seg button[data-tab="songs"]');
  await sleep(1000);
  const ac3RowFound = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("#lib-songs li[data-id]"));
    const row = rows.filter(r => (r.querySelector(".fmt-tag") || {}).textContent === "AC3")[0];
    if (!row) return false;
    row.querySelector(".song-menu-btn").click();
    return true;
  });
  ok(ac3RowFound, "歌曲分类列表可按格式标签定位杜比曲目");
  await sleep(500);
  await page.evaluate(() => {
    const items = Array.prototype.slice.call(document.querySelectorAll("#menu-items .menu-item"));
    const ai = items.filter(i => i.textContent.indexOf("音频数据") >= 0)[0];
    if (ai) ai.click();
  });
  await sleep(700);
  const aiText = await page.$$eval("#menu-items .ai-row", els => els.map(e => e.textContent));
  console.log("    面板内容:", aiText.join(" | "));
  const decRow = aiText.filter(t => t.indexOf("解码输出") >= 0)[0] || "";
  ok(/AC3|AC-3/.test(decRow) && /PCM/.test(decRow), "音频数据显示解码输出", decRow);
  await shot(page, "dolby-03-audioinfo");
  await page.evaluate(() => { const c = document.getElementById("menu-cancel"); if (c) c.click(); });
  await sleep(300);

  console.log("=== 8. 解码失败兜底（不卡死、自动跳过） ===");
  await page.evaluate(() => { window.__mock.failIds["ac3a"] = true; window.__mock.delayMs = 200; decodedCache.clear(); });
  await page.evaluate(() => document.querySelectorAll("#detail-list li[data-id]")[1].click());
  await sleep(900);
  await page.evaluate(() => document.querySelectorAll("#detail-list li[data-id]")[0].click());
  await sleep(1600);
  const failToast = await page.$eval("#toast", e => e.textContent);
  ok(/解码失败/.test(failToast), "解码失败给出提示", failToast);
  ok(await page.evaluate(() => !document.getElementById("mini-player").classList.contains("gone")), "失败后自动跳过并继续播放"); 
  await page.evaluate(() => { window.__mock.failIds = {}; });

  console.log("=== 9. 解码中途切歌应取消 ===");
  await page.evaluate(() => { window.__mock.slowIds["ac3a"] = true; decodedCache.clear(); window.__cancelCalls = 0; });
  await page.evaluate(() => document.querySelectorAll("#detail-list li[data-id]")[0].click());
  await sleep(400);
  // 点击「另一首」曲目切歌（点当前曲目只会暂停/继续，按设计不会取消解码）
  await page.evaluate(() => document.querySelectorAll("#detail-list li[data-id]")[2].click());
  await sleep(1500);
  const diag = await page.evaluate(() => ({
    cancelCalls: window.__cancelCalls,
    log: window.__callLog.slice(-12),
    decodingId: window.decodingId,
    startToken: window.startToken,
    curKey: window.curKey,
    slow: window.__mock.slowIds,
  }));
  console.log("      诊断：cancelCalls=" + diag.cancelCalls + " decodingId=" + diag.decodingId +
    " startToken=" + diag.startToken + " curKey=" + diag.curKey + " slow=" + JSON.stringify(diag.slow));
  console.log("      调用日志：" + diag.log.join(" | "));
  ok(diag.cancelCalls >= 1, "切歌时调用 cancelDecode 取消解码", "count=" + diag.cancelCalls);
  ok(await page.evaluate(() => !document.getElementById("mini-player").classList.contains("gone")), "切歌后正常播放新曲目");

  console.log("=== 10. 容器内的特殊编码（B 站杜比下载 = .mp4 里的 E-AC-3） ===");
  const beforeCalls = await page.evaluate(() => window.__decodeCalls.length);
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("#detail-list li[data-id]"));
    const r = rows.filter(x => x.dataset.id === "dolbymp4")[0];
    if (r) r.click();
  });
  await sleep(3000);
  const mp4Calls = await page.evaluate(() => window.__decodeCalls);
  ok(mp4Calls.length === beforeCalls + 1 && mp4Calls[mp4Calls.length - 1].id === "dolbymp4",
    "mp4 容器里的 E-AC-3 自动走内置解码器（不按扩展名判断）",
    JSON.stringify(mp4Calls.slice(-2)));
  const mp4Tag = await page.evaluate(() => {
    const li = Array.from(document.querySelectorAll("#detail-list li[data-id]")).filter(x => x.dataset.id === "dolbymp4")[0];
    return li ? ((li.querySelector(".fmt-tag") || {}).textContent || "") : "(missing)";
  });
  eq(mp4Tag, "EAC3", "行内按容器内编码显示 EAC3 标签");
  ok(await page.evaluate(() => !document.getElementById("mini-player").classList.contains("gone")), "解码后正常播放");
  await shot(page, "dolby-04-mp4-container");

  console.log("=== 11. 杜比下载成品：封面与中文标签就在文件里（.m4a = MP4 容器）===");
  await waitFor(page, () => { const m = metaCache.get("dolbym4a"); return !!(m && m.loaded); }, 9000);
  const m4aMeta = await page.evaluate(() => {
    const m = metaCache.get("dolbym4a") || {};
    const li = Array.from(document.querySelectorAll("#detail-list li[data-id]")).filter(x => x.dataset.id === "dolbym4a")[0];
    return {
      title: m.title || "", artist: m.artist || "", album: m.album || "",
      cover: m.cover ? m.cover.slice(0, 22) : "", coverLen: m.cover ? m.cover.length : 0,
      rowCover: li ? (li.querySelector(".cover").style.backgroundImage || "").slice(0, 22) : "(行缺失)",
    };
  });
  eq(m4aMeta.title, "杜比测试曲目·中文标题", "从 MP4 里读出中文标题（不乱码）");
  eq(m4aMeta.artist, "测试UP主", "读出 UP 主");
  eq(m4aMeta.album, "Bilibili", "读出专辑");
  ok(m4aMeta.cover.indexOf("data:image/jpeg") === 0 && m4aMeta.coverLen > 20000, "封面从 covr 原子读出", m4aMeta.coverLen + "B");
  ok(m4aMeta.rowCover.indexOf("data:image/jpeg") >= 0, "歌曲列表里显示这首歌的封面", m4aMeta.rowCover);
  // 下载完成时 biliAutoAdd 会把编码记进曲目（.m4a 这种扩展名看不出里面是杜比）
  await page.evaluate(() => {
    const item = lib[0].items.filter(x => x.id === "dolbym4a")[0];
    if (item) item.codec = "ec-3";
    markCodec("dolbym4a", "ec-3");
    renderDetail();
  });
  await sleep(250);
  const m4aRow = await page.evaluate(() => {
    const li = Array.from(document.querySelectorAll("#detail-list li[data-id]")).filter(x => x.dataset.id === "dolbym4a")[0];
    return { tag: li ? ((li.querySelector(".fmt-tag") || {}).textContent || "") : "(行缺失)", special: isSpecialTrack("dolbym4a") };
  });
  eq(m4aRow.tag, "EAC3", "行内显示 EAC3 标签（.m4a 里其实是杜比）");
  ok(m4aRow.special, "仍走内置解码器（按记录的编码判断，不看扩展名）");
  const before4 = await page.evaluate(() => window.__decodeCalls.length);
  await page.evaluate(() => {
    const li = Array.from(document.querySelectorAll("#detail-list li[data-id]")).filter(x => x.dataset.id === "dolbym4a")[0];
    if (li) li.click();
  });
  await sleep(2600);
  const calls4 = await page.evaluate(() => window.__decodeCalls);
  ok(calls4.length === before4 + 1 && calls4[calls4.length - 1].id === "dolbym4a", "点击后自动解码播放（杜比 5.1）",
    JSON.stringify(calls4.slice(-2)));
  await shot(page, "dolby-05-m4a-cover");

  console.log("\n========== 杜比/DTS 解码验证: " + passed + " 通过, " + failed + " 失败 ==========");
  if (errors.length) { console.log("JS 错误:"); errors.forEach(e => console.log("   " + e)); }
  ok(errors.length === 0, "全程无 JS 错误", errors.slice(0, 2).join(" | "));
  if (failures.length) { console.log("失败项:"); failures.forEach(f => console.log("  - " + f)); }
  await browser.close();
  server.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("测试异常:", e); try { server.close(); } catch (x) {} process.exit(2); });

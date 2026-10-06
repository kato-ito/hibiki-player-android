// 安卓模式验证：本地 HTTP 服务器（Range 支持）+ 模拟 AndroidBridge
// 复刻 LocalHttpServer.kt 的行为，验证页面在 NATIVE 模式下的完整链路
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const CHROME = process.env.CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const WWW = path.resolve(__dirname, "..", "www", "index.html");
const FIXTURES = path.resolve(__dirname, "fixtures");

// id -> fixture file（模拟注册表）
const REG = {
  "a1": "song1-44100.wav",
  "a2": "song2-48000.wav",
  "a3": "song4-tagged.mp3",
  "a4": "song5-tagged.flac",
  "a5": "song6-tagged.m4a",
  "a6": "tone-51.eac3",          // 模拟 B 站杜比下载的裸流（文件本身没有标签）
};
const LRC = {
  "song2": "[00:00.50]安卓桥歌词第一行\n[00:01.50]安卓桥歌词第二行\n[00:02.50]安卓桥歌词第三行",
};
const rangeLog = [];

function contentTypeFor(name) {
  const ext = (name.match(/\.([^.]+)$/) || [])[1] || "";
  return ({ mp3: "audio/mpeg", flac: "audio/flac", wav: "audio/wav", m4a: "audio/mp4", mp4: "video/mp4", ogg: "audio/ogg", png: "image/png", jpg: "image/jpeg" })[ext] || "application/octet-stream";
}

function parseRange(header, size) {
  const spec = header.replace("bytes=", "").split(",")[0].trim();
  const dash = spec.indexOf("-");
  if (dash < 0) return null;
  const s = spec.slice(0, dash).trim();
  const e = spec.slice(dash + 1).trim();
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const p = url.pathname;
  const sendError = (code, msg) => {
    res.writeHead(code, { "Content-Type": "text/plain" });
    res.end(msg);
  };
  if (p === "/" || p === "/index.html") {
    const data = fs.readFileSync(WWW);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": data.length, "Cache-Control": "no-store" });
    res.end(data);
    return;
  }
  if (p.startsWith("/image/")) {
    const img = fs.readFileSync(path.resolve(__dirname, "bg.jpg"));
    res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": img.length, "Cache-Control": "no-store" });
    res.end(img);
    return;
  }
  if (p.startsWith("/audio/")) {
    const id = decodeURIComponent(p.slice("/audio/".length));
    const name = REG[id];
    if (!name) return sendError(404, "Not Found");
    const file = path.join(FIXTURES, name);
    const size = fs.statSync(file).size;
    const rangeH = req.headers.range;
    let start = 0, end = size - 1, partial = false;
    if (rangeH) {
      rangeLog.push(rangeH);
      const pr = parseRange(rangeH, size);
      if (!pr) {
        res.writeHead(416, { "Content-Range": "bytes */" + size });
        return res.end();
      }
      [start, end] = pr;
      partial = true;
    }
    const length = end - start + 1;
    res.writeHead(partial ? 206 : 200, {
      "Content-Type": contentTypeFor(name),
      "Content-Length": length,
      "Accept-Ranges": "bytes",
      ...(partial ? { "Content-Range": "bytes " + start + "-" + end + "/" + size } : {}),
      "Cache-Control": "no-store",
      "Connection": "close",
    });
    if (req.method === "HEAD") { res.end(); return; }
    const stream = fs.createReadStream(file, { start, end });
    stream.pipe(res);
    return;
  }
  sendError(404, "Not Found");
});

let passed = 0, failed = 0;
const failures = [];
const ok = (cond, name, extra) => {
  if (cond) { passed++; console.log("  \u2713 " + name); }
  else { failed++; failures.push(name); console.log("  \u2717 FAIL: " + name + (extra !== undefined ? " \u2014 " + extra : "")); }
};
const eq = (a, b, name) => ok(a === b, name + " (got=" + JSON.stringify(a) + " want=" + JSON.stringify(b) + ")");
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  await new Promise(res => server.listen(39876, "127.0.0.1", res));
  console.log("本地服务器: http://127.0.0.1:39876/");

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errors = [];
  page.on("console", m => {
    if (m.type() !== "error") return;
    // 416 来自测试自身对非法 Range 的探测，属预期
    if (/416/.test(m.text())) return;
    errors.push("[console.error] " + m.text());
  });
  page.on("pageerror", e => errors.push("[pageerror] " + e.message));
  page.on("requestfailed", r => {
    const u = r.url();
    if (/favicon/.test(u)) return;
    if (/^blob:/.test(u)) return;
    // 切歌时旧媒体请求被主动中断（ERR_ABORTED）属于正常行为
    if (r.failure() && r.failure().errorText === "net::ERR_ABORTED") return;
    errors.push("[requestfailed] " + u + " " + (r.failure() && r.failure().errorText));
  });

  // 模拟 AndroidBridge（页面加载前注入）
  await page.evaluateOnNewDocument(() => {
    const REG = { a1: "song1-44100.wav", a2: "song2-48000.wav", a3: "song4-tagged.mp3", a4: "song5-tagged.flac", a5: "song6-tagged.m4a" };
    const LRC = { song2: "[00:00.50]安卓桥歌词第一行\n[00:01.50]安卓桥歌词第二行\n[00:02.50]安卓桥歌词第三行" };
    window.__bridge = {
      reg: { a1: "song1-44100.wav", a2: "song2-48000.wav", a3: "song4-tagged.mp3", a4: "song5-tagged.flac", a5: "song6-tagged.m4a" },
      lrc: { "song2-48000": "[00:00.50]安卓桥歌词第一行\n[00:01.50]安卓桥歌词第二行\n[00:02.50]安卓桥歌词第三行" },
    };
    window.AndroidBridge = {
      call(method, requestId, payload) {
        setTimeout(() => {
          try {
            let p = {};
            try { p = payload ? JSON.parse(payload) : {}; } catch (e) { p = {}; }
            if (method === "importedAudio") {
              const entries = Object.keys(window.__bridge.reg).map(id => ({ id, name: window.__bridge.reg[id], size: 100000 }));
              window.__hbpBridgeResult(requestId, true, JSON.stringify(entries));
            } else if (method === "pickAudioFiles") {
              const entries = [
                { id: "a3", name: "song4-tagged.mp3", size: 100000 },
                { id: "a4", name: "song5-tagged.flac", size: 100000 },
                { id: "a2", name: "song2-48000.wav", size: 100000 },
              ];
              window.__hbpBridgeResult(requestId, true, JSON.stringify({ entries, lrc: { "song2-48000": window.__bridge.lrc["song2-48000"] } }));
            } else if (method === "trackMeta") {
              // 原生侧记录的应用内标签（裸流下载：封面与标签存在应用内，不在文件里）
              window.__hbpBridgeResult(requestId, true, JSON.stringify(
                p && p.id === "a6"
                  ? { title: "杜比测试曲目", artist: "测试UP主", album: "Bilibili", coverUrl: "/cover/a6" }
                  : {}
              ));
            } else if (method === "readTextFile") {
              window.__hbpBridgeResult(requestId, true, JSON.stringify({ name: "x.lrc", content: window.__bridge.lrc["song2-48000"] }));
            } else if (method === "pickImage") {
              window.__hbpBridgeResult(requestId, true, JSON.stringify({ id: "img_1", name: "cover.jpg" }));
            } else if (method === "pickAudioFolder") {
              window.__hbpBridgeResult(requestId, true, JSON.stringify({ entries: [{ id: "a5", name: "song6-tagged.m4a", size: 100000 }], lrc: {} }));
            } else {
              window.__hbpBridgeResult(requestId, false, "unknown " + method);
            }
          } catch (e) {
            window.__hbpBridgeResult(requestId, false, String(e && e.message));
          }
        }, 30);
      },
    };
  });

  console.log("=== 1. 安卓模式启动（桥模式检测） ===");
  await page.goto("http://127.0.0.1:39876/", { waitUntil: "load" });
  await sleep(1200);
  const nativeDetected = await page.evaluate(() => window.NATIVE === true);
  ok(nativeDetected, "检测到安卓桥");
  const bootBase = await page.evaluate(() => window.BOOT && window.BOOT.base);
  eq(bootBase, "http://127.0.0.1:39876", "BOOT.base 来自 origin");

  console.log("=== 2. 新建歌单 → 桥导入（含 LRC 配对） ===");
  await page.tap("#lib-empty-new");
  await sleep(300);
  await page.type("#dialog-input", "安卓测试");
  await page.tap("#dialog-ok");
  await sleep(400);
  await page.tap("#detail-import");
  await sleep(1200);
  eq(await page.$$eval("#detail-list li[data-id]", els => els.length), 3, "桥导入 3 首");
  const lrcPaired = await page.evaluate(() => {
    const ids = Array.from(document.querySelectorAll("#detail-list li[data-id]")).map(li => li.dataset.id);
    for (const id of ids) {
      const t = window.lrcLib.get(id);
      if (t) return t;
    }
    return "";
  });
  ok(lrcPaired.indexOf("安卓桥歌词") >= 0, "同名 .lrc 自动配对");

  console.log("=== 3. HTTP 播放（时长探测走 Range） ===");
  await sleep(2500);
  const durs = await page.$$eval("#detail-list .song-dur", els => els.map(e => e.textContent).filter(Boolean).length);
  ok(durs >= 2, "时长探测（HTTP）", "durs=" + durs);
  await page.evaluate(() => document.querySelectorAll("#detail-list li[data-id]")[0].click());
  await sleep(2000);
  ok(await page.evaluate(() => !document.getElementById("mini-player").classList.contains("gone")), "迷你条出现");
  const w1 = await page.$eval("#mini-progress-fill", el => el.style.width);
  await sleep(1000);
  const w2 = await page.$eval("#mini-progress-fill", el => el.style.width);
  ok(parseFloat(w2) > parseFloat(w1), "HTTP 播放进度前进", w1 + "->" + w2);

  console.log("=== 4. 进度条跳转 + 服务端 Range 正确性 ===");
  await page.evaluate(() => document.getElementById("mini-art").click());
  await sleep(500);
  await page.evaluate(() => {
    const bar = document.getElementById("np-seek");
    const r = bar.getBoundingClientRect();
    const x = r.left + r.width * 0.5, y = r.top + r.height / 2;
    bar.dispatchEvent(new PointerEvent("pointerdown", { clientX: x, clientY: y, bubbles: true, pointerId: 3 }));
    bar.dispatchEvent(new PointerEvent("pointerup", { clientX: x, clientY: y, bubbles: true, pointerId: 3 }));
  });
  await sleep(250);
  const fill = await page.$eval("#np-seek-fill", el => parseFloat(el.style.width));
  ok(fill > 40 && fill < 60, "跳转到 ~50%", "fill=" + fill);
  // 直接验证服务端 Range 语义（206 / 边界 / 后缀 / 非法）
  const rangeChecks = await page.evaluate(async () => {
    const out = {};
    const r1 = await fetch("/audio/a1", { headers: { Range: "bytes=100-199" } });
    out.partial = r1.status === 206;
    out.partialLen = (await r1.arrayBuffer()).byteLength === 100;
    out.cr = r1.headers.get("Content-Range");
    const r2 = await fetch("/audio/a1", { headers: { Range: "bytes=-64" } });
    out.suffix = r2.status === 206 && (await r2.arrayBuffer()).byteLength === 64;
    const r3 = await fetch("/audio/a1", { headers: { Range: "bytes=500-" } });
    const full = await fetch("/audio/a1");
    const total = (await full.arrayBuffer()).byteLength;
    out.openEnded = r3.status === 206 && (await r3.arrayBuffer()).byteLength === total - 500;
    const r4 = await fetch("/audio/a1", { headers: { Range: "bytes=999999999-" } });
    out.invalid = r4.status === 416;
    return out;
  });
  ok(rangeChecks.partial, "Range 206 分段", rangeChecks.cr);
  ok(rangeChecks.partialLen, "分段长度正确");
  ok(rangeChecks.suffix, "后缀 Range（最后 64 字节）");
  ok(rangeChecks.openEnded, "开放式 Range（500-结尾）");
  ok(rangeChecks.invalid, "越界 Range 返回 416");

  console.log("=== 5. 封面提取（HTTP Range 读标签） ===");
  await page.evaluate(() => { document.querySelectorAll("#detail-list li[data-id]")[1].click(); });
  await sleep(2500);
  const artShown = await page.$eval("#np-art-img", el => !el.hidden && el.src.indexOf("data:image") === 0);
  ok(artShown, "FLAC 内嵌封面经 HTTP 提取");
  const title = await page.$eval("#np-title", el => el.textContent);
  ok(/Wanfeng/i.test(title), "FLAC 标签标题", title);

  console.log("=== 6. 歌词浮层（桥配对的歌词） ===");
  await page.evaluate(() => { document.querySelectorAll("#detail-list li[data-id]")[2].click(); });
  await sleep(1500);
  await page.tap("#np-lyrics-btn");
  await sleep(500);
  eq(await page.$$eval(".np-line", els => els.length), 3, "3 行歌词");
  await page.evaluate(() => { seekTo(0.9); });
  await sleep(400);
  eq(await page.evaluate(() => { const c = document.querySelector(".np-line.cur"); return c ? c.textContent : "(none)"; }),
    "安卓桥歌词第一行", "歌词高亮同步");

  console.log("=== 7. 重载恢复（localStorage 于 http origin） ===");
  await page.reload({ waitUntil: "load" });
  await sleep(1500);
  const restoredRows = await page.$$eval("#detail-list li[data-id]", els => els.length);
  eq(restoredRows, 3, "重载后曲目恢复（桥 importedAudio）");
  ok(await page.evaluate(() => window.NATIVE === true), "重载后仍识别桥");

  console.log("=== 8. 图片桥（自定义封面） ===");
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
    const m = items.filter(i => /自定义图片/.test(i.textContent))[0];
    if (m) m.click();
  });
  await sleep(800);
  const coverId = await page.evaluate(() => {
    const pl = lib.find(p => p.id === curPlId);
    return pl ? pl.coverImageId : null;
  });
  eq(coverId, "img_1", "自定义封面 id 保存");
  const css = await page.evaluate(() => document.getElementById("detail-hero-cover").style.backgroundImage);
  ok(css.indexOf("/image/img_1") >= 0, "封面 URL 指向桥图片", css);

  console.log("=== 9. 歌曲分类（安卓桥：标签经 HTTP Range 读取） ===");
  await page.tap("#detail-back");
  await sleep(500);
  await page.tap('#lib-seg button[data-tab="songs"]');
  await sleep(2600);
  const clsRows = await page.$$eval("#lib-songs li[data-id]", els => els.map(li => li.querySelector(".song-sub").textContent));
  // 资料库歌曲来自原生登记表（importedAudio）：导入过的歌即使不在任何歌单里也会列出
  const regCount = await page.evaluate(() => Object.keys(window.__bridge.reg).length);
  eq(clsRows.length, regCount, "歌曲分类列出全部导入过的歌曲（" + regCount + " 首，含不在歌单里的）");
  ok(clsRows.some(s => /Hibiki Band · Test Album/.test(s)), "MP3 标签（艺人·专辑）经 Range 读取", JSON.stringify(clsRows));
  ok(clsRows.some(s => /^Hibiki( ·|$)/.test(s)), "FLAC 艺人标签无多余字节", JSON.stringify(clsRows));
  await page.tap('#lib-seg button[data-tab="albums"]');
  await sleep(1400);
  const albumInfo = await page.$$eval("#lib-albums .lib-card", els => els.map(c => ({
    name: c.querySelector(".lib-card-name").textContent,
    count: c.querySelector(".lib-card-count").textContent,
  })));
  ok(albumInfo.some(a => a.name === "Test Album" && /1 首 · Hibiki Band/.test(a.count)),
    "专辑分类与标签一致", JSON.stringify(albumInfo));
  await page.tap('#lib-seg button[data-tab="artists"]');
  await sleep(1400);
  const artistNames = await page.$$eval("#lib-artists .artist-row .artist-name", els => els.map(e => e.textContent));
  ok(artistNames.indexOf("Hibiki") >= 0 && artistNames.indexOf("Hibiki Band") >= 0, "艺人分类与标签一致", JSON.stringify(artistNames));
  ok(artistNames.every(n => n.length < 40), "艺人名无二进制残留", JSON.stringify(artistNames.map(n => n.length)));
  await page.evaluate(() => {
    const rows = document.querySelectorAll("#lib-artists .artist-row");
    for (const r of rows) if (r.querySelector(".artist-name").textContent === "Test Album") { r.click(); return; }
  });
  await page.evaluate(() => {
    const rows = document.querySelectorAll("#lib-artists .artist-row");
    for (const r of rows) if (r.querySelector(".artist-name").textContent === "Hibiki Band") { r.click(); return; }
  });
  await sleep(900);
  ok(await page.$eval("#page-group", e => e.classList.contains("active")), "艺人详情页在桥模式下可打开");
  eq(await page.$$eval("#group-list li[data-id]", els => els.length), 1, "艺人详情页曲目正确");

  console.log("=== 10. 裸流下载：标签与封面来自应用内记录 ===");
  await page.evaluate(() => {
    // 模拟一首没有任何内嵌标签的裸流（杜比下载的形态）
    const pl = lib.find(p => p.id === curPlId) || lib[0];
    pl.items.push({ id: "a6", name: "dolby-atmos.eac3", dur: null, codec: "ec-3" });
    registerHttp("a6", "dolby-atmos.eac3", 471520);
    metaCache.delete("a6");
    storedTagAsked.delete("a6");
    saveLib();
    renderDetail();
  });
  await sleep(1200);
  const storedTags = await page.evaluate(() => {
    const li = document.querySelector('#detail-list li[data-id="a6"]');
    const m = metaCache.get("a6") || {};
    return {
      title: m.title || "", artist: m.artist || "", cover: m.cover || "",
      rowName: li ? li.querySelector(".song-name").textContent : "(缺失)",
      rowSub: li ? li.querySelector(".song-sub").textContent : "",
      coverBg: li ? getComputedStyle(li.querySelector(".cover")).backgroundImage.slice(0, 80) : "",
    };
  });
  eq(storedTags.title, "杜比测试曲目", "文件无标签时读取应用内记录的标题");
  eq(storedTags.rowName.replace("EAC3", ""), "杜比测试曲目", "行内显示正确的歌名（不再乱码）");
  eq(storedTags.artist, "测试UP主", "读取应用内记录的 UP 主");
  eq(storedTags.cover, "/cover/a6", "封面指向应用内封面接口");
  ok(/\/cover\/a6/.test(storedTags.coverBg), "行封面使用应用内封面", storedTags.coverBg);

  console.log("\n========== 安卓模式结果: " + passed + " 通过, " + failed + " 失败 ==========");
  if (errors.length) {
    console.log("JS 错误:");
    errors.forEach(e => console.log("  " + e.slice(0, 160)));
    ok(errors.length === 0, "无 JS 错误", errors.slice(0, 3).join(" | "));
  }
  console.log("服务端收到的 Range 请求数:", rangeLog.length);
  if (failures.length) { console.log("失败项:"); failures.forEach(f => console.log("  - " + f)); }
  await browser.close();
  server.close();
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error("测试异常:", e); try { server.close(); } catch (x) {} process.exit(2); });

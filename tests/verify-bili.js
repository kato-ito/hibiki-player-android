// B 站音频下载流程验证（模拟原生桥）
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const CHROME = process.env.CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const WWW = path.resolve(__dirname, "..", "www", "index.html");
const SHOTS = path.resolve(__dirname, "screenshots");
const PORT = 39885;
const FIXTURES = path.resolve(__dirname, "fixtures");

let passed = 0, failed = 0;
const failures = [];
const ok = (c, name, extra) => {
  if (c) { passed++; console.log("  \u2713 " + name); }
  else { failed++; failures.push(name); console.log("  \u2717 FAIL: " + name + (extra !== undefined ? "  \u2014 " + extra : "")); }
};
const eq = (a, b, name) => ok(a === b, name + (a === b ? "" : "  (got=" + JSON.stringify(a) + " want=" + JSON.stringify(b) + ")"));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = (page, n) => page.screenshot({ path: path.join(SHOTS, n + ".png") }).catch(() => {});
async function tapCentered(page, sel) {
  await page.evaluate((s) => { const e = document.querySelector(s); if (e && e.scrollIntoView) e.scrollIntoView({ block: "center" }); }, sel);
  await sleep(180);
  await page.tap(sel);
}

// 记录页面经本地代理请求的图片原始地址（模拟原生 /biliimg/<base64url>，真实实现由 Kotlin 取图）
const imageKeys = [];
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
const server = http.createServer((req, res) => {
  const p = new URL(req.url, "http://127.0.0.1").pathname;
  if (p === "/" || p === "/index.html") {
    const data = fs.readFileSync(WWW);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": data.length, "Cache-Control": "no-store" });
    return res.end(data);
  }
  if (p.startsWith("/biliimg/")) {
    const key = p.slice("/biliimg/".length);
    let url = "";
    try {
      const b64 = key.replace(/-/g, "+").replace(/_/g, "/");
      url = Buffer.from(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64").toString("utf8");
    } catch (e) { /* ignore */ }
    imageKeys.push(url);
    res.writeHead(200, { "Content-Type": "image/png", "Content-Length": PNG_1x1.length, "Cache-Control": "public, max-age=86400" });
    return res.end(PNG_1x1);
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
  page.on("console", m => { if (m.type() === "error" && !/favicon|404/.test(m.text())) errors.push(m.text().slice(0, 140)); });
  page.on("pageerror", e => errors.push("pageerror: " + e.message.slice(0, 160)));

  await page.evaluateOnNewDocument(() => {
    window.__calls = [];
    window.__mockBili = {
      clipboard: "【校长来啦-哔哩哔哩】 https://b23.tv/abc1234",
      qrState: "wait",
      // 与原生桥一致：返回 playurl 的原始 DASH（音质档位在页面侧解析）
      dash: {
        duration: 480,
        audio: [
          { id: 30216, baseUrl: "https://cdn/a64.m4s", bandwidth: 66000, codecs: "mp4a.40.2", mimeType: "audio/mp4", backupUrl: [] },
          { id: 30232, baseUrl: "https://cdn/a132.m4s", bandwidth: 132000, codecs: "mp4a.40.2", mimeType: "audio/mp4", backupUrl: [] },
          { id: 30280, baseUrl: "https://cdn/a192.m4s", bandwidth: 192000, codecs: "mp4a.40.2", mimeType: "audio/mp4", backupUrl: ["https://cdn/a192b.m4s"] },
        ],
        flac: { display: true, audio: { id: 30251, baseUrl: "https://cdn/hires.flac", bandwidth: 900000, codecs: "fLaC", mimeType: "audio/flac", backupUrl: ["https://cdn/hires2.flac"] } },
        dolby: { type: 1, audio: [{ id: 30250, baseUrl: "https://cdn/dolby.m4s", bandwidth: 448000, codecs: "ec-3", mimeType: "audio/mp4", backupUrl: [] }] },
      },
      pages: [
        { cid: 111, page: 1, part: "P1 开场", duration: 120 },
        { cid: 222, page: 2, part: "P2 正片", duration: 300 },
        { cid: 333, page: 3, part: "P3 花絮", duration: 60 },
      ],
      failParse: false,
      // 真实 B 站：每个分P的音频流地址都不一样。这里给每个 cid 的地址加后缀，
      // 用于验证「选集下载不会全部下成第一P」（曾出现的 bug）
      dashFor(cid) {
        if (!this.dash) return null;
        const clone = JSON.parse(JSON.stringify(this.dash));
        const tag = "-p" + cid;
        (clone.audio || []).forEach(a => { a.baseUrl = (a.baseUrl || "") + tag; a.backupUrl = (a.backupUrl || []).map(u => u + tag); });
        if (clone.flac && clone.flac.audio) {
          clone.flac.audio.baseUrl = (clone.flac.audio.baseUrl || "") + tag;
          clone.flac.audio.backupUrl = (clone.flac.audio.backupUrl || []).map(u => u + tag);
        }
        if (clone.dolby && clone.dolby.audio) {
          (Array.isArray(clone.dolby.audio) ? clone.dolby.audio : [clone.dolby.audio]).forEach(a => {
            a.baseUrl = (a.baseUrl || "") + tag; a.backupUrl = (a.backupUrl || []).map(u => u + tag);
          });
        }
        return clone;
      },
    };
    const reply = (id, okk, json) => setTimeout(() => window.__hbpBridgeResult(id, okk, json), 15);
    window.AndroidBridge = {
      call(method, requestId, payload) {
        let p = {};
        try { p = payload ? JSON.parse(payload) : {}; } catch (e) {}
        window.__calls.push({ method, payload: p });
        switch (method) {
          case "importedAudio": return reply(requestId, true, "[]");
          case "biliClipboard": return reply(requestId, true, JSON.stringify({ text: window.__mockBili.clipboard }));
          case "biliParse":
            if (window.__mockBili.failParse) return reply(requestId, false, "没有找到 B 站链接");
            return reply(requestId, true, JSON.stringify({
              bvid: "BV1odY76aEio", aid: 117252037019362, title: "校长来啦（测试）", owner: "脱缰凯Kk",
              pic: "https://i0.hdslb.com/bfs/archive/x.jpg", duration: 480, desc: "测试",
              pages: window.__mockBili.pages, link: "https://www.bilibili.com/video/BV1odY76aEio",
            }));
          case "biliQualities":
            return reply(requestId, true, JSON.stringify({
              dash: window.__mockBili.dashFor ? window.__mockBili.dashFor(Number(p.cid || 0)) : window.__mockBili.dash,
              quality: 32, support: [] }));
          case "biliStart":
            return reply(requestId, true, JSON.stringify({ task: {
              id: "task1", title: p.title, part: p.part, owner: p.owner, quality: p.qualityLabel, codec: p.codec,
              state: "downloading", bytes: 0, total: 3600000, speed: 0, message: "", fileName: "", entryId: "", entrySize: 0, entryName: "" } }));
          case "biliTasks": return reply(requestId, true, JSON.stringify({ tasks: [] }));
          case "biliCancel": return reply(requestId, true, "{}");
          case "biliAccount":
            return reply(requestId, true, JSON.stringify(window.__mockBili.account || { loggedIn: false }));
          case "biliQrStart": return reply(requestId, true, JSON.stringify({ key: "qrkey123", url: "https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=qrkey123" }));
          case "biliQrPoll": {
            const st = window.__mockBili.qrState;
            if (st === "ok") window.__mockBili.account = { loggedIn: true, name: "测试用户", face: "https://i0.hdslb.com/bfs/face/x.jpg", vip: true, level: 5 };
            return reply(requestId, true, JSON.stringify(st === "ok"
              ? { state: "ok", code: 0, account: window.__mockBili.account }
              : { state: st, code: st === "scanned" ? 86090 : 86101 }));
          }
          case "saveQrImage":
            window.__savedQr = { name: p.name, len: (p.data || "").length, head: (p.data || "").slice(0, 22) };
            return reply(requestId, true, JSON.stringify({ path: "图片/Hibiki Player/" + p.name }));
          case "biliLogout": window.__mockBili.account = null; return reply(requestId, true, "{}");
          default: return reply(requestId, false, "unknown " + method);
        }
      },
    };
  });

  await page.goto("http://127.0.0.1:" + PORT + "/", { waitUntil: "load" });
  await sleep(900);

  console.log("=== 1. 入口与页面 ===");
  ok(await page.$("#lib-bili-btn") !== null, "资料库顶栏有下载入口");
  await page.tap("#lib-bili-btn"); await sleep(600);
  ok(await page.$eval("#page-bili", e => e.classList.contains("active")), "打开 B 站下载页");
  await shot(page, "bili-01-entry");

  console.log("=== 2. 粘贴解析 ===");
  await page.tap("#bili-paste"); await sleep(900);
  const parsed = await page.evaluate(() => ({
    title: document.getElementById("bili-title").textContent,
    owner: document.getElementById("bili-owner").textContent,
    input: document.getElementById("bili-input").value,
    resultShown: !document.getElementById("bili-result").classList.contains("hidden"),
  }));
  ok(/校长来啦/.test(parsed.title), "解析出标题", parsed.title);
  ok(/脱缰凯Kk/.test(parsed.owner), "解析出 UP 主", parsed.owner);
  ok(/b23\.tv/.test(parsed.input), "剪贴板内容回填输入框");
  ok(parsed.resultShown, "结果卡片显示");
  ok((await page.$eval("#bili-cover", e => e.getAttribute("src"))).indexOf("/biliimg/") === 0,
    "封面经本地图片代理加载（避开图床的外站 Referer 403）",
    await page.$eval("#bili-cover", e => e.getAttribute("src")));
  await shot(page, "bili-02-parsed");

  console.log("=== 3. 分P 与音质 ===");
  const partsUI = await page.$$eval(".bili-part", els => els.map(e => ({
    on: e.classList.contains("on"), text: e.querySelector(".pt").textContent })));
  eq(partsUI.length, 3, "列出 3 个分P");
  eq(partsUI.filter(p => p.on).length, 1, "默认只选中第 1 个分P");
  await page.evaluate(() => document.querySelectorAll(".bili-part")[1].click());
  await page.evaluate(() => document.querySelectorAll(".bili-part")[2].click());
  await sleep(600);
  eq(await page.$$eval(".bili-part.on", els => els.length), 3, "可多选分P");
  const seg = await page.$$eval("#bili-q-seg button", els => els.map(e => e.textContent + (e.classList.contains("on") ? "*" : "")));
  eq(seg.join(","), "Hi-Res*,杜比,192K,132K,64K", "音质档位：Hi-Res / 杜比 / 192K / 132K / 64K");
  ok(/Hi-Res/.test(await page.$eval("#bili-q-cur", e => e.textContent)), "默认选中 Hi-Res 无损（最高档）",
    await page.$eval("#bili-q-cur", e => e.textContent));
  ok(/已解锁会员音轨/.test(await page.$eval("#bili-q-hint", e => e.textContent)), "登录后提示已解锁会员音轨",
    await page.$eval("#bili-q-hint", e => e.textContent));
  await shot(page, "bili-03b-qualities");
  const dlLabel = await page.$eval("#bili-download", e => e.textContent.trim());
  ok(/3 个分P/.test(dlLabel), "下载按钮文案随分P数量变化", dlLabel);
  await shot(page, "bili-03-parts");

  console.log("=== 4. 开始下载与进度 ===");
  await page.tap("#bili-download"); await sleep(700);
  const starts = await page.evaluate(() => window.__calls.filter(c => c.method === "biliStart").length);
  eq(starts, 3, "为 3 个分P各发起一次下载");
  const startPayloads = await page.evaluate(() => window.__calls.filter(c => c.method === "biliStart").map(c => c.payload));
  const startCids = startPayloads.map(x => x.cid);
  eq(JSON.stringify(startCids), JSON.stringify([111, 222, 333]), "三个分P都提交了下载（按 P1、P2、P3 顺序）");
  const startUrls = startPayloads.map(x => x.url);
  eq(new Set(startUrls).size, 3, "每个分P使用各自的音频地址（不是共用一个）", startUrls.join(" | "));
  ok(startUrls.every((u, i) => u.indexOf("-p" + startCids[i]) > 0),
    "地址与分P的 cid 一一对应 —— 修掉「选集下载全是第一P」", startUrls.join(" | "));
  // 合集（多 P）：原生侧据此在下载文件夹里建「视频名」子文件夹，文件名只用分P名
  eq(startPayloads.map(x => x.folder).join(","), "校长来啦（测试）,校长来啦（测试）,校长来啦（测试）",
    "合集下载携带视频名（用于建子文件夹）");
  eq(startPayloads.map(x => x.page).join(","), "1,2,3", "携带分P序号（分P名为空时用它兜底命名）");
  const firstPayload = startPayloads[0];
  ok(/Hi-Res/.test(firstPayload.qualityLabel) && firstPayload.url === "https://cdn/hires.flac-p111" && firstPayload.backups.length === 1,
    "默认下载 Hi-Res 无损（原始码流 + 备用线路）",
    JSON.stringify({ q: firstPayload.qualityLabel, url: firstPayload.url, backups: firstPayload.backups.length }));
  ok(/fLaC/i.test(firstPayload.codec), "携带编码标识（用于选择封装容器）", firstPayload.codec);
  ok(await page.$$eval(".bili-task", els => els.length) === 1, "任务卡片出现");
  // 推送进度
  await page.evaluate(() => window.__hbdBiliTask({
    id: "task1", title: "校长来啦（测试）", part: "P1 开场", quality: "Hi-Res 无损", codec: "fLaC",
    state: "downloading", bytes: 1800000, total: 3600000, speed: 524288, message: "", fileName: "",
    entryId: "", entrySize: 0, entryName: "" }));
  await sleep(300);
  const taskText = await page.$eval(".bili-task", e => e.textContent);
  ok(/50%/.test(taskText), "进度百分比显示", taskText.slice(0, 60));
  ok(/512 KB\/s|524 KB\/s/.test(taskText) || /KB\/s/.test(taskText), "速度显示");
  ok(/1\.72 MB \/ 3\.43 MB/.test(taskText), "已下载/总量显示", taskText.slice(0, 80));
  await shot(page, "bili-04-task");

  console.log("=== 5. 完成 → 自动加入歌单 ===");
  await page.evaluate(() => window.__hbdBiliTask({
    id: "task1", title: "校长来啦（测试）", part: "P1 开场", quality: "Hi-Res 无损", codec: "fLaC",
    state: "done", bytes: 3600000, total: 3600000, speed: 0, message: "已保存到 音乐/Hibiki Player",
    fileName: "校长来啦（测试）.flac", entryId: "entry001", entrySize: 3600000, entryName: "校长来啦（测试）.flac" }));
  await sleep(800);
  const added = await page.evaluate(() => ({
    playlists: lib.map(p => ({ name: p.name, count: p.items.length, first: p.items[0] && p.items[0].name })),
    registered: registry.has("entry001"),
    toast: document.getElementById("toast").textContent,
  }));
  ok(added.registered, "下载文件已登记（可播放）");
  ok(added.playlists.length >= 1 && added.playlists[0].count === 1, "自动创建/加入歌单", JSON.stringify(added.playlists));
  ok(/已加入歌单/.test(added.toast), "提示已加入歌单", added.toast);
  const doneText = await page.$eval(".bili-task", e => e.textContent);
  ok(/已完成/.test(doneText) && /已加入歌单/.test(doneText), "任务标记完成", doneText.slice(0, 60));
  await shot(page, "bili-05-done");

  console.log("=== 6. 取消下载 ===");
  await page.evaluate(() => window.__hbdBiliTask({
    id: "task2", title: "另一个视频", part: "", quality: "192K", codec: "mp4a.40.2",
    state: "downloading", bytes: 1000, total: 10000, speed: 1000, message: "", fileName: "", entryId: "", entrySize: 0, entryName: "" }));
  await sleep(300);
  await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll(".bili-task"));
    const target = cards.filter(c => /另一个视频/.test(c.textContent))[0];
    target.querySelector(".tf button").click();
  });
  await sleep(400);
  const cancelCalls = await page.evaluate(() => window.__calls.filter(c => c.method === "biliCancel").length);
  eq(cancelCalls, 1, "取消按钮触发 biliCancel");
  ok(/已取消/.test(await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll(".bili-task"));
    return (cards.filter(c => /另一个视频/.test(c.textContent))[0] || {}).textContent || "";
  })), "任务显示已取消");

  console.log("=== 7. 扫码登录 ===");
  // 账号行在下载页中部：先滚到顶再点，避免它被滚动到视口外（点不到）
  await page.evaluate(() => { document.getElementById("page-bili").scrollTop = 0; });
  await sleep(200);
  await page.tap("#bili-account-btn"); await sleep(900);
  console.log("    扫码诊断:", JSON.stringify(await page.evaluate(() => ({
    calls: window.__calls.slice(-4).map(c => c.method),
    pending: Object.keys(bridgePending),
    qr: document.getElementById("qr-sheet").className,
    status: document.getElementById("qr-status").textContent,
    sheetOpen: !!openSheetEl,
    scrim: document.getElementById("scrim").className,
    stack: uiStack.slice(),
  }))));
  ok(await page.$eval("#qr-sheet", e => e.classList.contains("open")), "扫码面板打开");
  const qrPixels = await page.evaluate(() => {
    const c = document.getElementById("qr-canvas");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 100) dark++;
    return dark;
  });
  ok(qrPixels > 500, "二维码已绘制（含定位图案）", "dark=" + qrPixels);
  eq(await page.$eval("#qr-status", e => e.textContent), "请用 B 站手机客户端扫码", "显示等待扫码");
  // 账号入口应在链接解析下方（不在上栏）
  const acctPos = await page.evaluate(() => {
    const head = document.querySelector("#page-bili .detail-head");
    const acct = document.getElementById("bili-account-btn").getBoundingClientRect();
    const parse = document.getElementById("bili-parse").getBoundingClientRect();
    return { inHeader: !!(head && head.querySelector("#bili-account-btn")), below: acct.top > parse.bottom };
  });
  ok(!acctPos.inHeader && acctPos.below, "账号入口位于解析区下方（不在上栏）", JSON.stringify(acctPos));
  // 保存二维码到相册（同一台手机可用 B 站「扫一扫 → 相册」）
  await page.tap("#qr-save");
  await sleep(600);
  const savedQr = await page.evaluate(() => window.__savedQr || null);
  ok(!!savedQr && savedQr.head.indexOf("data:image/png") === 0 && savedQr.len > 500,
    "保存二维码：PNG 数据经原生桥写入相册", JSON.stringify(savedQr && { name: savedQr.name, len: savedQr.len, head: savedQr.head }));
  ok(/已保存到相册/.test(await page.$eval("#toast", e => e.textContent)), "保存成功提示",
    await page.$eval("#toast", e => e.textContent));
  await shot(page, "bili-06-qr");
  // 已扫描 → 已确认
  await page.evaluate(() => { window.__mockBili.qrState = "scanned"; });
  await sleep(3000);
  eq(await page.$eval("#qr-status", e => e.textContent), "已扫码，请在手机上确认", "提示已扫码待确认");
  await page.evaluate(() => { window.__mockBili.qrState = "ok"; });
  await sleep(3200);
  const acc = await page.evaluate(() => ({
    status: document.getElementById("qr-status").textContent,
    hasFace: !!document.querySelector("#bili-account-btn img.face"),
    sheetOpen: document.getElementById("qr-sheet").classList.contains("open"),
  }));
  ok(/登录成功/.test(acc.status), "登录成功提示", acc.status);
  ok(acc.hasFace, "账号行显示头像");
  eq(await page.$eval("#bili-account-name", e => e.textContent), "测试用户", "账号行显示昵称");
  ok(/大会员|点击管理/.test(await page.$eval("#bili-account-state", e => e.textContent)), "账号行显示状态",
    await page.$eval("#bili-account-state", e => e.textContent));
  ok(!acc.sheetOpen, "登录后自动收起面板");
  await shot(page, "bili-07-logged-in");

  console.log("=== 7b. 杜比档位 / 无会员音轨 / 真实接口结构 / 图片代理 ===");
  // 切到杜比全景声再下载一次
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("#bili-q-seg button")).filter(x => x.dataset.kind === "dolby")[0];
    if (b) b.click();
  });
  await sleep(500);
  eq(await page.$eval("#bili-q-cur", e => e.textContent.indexOf("杜比全景声") === 0), true, "可手动切到杜比全景声",
    await page.$eval("#bili-q-cur", e => e.textContent));
  await page.tap("#bili-download");
  await sleep(700);
  const dolbyPayload = await page.evaluate(() => {
    const calls = window.__calls.filter(c => c.method === "biliStart");
    return calls[calls.length - 1].payload;
  });
  ok(/杜比/.test(dolbyPayload.qualityLabel) && /cdn\/dolby\.m4s/.test(dolbyPayload.url) && /ec-3/i.test(dolbyPayload.codec) &&
     dolbyPayload.url.indexOf("-p" + dolbyPayload.cid) > 0,
    "杜比全景声可下载（E-AC-3 原始码流，且是该分P自己的地址）",
    JSON.stringify({ q: dolbyPayload.qualityLabel, url: dolbyPayload.url, cid: dolbyPayload.cid, codec: dolbyPayload.codec }));

  // 未登录 / 无会员音轨：档位只剩 AAC，并给出解锁提示
  await page.evaluate(() => {
    window.__mockBili.dash = {
      duration: 480,
      audio: [
        { id: 30216, baseUrl: "https://cdn/a64.m4s", bandwidth: 66000, codecs: "mp4a.40.2" },
        { id: 30280, baseUrl: "https://cdn/a192.m4s", bandwidth: 192000, codecs: "mp4a.40.2" },
      ],
      flac: null,
      dolby: { type: 0, audio: null },
    };
    window.__mockBili.account = null;
    biliState.account = null;
    biliState.qualityId = 0;
    biliLoadQualities();
  });
  await sleep(800);
  const seg2 = await page.$$eval("#bili-q-seg button", els => els.map(e => e.textContent));
  eq(seg2.join(","), "192K,64K", "无会员音轨时只列 AAC 档位");
  ok(/登录 B 站账号/.test(await page.$eval("#bili-q-hint", e => e.textContent)), "提示登录可解锁 Hi-Res / 杜比",
    await page.$eval("#bili-q-hint", e => e.textContent));
  // 空值容错（真实接口未登录时 flac=null、dolby.audio=null）
  ok(await page.evaluate(() => {
    const q = biliParseQualities({ audio: [{ id: 30280, baseUrl: "u", bandwidth: 192000, codecs: "mp4a.40.2" }], flac: null, dolby: { type: 0, audio: null } });
    return q.length === 1 && q[0].short === "192K";
  }), "解析器对 flac/dolby 为 null 容错");
  // 真实接口返回的 DASH 结构（未登录）：应解析出 3 个 AAC 档位
  const realDash = JSON.parse(fs.readFileSync(path.join(FIXTURES, "bili-dash-real.json"), "utf8"));
  const realParsed = await page.evaluate((dash) => {
    const q = biliParseQualities(dash);
    return q.map(x => x.id + ":" + x.short + ":" + x.kind);
  }, realDash.dash);
  ok(realParsed.length >= 1 && realParsed.every(s => /:aac$/.test(s)), "真实接口结构解析为 AAC 档位", JSON.stringify(realParsed));

  // 图片代理：封面与头像都经本地 /biliimg/（B 站图床对外站 Referer 返回 403）
  await page.evaluate(() => { window.__mockBili.dash = null; });
  await page.evaluate(() => {
    biliState.account = { loggedIn: true, name: "测试用户", face: "https://i1.hdslb.com/bfs/face/x.jpg", vip: true };
    renderBiliAccountRow();
    biliRenderResult();     // 重新渲染结果卡片，检查封面地址
  });
  await sleep(400);
  const imgSrc = await page.evaluate(() => ({
    cover: document.getElementById("bili-cover").getAttribute("src") || "",
    avatar: (document.querySelector("#bili-account-ic img.face") || { getAttribute: () => "" }).getAttribute("src") || "",
  }));
  ok(imgSrc.cover.indexOf("/biliimg/") === 0, "视频封面走本地图片代理", imgSrc.cover.slice(0, 44));
  ok(imgSrc.avatar.indexOf("/biliimg/") === 0, "B 站头像走本地图片代理", imgSrc.avatar.slice(0, 44));
  ok(imageKeys.some(u => /^https:\/\/i0\.hdslb\.com\/bfs\/archive\/x\.jpg$/.test(u)),
    "代理请求还原出封面原始地址", JSON.stringify(imageKeys.filter(u => /hdslb/.test(u))));
  ok(imageKeys.some(u => /^https:\/\/i1\.hdslb\.com\/bfs\/face\/x\.jpg$/.test(u)), "代理请求还原出头像原始地址");
  ok(await page.$eval("#bili-cover", e => e.complete && e.naturalWidth > 0), "封面经代理成功加载（1x1 测试图）");

  console.log("=== 8. 分享进入 / 剪贴板横幅 ===");
  await page.evaluate(() => closeBili()); await sleep(500);
  await page.evaluate(() => window.__hbdBiliLink("https://b23.tv/xyz999", "clipboard"));
  await sleep(300);
  const banner = await page.evaluate(() => ({
    shown: !document.getElementById("bili-banner").classList.contains("hidden"),
    text: document.getElementById("bili-banner-text").textContent,
  }));
  ok(banner.shown, "剪贴板链接显示横幅（不自动解析）");
  ok(/检测到剪贴板链接/.test(banner.text), "横幅文案", banner.text);
  await page.evaluate(() => closeSheet());
  await sleep(300);
  await page.tap("#lib-bili-btn"); await sleep(500);
  ok(await page.$eval("#bili-banner", e => !e.classList.contains("hidden")), "进入下载页仍显示横幅");
  await page.evaluate(() => document.getElementById("bili-banner-x").click());
  await sleep(300);
  ok(await page.$eval("#bili-banner", e => e.classList.contains("hidden")), "可忽略横幅");
  // 分享进入：直接解析
  await page.evaluate(() => closeBili()); await sleep(400);
  await page.evaluate(() => window.__hbdBiliLink("【分享】https://www.bilibili.com/video/BV1odY76aEio", "share"));
  await sleep(1000);
  const shared = await page.evaluate(() => ({
    pageOpen: document.getElementById("page-bili").classList.contains("active"),
    title: document.getElementById("bili-title").textContent,
  }));
  ok(shared.pageOpen, "分享进入自动打开下载页");
  ok(/校长来啦/.test(shared.title), "分享链接自动解析", shared.title);

  console.log("=== 9. 返回键与错误处理 ===");
  await page.goBack(); await sleep(600);
  ok(await page.$eval("#page-library", e => e.classList.contains("active")), "返回键回到资料库");
  await page.tap("#lib-bili-btn"); await sleep(500);
  await page.evaluate(() => { window.__mockBili.failParse = true; });
  await page.evaluate(() => { document.getElementById("bili-input").value = "没有链接"; });
  await page.tap("#bili-parse"); await sleep(700);
  ok(/解析失败/.test(await page.$eval("#toast", e => e.textContent)), "解析失败给出提示", await page.$eval("#toast", e => e.textContent));
  await page.evaluate(() => { window.__mockBili.failParse = false; });

  console.log("=== 10. 单 P 视频：不建子文件夹，用视频名 ===");
  await page.evaluate(() => {
    window.__mockBili.pages = [{ cid: 999, page: 1, part: "只有一P", duration: 60 }];
    window.__mockBili.dash = {
      duration: 60,
      audio: [{ id: 30280, baseUrl: "https://cdn/single.m4s", bandwidth: 192000, codecs: "mp4a.40.2" }],
      flac: null, dolby: { type: 0, audio: null },
    };
    closeBili();
  });
  await sleep(400);
  await page.tap("#lib-bili-btn"); await sleep(400);
  await page.evaluate(() => biliParseText("https://www.bilibili.com/video/BV1odY76aEio"));
  await sleep(900);
  const singleLabel = await page.$eval("#bili-download", e => e.textContent.trim());
  ok(!/个分P/.test(singleLabel), "单 P 视频按钮文案不是「N 个分P」", singleLabel);
  const beforeSingle = await page.evaluate(() => window.__calls.filter(c => c.method === "biliStart").length);
  // 居中后再点：直接 tap 时最小的滚动量会把按钮留在底部标签栏后面（elementFromPoint 命中 tab）
  await tapCentered(page, "#bili-download"); await sleep(800);
  const singlePayload = await page.evaluate(() => window.__calls.filter(c => c.method === "biliStart").slice(-1)[0].payload);
  eq(singlePayload.folder, "", "单 P 视频不带 folder（不建子文件夹）");
  eq(singlePayload.page, 1, "单 P 也带分P序号");
  ok(/只有一P/.test(singlePayload.part), "单 P 的分P名照常传递", singlePayload.part);
  ok(await page.evaluate(() => window.__calls.filter(c => c.method === "biliStart").length) === beforeSingle + 1,
    "单 P 只发起一次下载");

  console.log("\n========== B站下载验证: " + passed + " 通过, " + failed + " 失败 ==========");
  if (errors.length) { console.log("JS 错误:"); errors.forEach(e => console.log("   " + e)); }
  ok(errors.length === 0, "全程无 JS 错误", errors.slice(0, 2).join(" | "));
  if (failures.length) { console.log("失败项:"); failures.forEach(f => console.log("  - " + f)); }
  await browser.close();
  server.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("测试异常:", e); try { server.close(); } catch (x) {} process.exit(2); });

"use strict";
const puppeteer = require("puppeteer-core");
const path = require("path");
const CHROME = process.env.CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const URL = "file:///" + path.resolve(__dirname, "..", "www", "index.html").replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-gpu", "--mute-audio"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errs = [];
  page.on("pageerror", e => errs.push("pageerror: " + e.message.slice(0, 200)));
  page.on("console", m => { if (m.type() === "error") errs.push("console: " + m.text().slice(0, 160)); });
  await page.evaluateOnNewDocument(() => {
    window.__calls = [];
    const reply = (id, okk, json) => setTimeout(() => window.__hbpBridgeResult(id, okk, json), 15);
    window.__accountOk = false;
    window.AndroidBridge = { call(method, requestId, payload) {
      window.__calls.push(method);
      if (method === "importedAudio") return reply(requestId, true, "[]");
      if (method === "biliAccount") return reply(requestId, true, JSON.stringify({ loggedIn: false }));
      if (method === "biliTasks") return reply(requestId, true, JSON.stringify({ tasks: [] }));
      if (method === "biliQrStart") return reply(requestId, true, JSON.stringify({ key: "k1", url: "https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=k1" }));
      if (method === "biliQrPoll") return reply(requestId, true, JSON.stringify({ state: "wait", code: 86101 }));
      return reply(requestId, false, "unknown " + method);
    } };
  });
  await page.goto(URL, { waitUntil: "load" });
  await sleep(900);
  await page.tap("#lib-bili-btn"); await sleep(600);
  const before = await page.evaluate(() => ({ calls: window.__calls.slice(), qr: document.getElementById("qr-sheet").className, status: document.getElementById("qr-status").textContent }));
  console.log("before tap:", JSON.stringify(before));
  await page.tap("#bili-account-btn"); await sleep(900);
  const after = await page.evaluate(() => ({ calls: window.__calls.slice(), qr: document.getElementById("qr-sheet").className, status: document.getElementById("qr-status").textContent, pushed: uiStack.slice(), scrim: document.getElementById("scrim").className, openSheetEl: openSheetEl ? openSheetEl.id : null }));
  console.log("after tap:", JSON.stringify(after));
  console.log("errors:", errs.slice(0, 5).join(" | ") || "(无)");
  await browser.close();
})().catch(e => { console.error(e); process.exit(2); });

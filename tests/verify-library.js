// 资料库分类验证：歌曲 / 专辑 / 艺人（含专辑、艺人详情页与播放）
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
async function tapCentered(page, sel) {
  await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "center" });
  }, sel);
  await sleep(220);
  await page.tap(sel);
}
async function waitFor(page, fn, timeout = 6000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.evaluate(fn, arg)) return true;
    await sleep(120);
  }
  return false;
}
// 读取当前资料库分类页签
// 若停在歌单详情页则先返回资料库
async function ensureLibrary(page) {
  if (await page.$eval("#page-detail", e => e.classList.contains("active"))) {
    await tapCentered(page, "#detail-back");
    await sleep(600);
  }
}
const tabsState = page => page.evaluate(() => ({
  tab: window.libTab,
  segOn: Array.from(document.querySelectorAll("#lib-seg button")).filter(b => b.classList.contains("on")).map(b => b.dataset.tab),
  grid: !document.getElementById("lib-grid").classList.contains("hidden"),
  songs: !document.getElementById("lib-songs").classList.contains("hidden"),
  albums: !document.getElementById("lib-albums").classList.contains("hidden"),
  artists: !document.getElementById("lib-artists").classList.contains("hidden"),
  empty: !document.getElementById("lib-browse-empty").classList.contains("hidden"),
  guide: !document.getElementById("lib-empty").classList.contains("hidden"),
  sub: document.getElementById("lib-sub").textContent,
}));

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
  page.on("requestfailed", r => {
    const u = r.url();
    if (/favicon/.test(u)) return;
    if (/^blob:/.test(u) && r.failure() && r.failure().errorText === "net::ERR_ABORTED") return;
    errors.push("[requestfailed] " + u + " " + (r.failure() && r.failure().errorText));
  });

  console.log("=== 1. 启动与分段控件 ===");
  await page.goto(URL, { waitUntil: "load" });
  await sleep(900);
  const labels = await page.$$eval("#lib-seg button", els => els.map(e => e.textContent.trim()));
  eq(labels.join("/"), "歌单/歌曲/专辑/艺人", "资料库分类：歌单/歌曲/专辑/艺人 四项");
  let st = await tabsState(page);
  eq(st.tab, "lists", "默认停在「歌单」");
  ok(!st.songs && !st.albums && !st.artists && (st.grid || st.guide), "默认只显示歌单区（空库时为引导）", JSON.stringify(st));
  ok(errors.length === 0, "启动无 JS 错误", errors.join(" | "));

  console.log("=== 2. 空资料库时的分类提示 ===");
  await page.tap('#lib-seg button[data-tab="songs"]');
  await sleep(400);
  st = await tabsState(page);
  ok(st.songs && st.empty, "无歌曲时歌曲页显示空状态");
  const emptyTxt = await page.$eval("#lib-browse-empty", e => e.textContent);
  ok(/还没有歌曲/.test(emptyTxt), "空状态文案", emptyTxt.slice(0, 30));
  await shot(page, "40-lib-empty-songs");
  await page.tap('#lib-seg button[data-tab="lists"]');
  await sleep(300);

  console.log("=== 3. 导入 6 首（含带标签文件） ===");
  await page.tap("#lib-empty-new");
  await sleep(350);
  await page.type("#dialog-input", "分类测试");
  await page.tap("#dialog-ok");
  await sleep(400);
  const input = await page.$("#pick-files");
  await input.uploadFile(
    path.join(FIXTURES, "song1-44100.wav"),
    path.join(FIXTURES, "song2-48000.wav"),
    path.join(FIXTURES, "song3-96000.wav"),
    path.join(FIXTURES, "song4-tagged.mp3"),
    path.join(FIXTURES, "song5-tagged.flac"),
    path.join(FIXTURES, "song6-tagged.m4a")
  );
  await sleep(3000);
  eq(await page.$$eval("#detail-list li[data-id]", els => els.length), 6, "导入 6 首");

  // 记录元数据（标签解析结果），供分组断言使用
  const meta = await page.evaluate(() => {
    const out = {};
    lib.forEach(p => p.items.forEach(it => {
      const m = metaCache.get(it.id) || {};
      out[it.name] = { title: m.title || "", artist: m.artist || "", album: m.album || "", loaded: !!m.loaded };
    }));
    return out;
  });
  const clean = s => Object.fromEntries(Object.entries(s).map(([k, v]) => [k,
    { title: String(v.title).replace(/[^\x20-\x7E\u4e00-\u9fa5]/g, "?"),
      artist: String(v.artist).replace(/[^\x20-\x7E\u4e00-\u9fa5]/g, "?"),
      album: String(v.album).replace(/[^\x20-\x7E\u4e00-\u9fa5]/g, "?") }]));
  console.log("    元数据:", JSON.stringify(clean(meta)));

  console.log("=== 4. 歌曲分类（全部歌曲） ===");
  await ensureLibrary(page);   // 导入后停在歌单详情页，先返回资料库
  await page.tap('#lib-seg button[data-tab="songs"]');
  await sleep(1500);
  st = await tabsState(page);
  ok(st.songs && !st.grid && !st.albums && !st.artists, "切到「歌曲」只显示歌曲列表");
  ok(st.segOn.length === 1 && st.segOn[0] === "songs", "分段控件高亮跟随");
  ok(/^6 首歌曲/.test(st.sub), "标题副标题显示歌曲数（并标注当前排序方式）", st.sub);
  eq(await page.$$eval("#lib-songs li[data-id]", els => els.length), 6, "歌曲列表 6 行");
  const songRows = await page.$$eval("#lib-songs li[data-id]", els => els.map(li => ({
    id: li.dataset.id,
    title: li.querySelector(".song-name").textContent,
    sub: li.querySelector(".song-sub").textContent,
  })));
  const mp3Row = songRows.find(r => /Hibiki Band/.test(r.sub));
  ok(!!mp3Row, "MP3 行显示「艺人 · 专辑」", JSON.stringify(songRows.map(r => r.sub)));
  ok(!!mp3Row && /Test Album/.test(mp3Row.sub), "MP3 行含专辑名 Test Album", mp3Row && mp3Row.sub);
  await shot(page, "41-lib-songs");

  console.log("=== 5. 专辑分类 ===");
  await page.tap('#lib-seg button[data-tab="albums"]');
  await sleep(1500);
  st = await tabsState(page);
  ok(st.albums && !st.songs, "切到「专辑」");
  const albumCards = await page.$$eval("#lib-albums .lib-card", els => els.map(c => ({
    key: c.dataset.groupKey,
    name: c.querySelector(".lib-card-name").textContent,
    count: c.querySelector(".lib-card-count").textContent,
  })));
  const albumNames = albumCards.map(c => c.name);
  const expectAlbums = Array.from(new Set(Object.values(meta).map(m => m.album || "未知专辑"))).sort();
  eq(albumNames.slice().sort().join("|"), expectAlbums.join("|"), "专辑分组与标签一致");
  ok(albumNames.indexOf("Test Album") >= 0, "存在 Test Album 专辑卡", albumNames.join("/"));
  const testAlbum = albumCards.find(c => c.name === "Test Album");
  eq(testAlbum.count, "1 首 · Hibiki Band", "专辑卡显示首数与艺人");
  eq(st.sub, albumCards.length + " 张专辑", "副标题显示专辑数");
  await shot(page, "42-lib-albums");

  console.log("=== 6. 艺人分类 ===");
  await page.tap('#lib-seg button[data-tab="artists"]');
  await sleep(1500);
  const artistRows = await page.$$eval("#lib-artists .artist-row", els => els.map(r => ({
    key: r.dataset.groupKey,
    name: r.querySelector(".artist-name").textContent,
    sub: r.querySelector(".artist-sub").textContent,
    avatarRadius: getComputedStyle(r.querySelector(".artist-avatar")).borderRadius,
    avatarBg: r.querySelector(".artist-avatar").style.backgroundImage || r.querySelector(".artist-avatar").style.background,
  })));
  const artistNames = artistRows.map(r => r.name);
  const expectArtists = Array.from(new Set(Object.values(meta).map(m => m.artist || "未知艺术家"))).sort();
  eq(artistNames.slice().sort().join("|"), expectArtists.join("|"), "艺人分组与标签一致");
  const bandRow = artistRows.find(r => r.name === "Hibiki Band");
  ok(!!bandRow && /1 首歌/.test(bandRow.sub), "Hibiki Band 行显示歌曲数", bandRow && bandRow.sub);
  ok(artistRows.every(r => /50%|\d+px/.test(r.avatarRadius)), "艺人为圆形头像行", artistRows[0] && artistRows[0].avatarRadius);
  ok(artistRows.every(r => parseFloat(r.avatarRadius) >= 20), "头像为圆形（圆角 ≥ 半宽）", JSON.stringify(artistRows.map(r => r.avatarRadius)));
  const unknown = artistRows.find(r => r.name === "未知艺术家");
  if (unknown) {
    const ini = await page.$eval('#lib-artists .artist-row[data-group-key="?"] .artist-avatar .ini', e => e.textContent).catch(() => "");
    ok(ini.length > 0, "无标签艺人头像显示首字", ini);
  }
  st = await tabsState(page);
  ok(new RegExp("^" + artistRows.length + " 位艺人").test(st.sub), "副标题显示艺人数（并标注按首字母）", st.sub);
  await shot(page, "43-lib-artists");

  console.log("=== 7. 专辑详情页 ===");
  await page.evaluate(() => {
    const cards = document.querySelectorAll("#lib-albums .lib-card");
    for (const c of cards) if (c.querySelector(".lib-card-name").textContent === "Test Album") { c.click(); return; }
  });
  await sleep(700);
  ok(await page.$eval("#page-group", e => e.classList.contains("active")), "专辑页打开");
  eq(await page.$eval("#group-title", e => e.textContent), "Test Album", "专辑页标题");
  const gmeta = await page.$eval("#group-meta", e => e.textContent);
  ok(/1 首/.test(gmeta), "专辑页显示曲目数", gmeta);
  ok(/Hibiki Band/.test(gmeta), "专辑页显示艺人", gmeta);
  eq(await page.$$eval("#group-list li[data-id]", els => els.length), 1, "专辑页 1 首");
  eq(await page.evaluate(() => document.querySelector("#group-list li[data-id]").dataset.id), mp3Row.id, "专辑页内容为该 mp3");
  await shot(page, "44-group-album");

  console.log("=== 8. 专辑页播放全部 ===");
  await page.tap("#group-play");
  await sleep(2200);
  ok(await page.evaluate(() => !document.getElementById("mini-player").classList.contains("gone")), "播放开始（迷你条出现）");
  eq(await page.evaluate(() => document.getElementById("np-title").textContent), "星空之下", "正在播放标题来自标签");
  eq(await page.evaluate(() => pl.length), 1, "队列 = 专辑曲目数");
  eq(await page.evaluate(() => document.querySelector("#group-list li[data-id]").classList.contains("current")), true, "专辑页当前曲目高亮");

  console.log("=== 9. 系统返回键关闭分类页 ===");
  await page.goBack();
  await sleep(700);
  ok(!(await page.$eval("#page-group", e => e.classList.contains("active"))), "返回后专辑页关闭");
  ok(await page.$eval("#page-library", e => e.classList.contains("active")), "回到资料库");

  console.log("=== 10. 艺人详情页 + 行内播放 ===");
  await ensureLibrary(page);
  await page.evaluate(() => {
    const rows = document.querySelectorAll("#lib-artists .artist-row");
    for (const r of rows) if (r.querySelector(".artist-name").textContent === "Hibiki Band") { r.click(); return; }
  });
  await sleep(700);
  eq(await page.$eval("#group-title", e => e.textContent), "Hibiki Band", "艺人页标题");
  ok(await page.$eval("#group-hero-cover", e => e.classList.contains("round")), "艺人页封面为圆形");
  const artMeta = await page.$eval("#group-meta", e => e.textContent);
  ok(/1 首/.test(artMeta), "艺人页显示曲目数", artMeta);
  await shot(page, "45-group-artist");
  await page.evaluate(() => document.querySelector("#group-list li[data-id]").click());
  await sleep(2200);
  eq(await page.evaluate(() => curKey), mp3Row.id, "从艺人页点击歌曲开始播放");
  ok(await page.evaluate(() => !document.getElementById("mini-player").classList.contains("gone")), "迷你条保持播放");
  await page.goBack();
  await sleep(600);

  console.log("=== 11. 未知专辑归类 ===");
  await page.tap('#lib-seg button[data-tab="albums"]');
  await sleep(1200);
  const unknownCard = await page.evaluate(() => {
    const cards = document.querySelectorAll("#lib-albums .lib-card");
    for (const c of cards) if (c.querySelector(".lib-card-name").textContent === "未知专辑") return c.querySelector(".lib-card-count").textContent;
    return null;
  });
  const expectUnknown = Object.values(meta).filter(m => !m.album).length;
  ok(unknownCard !== null, "无标签歌曲归入「未知专辑」", String(unknownCard));
  if (unknownCard) eq(unknownCard.indexOf(String(expectUnknown) + " 首"), 0, "未知专辑数量 = 无专辑标签曲目数 (" + expectUnknown + ")");

  console.log("=== 12. 页签持久化 ===");
  await page.reload({ waitUntil: "load" });
  await sleep(1400);
  st = await tabsState(page);
  eq(st.tab, "albums", "刷新后仍停留在「专辑」");
  ok(st.albums, "刷新后显示专辑视图");
  const reloaded = await waitFor(page, (n) => document.querySelectorAll("#lib-albums .lib-card").length === n, 8000, albumCards.length);
  ok(reloaded, "刷新后专辑数一致（等待元数据重新解析）",
    await page.$$eval("#lib-albums .lib-card", els => els.length) + " vs " + albumCards.length);

  console.log("=== 13. 从歌曲分类页播放 ===");
  await ensureLibrary(page);
  await page.tap('#lib-seg button[data-tab="songs"]');
  await sleep(1200);
  await page.evaluate((id) => {
    const li = document.querySelector('#lib-songs li[data-id="' + CSS.escape(id) + '"]');
    if (li) li.click();
  }, mp3Row.id);
  await sleep(2000);
  eq(await page.evaluate(() => curKey), mp3Row.id, "歌曲分类页点击即播放");
  ok(await page.evaluate(() => !document.getElementById("mini-player").classList.contains("gone")), "歌曲分类页播放后迷你条出现");
  await shot(page, "46-lib-songs-playing");

  console.log("=== 14b. 分类页内移除最后一首 ===");
  await page.tap('#lib-seg button[data-tab="albums"]');
  await sleep(900);
  await page.evaluate(() => {
    const cards = document.querySelectorAll("#lib-albums .lib-card");
    for (const c of cards) if (c.querySelector(".lib-card-name").textContent === "Test Album") { c.click(); return; }
  });
  await sleep(700);
  const hadAlbumPage = await page.$eval("#page-group", e => e.classList.contains("active"));
  if (hadAlbumPage) {
    await page.evaluate(() => {
      const li = document.querySelector("#group-list li[data-id]");
      if (li) li.querySelector(".song-menu-btn").click();
    });
    await sleep(500);
    // 分类页里的菜单第一项是「从『某歌单』移除」（只从歌单移除，歌还在资料库）；
    // 要让整个分类消失必须选「从资料库移除」
    await page.evaluate(() => {
      const btns = document.querySelectorAll("#menu .menu-item");
      for (const b of btns) if (/从资料库移除/.test(b.textContent)) { b.click(); return; }
    });
    await sleep(900);
    ok(!(await page.$eval("#page-group", e => e.classList.contains("active"))), "从资料库移除分类最后一首后，分类页自动关闭");
    ok(await page.$eval("#page-library", e => e.classList.contains("active")), "回到资料库");
    const albumsLeft = await page.$$eval("#lib-albums .lib-card .lib-card-name", els => els.map(e => e.textContent));
    ok(albumsLeft.indexOf("Test Album") < 0, "该专辑已从专辑栏消失", albumsLeft.join("/"));
  } else {
    ok(false, "专辑详情页应能打开（前置步骤）");
  }

  console.log("=== 14. 移除歌曲后分类自动更新 ===");
  await page.tap('#lib-seg button[data-tab="songs"]');
  await sleep(900);
  const before = await page.$$eval("#lib-songs li[data-id]", els => els.length);
  await page.evaluate(() => {
    const li = document.querySelector('#lib-songs li[data-id]');
    li.querySelector(".song-menu-btn").click();
  });
  await sleep(400);
  const menu = await page.$$eval("#menu .menu-item", els => els.map(e => e.textContent));
  ok(menu.some(t => /从「分类测试」移除/.test(t)), "分类页菜单显示所属歌单", menu.join(" | "));
  ok(menu.some(t => /从资料库移除/.test(t)), "分类页菜单提供「从资料库移除」", menu.join(" | "));
  // 只从歌单移除：歌曲仍留在资料库（这是「删歌单不删歌」的基础）
  await page.evaluate(() => {
    const btns = document.querySelectorAll("#menu .menu-item");
    for (const b of btns) if (/从「分类测试」移除/.test(b.textContent)) { b.click(); return; }
  });
  await sleep(900);
  eq(await page.$$eval("#lib-songs li[data-id]", els => els.length), before, "只从歌单移除时，歌曲仍留在资料库");
  // 再从资料库移除：这首歌才从分类里消失
  await page.evaluate(() => {
    const li = document.querySelector('#lib-songs li[data-id]');
    li.querySelector(".song-menu-btn").click();
  });
  await sleep(400);
  await page.evaluate(() => {
    const btns = document.querySelectorAll("#menu .menu-item");
    for (const b of btns) if (/从资料库移除/.test(b.textContent)) { b.click(); return; }
  });
  await sleep(900);
  eq(await page.$$eval("#lib-songs li[data-id]", els => els.length), before - 1, "从资料库移除后，歌曲分类同步减少");
  await page.tap('#lib-seg button[data-tab="artists"]');
  await sleep(900);
  const artistsAfter = await page.$$eval("#lib-artists .artist-row .artist-name", els => els.map(e => e.textContent));
  ok(artistsAfter.length <= artistRows.length, "艺人分类同步刷新", artistsAfter.join("/"));

  console.log("=== 15. 分类视图的视觉与布局 ===");
  await page.tap('#lib-seg button[data-tab="albums"]');
  await sleep(700);
  const albumGeo = await page.evaluate(() => {
    const c = document.querySelector("#lib-albums .lib-cover");
    const r = c.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), cols: getComputedStyle(document.getElementById("lib-albums")).gridTemplateColumns.split(" ").length };
  });
  eq(albumGeo.w, albumGeo.h, "专辑封面为 1:1 正方形");
  eq(albumGeo.cols, 2, "专辑网格两列（与歌单一致）");
  await page.tap('#lib-seg button[data-tab="artists"]');
  await sleep(700);
  const geo = await page.evaluate(() => {
    const seg = document.getElementById("lib-seg");
    const btns = Array.from(seg.querySelectorAll("button"));
    const r = seg.getBoundingClientRect();
    const on = btns.find(b => b.classList.contains("on"));
    const art = document.querySelector("#lib-artists .artist-row .artist-avatar");
    return {
      height: Math.round(r.height),
      widths: btns.map(b => Math.round(b.getBoundingClientRect().width)),
      onBg: on ? getComputedStyle(on).backgroundColor : "",
      trackBg: getComputedStyle(seg).backgroundColor,
      radius: getComputedStyle(seg).borderRadius,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      pageOverflow: document.getElementById("page-library").scrollWidth - document.getElementById("page-library").clientWidth,
      artSize: getComputedStyle(art).width,
      artRadius: getComputedStyle(art).borderRadius,
      avatarCount: document.querySelectorAll("#lib-artists .artist-avatar").length,
      rowCount: document.querySelectorAll("#lib-artists .artist-row").length,
    };
  });
  ok(geo.overflowX <= 0 && geo.pageOverflow <= 0, "分类视图无横向溢出", JSON.stringify(geo));
  eq(geo.widths.length, 4, "分段控件四项");
  ok(Math.max(...geo.widths) - Math.min(...geo.widths) <= 2, "四个分段等宽", JSON.stringify(geo.widths));
  ok(geo.onBg !== geo.trackBg, "选中项有独立滑块底色", geo.onBg + " vs " + geo.trackBg);
  ok(geo.height >= 28 && geo.height <= 40, "分段控件高度符合 iOS 尺寸", geo.height);
  eq(geo.radius, "9px", "分段控件圆角");
  eq(geo.artSize, "54px", "艺人头像 54px");
  eq(geo.artRadius, "50%", "艺人头像圆形");
  ok(geo.rowCount > 0 && geo.avatarCount === geo.rowCount, "每行都有头像", geo.avatarCount + "/" + geo.rowCount);
  await shot(page, "47-lib-artists-design");

  console.log("=== 16. 大规模资料库下的分类渲染 ===");
  const perf = await page.evaluate(() => {
    const base = lib[0];
    const real = songUniverse().length;
    for (let i = 0; i < 300; i++) base.items.push({ id: "fake_" + i, name: "fake-" + String(i).padStart(3, "0") + ".mp3", dur: 100 });
    saveLib();
    const t0 = performance.now();
    setLibTab("albums");
    setLibTab("songs");
    const t1 = performance.now();
    return {
      real: real,
      render: Math.round(t1 - t0),
      rows: document.querySelectorAll("#lib-songs li[data-id]").length,
      missing: document.querySelectorAll("#lib-songs li.missing").length,
    };
  });
  eq(perf.rows, perf.real + 300, "既有 " + perf.real + " 首 + 新增 300 首（含未注册文件）全部渲染");
  ok(perf.render < 3000, "两次分类切换渲染 < 3s", perf.render + "ms");
  await sleep(2200);
  const stable = await page.evaluate(() => ({
    rows: document.querySelectorAll("#lib-songs li[data-id]").length,
    errors: 0,
  }));
  eq(stable.rows, perf.rows, "文件不可用不会导致列表抖动（无重试风暴）");
  await shot(page, "48-lib-songs-large");

  console.log("=== 17. 删除歌单后，导入的歌曲仍留在资料库 ===");
  const keepDst = path.join(FIXTURES, "删除歌单测试曲.wav");
  fs.copyFileSync(path.join(FIXTURES, "song1-44100.wav"), keepDst);
  const keepPl = await page.evaluate(async () => {
    const p = { id: "plK" + Date.now().toString(36), name: "待删除歌单", coverMode: "first", coverImageId: null, items: [] };
    lib.push(p); curPlId = p.id; saveLib(); renderLibrary();
    return { id: p.id };
  });
  await page.evaluate((id) => openDetail(id), keepPl.id);
  await sleep(500);
  const pickKeep = await page.$("#pick-files");
  await pickKeep.uploadFile(keepDst);
  await sleep(2200);
  const afterImport = await page.evaluate((id) => ({
    inPl: (plById(id) || { items: [] }).items.length,
    inLib: libSongs.some(s => /删除歌单测试曲/.test(s.name)),
    saved: JSON.parse(localStorage.getItem("hpa.lib.v1")).songs.length,
  }), keepPl.id);
  eq(afterImport.inPl, 1, "导入后歌曲在该歌单里");
  ok(afterImport.inLib, "导入的歌曲同时登记进资料库");
  ok(afterImport.saved >= 1, "资料库歌曲已持久化", String(afterImport.saved));
  await page.evaluate(() => { closeDetail(); });     // 回到资料库主页，后面的长按才落在歌单卡片上
  await sleep(600);
  await page.evaluate(() => setLibTab("songs"));
  await sleep(900);
  const songsBefore = await page.$$eval("#lib-songs li[data-id]", els => els.length);
  const listedBefore = await page.evaluate(() => Array.prototype.some.call(
    document.querySelectorAll("#lib-songs .song-name .nm"), e => /删除歌单测试曲/.test(e.textContent)));
  ok(listedBefore, "删除前该歌曲出现在「歌曲」分类里");
  // 走真实流程删除歌单：长按卡片 → 删除歌单 → 确认
  await page.evaluate(() => setLibTab("lists"));
  await sleep(600);
  const delCard = await page.evaluate((id) => {
    const c = document.querySelector('#lib-grid .lib-card[data-pl-id="' + id + '"]');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, keepPl.id);
  ok(!!delCard, "找到待删除歌单的卡片");
  await page.mouse.move(delCard.x, delCard.y);
  await page.mouse.down(); await sleep(700); await page.mouse.up();
  await sleep(500);
  const menuState = await page.evaluate(() => ({
    open: document.getElementById("menu").classList.contains("open"),
    items: Array.prototype.map.call(document.querySelectorAll("#menu-items .menu-item"), e => e.textContent.slice(0, 12)),
  }));
  console.log("    删除歌单诊断：菜单 " + JSON.stringify(menuState));
  await page.evaluate(() => {
    const items = Array.prototype.slice.call(document.querySelectorAll("#menu-items .menu-item"));
    const m = items.filter(i => /删除歌单/.test(i.textContent))[0];
    if (m) m.click();
  });
  await sleep(500);
  const dlg = await page.evaluate(() => ({
    on: document.getElementById("dialog").classList.contains("on"),
    note: document.getElementById("dialog-note").textContent,
  }));
  console.log("    删除歌单诊断：弹窗 " + JSON.stringify(dlg));
  const noteText = dlg.note;
  ok(/保留/.test(noteText), "删除确认里说明歌曲会保留", noteText);
  await page.tap("#dialog-ok");
  await sleep(900);
  const afterDel = await page.evaluate((id) => ({
    plGone: !plById(id),
    libSize: lib.length,
    inLib: libSongs.some(s => /删除歌单测试曲/.test(s.name)),
  }), keepPl.id);
  ok(afterDel.plGone, "歌单已删除");
  ok(afterDel.inLib, "歌曲仍保留在资料库记录里");
  await page.evaluate(() => setLibTab("songs"));
  await sleep(900);
  const songsAfter = await page.$$eval("#lib-songs li[data-id]", els => els.length);
  const listedAfter = await page.evaluate(() => Array.prototype.some.call(
    document.querySelectorAll("#lib-songs .song-name .nm"), e => /删除歌单测试曲/.test(e.textContent)));
  eq(songsAfter, songsBefore, "「歌曲」分类数量不变");
  ok(listedAfter, "删除歌单后，歌曲仍在「歌曲」分类里（核心修复）");
  const rowMissing = await page.evaluate(() => Array.prototype.some.call(
    document.querySelectorAll("#lib-songs li[data-id]"),
    li => /删除歌单测试曲/.test(li.textContent) && li.classList.contains("missing")));
  ok(!rowMissing, "歌曲仍可用（没有 ⚠️ 缺失标记）");
  await page.tap('#lib-seg button[data-tab="artists"]');
  await sleep(900);
  const artistStill = await page.evaluate(() => Array.prototype.some.call(
    document.querySelectorAll("#lib-artists .artist-name"), e => /未知/.test(e.textContent)));
  ok(artistStill, "艺人分类仍能刷新（未知艺人分组还在）");
  await shot(page, "49-delete-playlist-keeps-songs");

  console.log("=== 18. 全部歌曲：长按多选删除 ===");
  await page.evaluate(() => { showPage("library"); setLibTab("songs"); });
  await sleep(900);
  const mselBefore = await page.evaluate(() => ({
    rows: document.querySelectorAll("#lib-songs li[data-id]").length,
    libSongs: libSongs.length,
    curKey: curKey || "",
  }));
  ok(mselBefore.rows >= 2, "歌曲列表有多首可选", String(mselBefore.rows));
  const firstRow = await page.evaluate(() => {
    const li = document.querySelector("#lib-songs li[data-id]");
    const r = li.getBoundingClientRect();
    return { id: li.dataset.id, x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(firstRow.x, firstRow.y);
  await page.mouse.down(); await sleep(700); await page.mouse.up();
  await sleep(600);
  const entered = await page.evaluate((id) => ({
    bar: document.getElementById("msel-bar").classList.contains("on"),
    boxMsel: document.getElementById("lib-songs").classList.contains("msel"),
    rowSelected: !!document.querySelector('#lib-songs li[data-id="' + CSS.escape(id) + '"].sel'),
    checkShown: (() => { const c = document.querySelector("#lib-songs li[data-id] .check"); return c ? getComputedStyle(c).display : "none"; })(),
    delText: document.getElementById("msel-del").textContent,
    playing: curKey || "",
  }), firstRow.id);
  ok(entered.bar && entered.boxMsel, "长按歌曲行进入多选（操作条出现）", JSON.stringify(entered));
  ok(entered.rowSelected, "长按的那一行已勾选");
  eq(entered.checkShown, "flex", "多选时显示勾选圈");
  ok(/1/.test(entered.delText), "删除按钮显示已选 1 首", entered.delText);
  eq(entered.playing, mselBefore.curKey, "长按没有触发播放");
  await page.evaluate(() => document.querySelectorAll("#lib-songs li[data-id]")[1].click());
  await sleep(300);
  const two = await page.evaluate(() => ({
    sel: document.querySelectorAll("#lib-songs li.sel").length,
    delText: document.getElementById("msel-del").textContent,
    playing: curKey || "",
  }));
  eq(two.sel, 2, "点击行是勾选（可多选）");
  ok(/2/.test(two.delText), "计数更新为 2", two.delText);
  eq(two.playing, mselBefore.curKey, "多选中点击不会播放");
  await shot(page, "50-lib-songs-msel");
  await page.tap("#msel-all"); await sleep(400);
  const allSel = await page.evaluate(() => ({
    sel: document.querySelectorAll("#lib-songs li.sel").length,
    rows: document.querySelectorAll("#lib-songs li[data-id]").length,
    label: document.getElementById("msel-all").textContent,
  }));
  eq(allSel.sel, allSel.rows, "全选勾中全部歌曲");
  eq(allSel.label, "取消全选", "按钮变为「取消全选」");
  await page.tap("#msel-all"); await sleep(400);
  eq(await page.evaluate(() => document.querySelectorAll("#lib-songs li.sel").length), 0, "再次点击取消全选");
  // 选两首「确实在资料库里」的歌（列表是并集，可能含已从资料库移除过、或文档里的合成曲目）
  const pickInfo = await page.evaluate(() => {
    const rows = Array.prototype.slice.call(document.querySelectorAll("#lib-songs li[data-id]"));
    const picks = rows.filter(r => libSongHas(r.dataset.id)).slice(0, 2);
    picks.forEach(r => r.click());
    return {
      ids: picks.map(r => r.dataset.id),
      libBefore: libSongs.length,
      regBefore: picks.map(r => registry.has(r.dataset.id)),
    };
  });
  const pickIds = pickInfo.ids;
  ok(pickIds.length === 2, "选中 2 首资料库歌曲");
  await sleep(300);
  await page.tap("#msel-del"); await sleep(500);
  const dlgText2 = await page.evaluate(() => document.getElementById("dialog-note").textContent);
  ok(/音乐文件仍保留/.test(dlgText2), "删除确认说明音乐文件会保留", dlgText2);
  await page.tap("#dialog-ok"); await sleep(1000);
  const afterDel2 = await page.evaluate((ids) => ({
    rows: document.querySelectorAll("#lib-songs li[data-id]").length,
    libSongs: libSongs.length,
    gone: ids.every(id => !libSongs.some(s => s.id === id)),
    inAnyPl: ids.some(id => lib.some(p => p.items.some(it => it.id === id))),
    regAfter: ids.map(id => registry.has(id)),
    bar: document.getElementById("msel-bar").classList.contains("on"),
    boxMsel: document.getElementById("lib-songs").classList.contains("msel"),
  }), pickIds);
  eq(afterDel2.rows, mselBefore.rows - 2, "删除选中后歌曲列表减少 2 行");
  eq(afterDel2.libSongs, pickInfo.libBefore - 2, "资料库歌曲同步减少 2 首");
  ok(afterDel2.gone, "被删的歌已不在资料库里");
  ok(!afterDel2.inAnyPl, "同时从所有歌单里移除");
  ok(pickInfo.ids.every((id, i) => !pickInfo.regBefore[i] || afterDel2.regAfter[i]),
    "文件注册表未删除（音乐文件仍在手机上）", JSON.stringify({ before: pickInfo.regBefore, after: afterDel2.regAfter }));
  ok(!afterDel2.bar && !afterDel2.boxMsel, "多选状态自动退出");
  await shot(page, "51-lib-songs-msel-done");

  // 收尾：把这首歌从资料库移除，避免影响后续断言
  await page.evaluate((name) => {
    const s = libSongs.filter(x => x.name.indexOf(name) >= 0)[0];
    if (s) removeFromLibrary(s.id);
  }, "删除歌单测试曲");
  await sleep(400);
  try { fs.unlinkSync(keepDst); } catch (e) {}
  ok(errors.length === 0, "全程无 JS 错误", errors.slice(0, 3).join(" | "));

  console.log("");
  console.log("通过 " + passed + " / " + (passed + failed));
  if (failed) console.log("失败：" + failures.join("; "));
  await browser.close();
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });

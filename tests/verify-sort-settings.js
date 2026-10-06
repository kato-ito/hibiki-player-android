// 本轮四项：下载放入歌单、长按拖动排序（真实触摸）、关于、排序方式与字母索引
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
function eq(a, b, name) { ok(a === b, name + (a === b ? "" : "  (got=" + JSON.stringify(a) + " want=" + JSON.stringify(b) + ")")); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function shot(page, n) { try { await page.screenshot({ path: path.join(SHOTS, n + ".png") }); } catch (e) {} }

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errors = [];
  page.on("console", m => {
    // 假 BOOT base 会让「下载曲目」的时长探测请求失败，这类网络错误属于测试环境预期
    if (m.type() === "error" && !/ERR_CONNECTION_REFUSED|net::|Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 140));
  });
  page.on("pageerror", e => errors.push("pageerror: " + e.message.slice(0, 160)));
  const cdp = await page.target().createCDPSession();
  // file:// 下 BOOT 为 null，而「下载完成 → 放入歌单」会走 registerHttp(BOOT.base + ...)：
  // 这里给一个假的 base，让这条链路在浏览器模式下也能跑通（不会真的发请求）
  await page.evaluateOnNewDocument(() => { window.__HIBIKI_BOOT__ = { base: "http://127.0.0.1:18080" }; });
  await page.goto(URL, { waitUntil: "load" });
  await sleep(900);

  await page.tap("#lib-empty-new"); await sleep(320);
  await page.type("#dialog-input", "排序测试");
  await page.tap("#dialog-ok"); await sleep(420);
  const input = await page.$("#pick-files");
  await input.uploadFile(path.join(FIXTURES, "song1-44100.wav"), path.join(FIXTURES, "song2-48000.wav"),
    path.join(FIXTURES, "song3-96000.wav"), path.join(FIXTURES, "song4-tagged.mp3"));
  await sleep(2600);

  const meta = await page.evaluate(() => {
    const titles = ["周杰伦 - 晴天", "Beyond - 海阔天空", "阿肆 - 热爱105", "3 Doors Down - Kryptonite"];
    const artists = ["周杰伦", "Beyond", "阿肆", "3 Doors Down"];
    const albums = ["叶惠美", "乐与怒", "热爱", "The Better Life"];
    const items = lib[0].items;
    items.forEach((it, i) => {
      metaCache.set(it.id, { title: titles[i % 4], artist: artists[i % 4], album: albums[i % 4], cover: null, loaded: true });
    });
    return { n: items.length, ids: items.map(i => i.id) };
  });
  eq(meta.n, 4, "导入 4 首用于排序测试");

  console.log("=== 1. 关于（按当前功能重写） ===");
  const about = await page.evaluate(async () => {
    showPage("settings");
    await new Promise(r => setTimeout(r, 300));
    return { note: document.getElementById("about-note").textContent, foot: document.getElementById("set-foot").textContent, ver: APP_VERSION };
  });
  ok(about.note.indexOf("v" + about.ver) >= 0, "关于里显示当前版本号", about.ver);
  ok(/FFmpeg/.test(about.note) && /杜比/.test(about.note), "写明杜比/DTS 由内置 FFmpeg 解码");
  ok(/B 站音频下载/.test(about.note), "写明 B 站音频下载能力");
  ok(/字母索引/.test(about.note) && /排序/.test(about.note), "写明排序与字母索引");
  ok(/下载放入歌单/.test(about.note), "写明下载放入歌单");
  ok(!/桌面版专属/.test(about.note), "不再写「桌面版专属功能」（已过时）");
  ok(about.foot.indexOf("v" + about.ver) >= 0, "页面底部版本号同步", about.foot);
  await shot(page, "60-about");

  console.log("=== 2. 下载放入歌单 ===");
  const pl0 = await page.evaluate(() => ({ text: document.getElementById("set-bili-pl-val").textContent, id: biliPl }));
  eq(pl0.text, "B站下载（默认）", "默认放入《B站下载》");
  eq(pl0.id, "", "默认没有指定歌单 id");
  await page.tap("#set-bili-pl"); await sleep(420);
  const menuItems = await page.$$eval("#menu-items .menu-item", els => els.map(e => e.textContent));
  ok(menuItems.some(t => /排序测试/.test(t)), "菜单列出已有歌单", JSON.stringify(menuItems).slice(0, 130));
  ok(menuItems.some(t => /新建歌单/.test(t)), "菜单提供「新建歌单」");
  ok(menuItems.some(t => /恢复默认/.test(t)), "菜单提供「恢复默认」");
  await page.evaluate(() => {
    const items = Array.prototype.slice.call(document.querySelectorAll("#menu-items .menu-item"));
    const m = items.filter(i => /排序测试/.test(i.textContent))[0];
    if (m) m.click();
  });
  await sleep(450);
  const pl1 = await page.evaluate(() => ({ text: document.getElementById("set-bili-pl-val").textContent, id: biliPl, saved: JSON.parse(localStorage.getItem("hpa.prefs.v1")).biliPl }));
  eq(pl1.text, "排序测试", "选择后设置项显示所选歌单");
  ok(!!pl1.id && pl1.saved === pl1.id, "选择已写入偏好设置", JSON.stringify(pl1));
  const auto = await page.evaluate(() => {
    const target = plById(biliPl);
    const before = target.items.length;
    registerHttp("dl1", "下载测试曲目.m4a", 1024);
    biliAutoAdd({ entryId: "dl1", entryName: "下载测试曲目.m4a", entrySize: 1024, codec: "mp4a.40.2" });
    const t = plById(biliPl);
    return { before: before, after: t.items.length, name: t.name, inTarget: t.items.some(i => i.id === "dl1") };
  });
  eq(auto.after, auto.before + 1, "下载完成后音频放进所选歌单");
  ok(auto.inTarget, "曲目确实在《" + auto.name + "》里");
  await page.tap("#set-bili-pl"); await sleep(420);
  await page.evaluate(() => {
    const items = Array.prototype.slice.call(document.querySelectorAll("#menu-items .menu-item"));
    const m = items.filter(i => /新建歌单/.test(i.textContent))[0];
    if (m) m.click();
  });
  await sleep(420);
  await page.type("#dialog-input", "新建下载歌单");
  await page.tap("#dialog-ok"); await sleep(520);
  const pl2 = await page.evaluate(() => ({ text: document.getElementById("set-bili-pl-val").textContent, exists: lib.some(p => p.name === "新建下载歌单") }));
  eq(pl2.text, "新建下载歌单", "新建后目标切换为新歌单");
  ok(pl2.exists, "新歌单已创建");
  const pl3 = await page.evaluate(async () => {
    registerHttp("dl2", "第二首.m4a", 2048);
    biliAutoAdd({ entryId: "dl2", entryName: "第二首.m4a", entrySize: 2048 });
    await new Promise(r => setTimeout(r, 200));
    const p = lib.filter(x => x.name === "新建下载歌单")[0];
    return { n: p.items.length, has: p.items.some(i => i.id === "dl2") };
  });
  ok(pl3.has && pl3.n === 1, "再下载一首 → 进入新建的歌单", JSON.stringify(pl3));
  await page.tap("#set-bili-pl"); await sleep(420);
  await page.evaluate(() => {
    const items = Array.prototype.slice.call(document.querySelectorAll("#menu-items .menu-item"));
    const m = items.filter(i => /恢复默认/.test(i.textContent))[0];
    if (m) m.click();
  });
  await sleep(420);
  const pl4 = await page.evaluate(async () => {
    registerHttp("dl3", "第三首.m4a", 3072);
    biliAutoAdd({ entryId: "dl3", entryName: "第三首.m4a", entrySize: 3072 });
    await new Promise(r => setTimeout(r, 200));
    const def = lib.filter(p => p.name === "B站下载")[0];
    return { text: document.getElementById("set-bili-pl-val").textContent, def: !!def, inDef: def ? def.items.some(i => i.id === "dl3") : false };
  });
  ok(/B站下载/.test(pl4.text), "恢复默认后显示《B站下载》", pl4.text);
  ok(pl4.def && pl4.inDef, "默认歌单被自动创建并收到下载曲目");
  await shot(page, "61-download-playlist");

  console.log("=== 3. 全部歌曲排序方式 / 正倒序 / 字母索引 ===");
  await page.evaluate(() => { showPage("library"); setLibTab("songs"); });
  await sleep(700);
  const s0 = await page.evaluate(() => ({
    bar: !document.getElementById("sort-bar").classList.contains("hidden"),
    mode: document.getElementById("sort-mode").querySelector(".on").dataset.sort,
    dir: document.getElementById("sort-dir").querySelector(".on").dataset.dir,
    titles: Array.prototype.map.call(document.querySelectorAll("#lib-songs li[data-id] .song-name .nm"), e => e.textContent),
    heads: document.querySelectorAll("#lib-songs .grp-head").length,
    index: document.getElementById("alpha-index").classList.contains("hidden") ? 0 : document.querySelectorAll("#alpha-index .alpha-key").length,
  }));
  ok(s0.bar, "歌曲分类显示排序控件");
  eq(s0.mode, "default", "默认选中「默认排序」");
  eq(s0.dir, "asc", "默认选中「正序」");
  eq(s0.heads, 0, "默认排序没有字母分组标题");
  eq(s0.index, 0, "默认排序不显示字母索引条");
  const defTitles = s0.titles.join(" | ");
  ok(/阿肆|Beyond|周杰伦|3 Doors/.test(defTitles), "默认排序列出歌曲", defTitles.slice(0, 90));

  // 按加入顺序 = 歌单里的顺序
  await page.evaluate(() => document.querySelector('#sort-mode button[data-sort="added"]').click());
  await sleep(500);
  const addedOrder = await page.evaluate(() => ({
    titles: Array.prototype.map.call(document.querySelectorAll("#lib-songs li[data-id] .song-name .nm"), e => e.textContent),
    // 期望顺序 = 各歌单内的排列顺序，按首次出现去重（即「加入顺序」）
    expect: (() => {
      const seen = new Set(), out = [];
      lib.forEach(p => p.items.forEach(it => {
        if (!it || !it.id || seen.has(it.id)) return;
        seen.add(it.id);
        out.push((metaCache.get(it.id) || {}).title || String(it.name || "").replace(/\.[^.]+$/, ""));
      }));
      return out;
    })(),
    mode: document.getElementById("sort-mode").querySelector(".on").dataset.sort,
  }));
  eq(addedOrder.mode, "added", "切到「按加入顺序」");
  eq(addedOrder.titles.join("|"), addedOrder.expect.join("|"), "顺序与歌单内加入顺序一致");

  // 按首字母：分组标题 + 字母索引
  await page.evaluate(() => document.querySelector('#sort-mode button[data-sort="letter"]').click());
  await sleep(600);
  const letterView = await page.evaluate(() => ({
    heads: Array.prototype.map.call(document.querySelectorAll("#lib-songs .grp-head"), e => e.getAttribute("data-letter")),
    first: Array.prototype.map.call(document.querySelectorAll("#lib-songs li[data-id] .song-name .nm"), e => e.textContent),
    indexKeys: Array.prototype.map.call(document.querySelectorAll("#alpha-index .alpha-key"), e => e.textContent),
    empty: Array.prototype.map.call(document.querySelectorAll("#alpha-index .alpha-key.empty"), e => e.textContent),
    indexShown: !document.getElementById("alpha-index").classList.contains("hidden"),
  }));
  ok(letterView.indexShown, "按首字母时显示右侧字母索引条");
  eq(letterView.indexKeys.length, 27, "索引条含 A-Z 与 # 共 27 项", String(letterView.indexKeys.length));
  ok(letterView.heads.indexOf("A") >= 0 && letterView.heads.indexOf("Z") >= 0 && letterView.heads.indexOf("B") >= 0,
    "生成了 A / B / Z 分组标题", JSON.stringify(letterView.heads));
  ok(letterView.heads.indexOf("#") >= 0, "数字开头的歌曲归到 # 分组", JSON.stringify(letterView.heads));
  ok(letterView.empty.length > 0 && letterView.empty.length < 27, "没有内容的字母在索引里置灰", JSON.stringify(letterView.empty.slice(0, 8)));
  const zig = letterView.heads.indexOf("Z") >= 0 && letterView.heads.indexOf("B") >= 0 ? letterView.heads.indexOf("Z") > letterView.heads.indexOf("B") : true;
  ok(zig, "分组顺序按字母升序", JSON.stringify(letterView.heads));
  ok(/周杰伦/.test(letterView.first[0]) || /阿肆/.test(letterView.first[0]), "按首字母排序后首行是 A 组（阿肆）或同级", letterView.first[0]);

  // 点击字母跳转
  const jump = await page.evaluate(async () => {
    const scroller = document.getElementById("page-library");
    scroller.scrollTop = 0;
    await new Promise(r => setTimeout(r, 120));
    const key = Array.prototype.filter.call(document.querySelectorAll("#alpha-index .alpha-key"), b => b.textContent === "Z" && !b.classList.contains("empty"))[0];
    if (!key) return { missing: true };
    key.click();
    await new Promise(r => setTimeout(r, 500));
    const head = document.querySelector('#lib-songs .grp-head[data-letter="Z"]');
    const sc = document.getElementById("page-library").scrollTop;
    const top = head.getBoundingClientRect().top;
    return { scrollTop: Math.round(sc), headTop: Math.round(top), viewportTop: 0 };
  });
  ok(!jump.missing, "索引里有可点击的 Z");
  ok(jump.scrollTop > 0, "点击字母后列表滚动了", JSON.stringify(jump));
  ok(Math.abs(jump.headTop) < 120, "Z 分组标题滚动到视口顶部附近", JSON.stringify(jump));
  await shot(page, "62-sort-letter");

  // 倒序
  await page.evaluate(() => document.querySelector('#sort-dir button[data-dir="desc"]').click());
  await sleep(600);
  const desc = await page.evaluate(() => ({
    dir: document.getElementById("sort-dir").querySelector(".on").dataset.dir,
    heads: Array.prototype.map.call(document.querySelectorAll("#lib-songs .grp-head"), e => e.getAttribute("data-letter")),
    titles: Array.prototype.map.call(document.querySelectorAll("#lib-songs li[data-id] .song-name .nm"), e => e.textContent),
    saved: JSON.parse(localStorage.getItem("hpa.prefs.v1")).sortDir,
  }));
  eq(desc.dir, "desc", "切到「倒序」");
  eq(desc.saved, "desc", "方向写入偏好设置");
  ok(desc.heads.length && desc.heads[0] === "#" || desc.heads[0] === "Z", "倒序后分组从末尾开始", JSON.stringify(desc.heads));
  ok(/3 Doors|周杰伦/.test(desc.titles[0]), "倒序后首行来自末尾分组", desc.titles[0]);
  await shot(page, "63-sort-desc");
  // 还原
  await page.evaluate(() => { document.querySelector('#sort-dir button[data-dir="asc"]').click(); document.querySelector('#sort-mode button[data-sort="default"]').click(); });
  await sleep(500);

  console.log("=== 4. 艺人：默认首字母排序 + 字母索引 ===");
  await page.evaluate(() => setLibTab("artists"));
  await sleep(1200);
  const art = await page.evaluate(() => ({
    names: Array.prototype.map.call(document.querySelectorAll("#lib-artists .artist-row .artist-name"), e => e.textContent),
    heads: Array.prototype.map.call(document.querySelectorAll("#lib-artists .grp-head"), e => e.getAttribute("data-letter")),
    indexKeys: Array.prototype.map.call(document.querySelectorAll("#alpha-index .alpha-key"), e => e.textContent),
    indexShown: !document.getElementById("alpha-index").classList.contains("hidden"),
    sub: document.getElementById("lib-sub").textContent,
  }));
  ok(art.indexShown && art.indexKeys.length === 27, "艺人页也有字母索引条（27 项）", JSON.stringify({ shown: art.indexShown, n: art.indexKeys.length }));
  ok(art.heads.length >= 3, "艺人生成了字母分组标题", JSON.stringify(art.heads));
  const knownHeads = art.heads.filter(h => h !== "#");
  eq(knownHeads.join(""), knownHeads.slice().sort().join(""), "艺人分组标题按字母升序（默认首字母排序）");
  ok(art.heads[art.heads.length - 1] === "#" || art.heads.indexOf("#") < 0, "未知艺人归到 # 分组并排在最后", JSON.stringify(art.heads));
  ok(/按首字母/.test(art.sub), "副标题注明按首字母", art.sub);
  ok(art.names.indexOf("阿肆") < art.names.indexOf("Beyond") && art.names.indexOf("Beyond") < art.names.indexOf("周杰伦"),
    "艺人按首字母（A→B→Z）排列", JSON.stringify(art.names));
  await shot(page, "64-artists-index");

  console.log("=== 5. 长按拖动排序（真实触摸，列表不跟着滚） ===");
  await page.evaluate(async () => { showPage("library"); setLibTab("lists"); await new Promise(r => setTimeout(r, 250)); openDetail(lib[0].id); });
  await sleep(600);
  const rects = await page.evaluate(() => {
    const rows = Array.prototype.slice.call(document.querySelectorAll("#detail-list li[data-id]"));
    rows[2].scrollIntoView({ block: "center" });      // 保证被拖的行在可视区域内
    return rows.map(r => { const b = r.getBoundingClientRect(); return { id: r.dataset.id, y: b.top + b.height / 2, x: b.left + 30 }; });
  });
  ok(rects.every(r => r.y > 40 && r.y < 800), "被拖动的行在可视区域内", JSON.stringify(rects.map(r => Math.round(r.y))));
  const detailState = await page.evaluate(() => ({
    active: document.getElementById("page-detail").classList.contains("active"),
    display: getComputedStyle(document.getElementById("page-detail")).display,
    scrollTop: document.getElementById("page-detail").scrollTop,
  }));
  console.log("    拖动诊断：rows=" + JSON.stringify(rects.map(r => Math.round(r.y))) + " " + JSON.stringify(detailState));
  ok(rects.length >= 3, "歌单内至少有 3 行可拖动", String(rects.length));
  ok(detailState.active && detailState.display !== "none", "歌单内页处于显示状态（坐标可用）", JSON.stringify(detailState));
  const orderBefore = await page.evaluate(() => plById(curPlId).items.map(i => i.id));
  const startScroll = await page.evaluate(() => Math.round(document.getElementById("page-detail").scrollTop));
  // 长按第 3 行 → 往上拖到第 1 行的位置
  const from = rects[2], to = { y: rects[0].y - 24 };   // 拖到第 1 行上沿之上 → 应落到最前面
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] });
  await sleep(700);   // 超过长按阈值(460ms) → 进入拖动
  const armed = await page.evaluate(() => !!plDrag && plDrag.armed);
  ok(armed, "长按后进入拖动状态");
  for (let i = 1; i <= 6; i++) {
    const y = from.y + (to.y - from.y) * i / 6;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x, y: y }] });
    await sleep(60);
  }
  const midScroll = await page.evaluate(() => Math.round(document.getElementById("page-detail").scrollTop));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(400);
  const after = await page.evaluate(() => ({ order: plById(curPlId).items.map(i => i.id), dragging: !!document.querySelector("#detail-list li.dragging") }));
  eq(midScroll, startScroll, "拖动过程中列表没有跟着滚动（真机上不会被浏览器抢走手势）");
  ok(after.order.join(",") !== orderBefore.join(","), "长按拖动改变了歌曲顺序", JSON.stringify(after.order));
  ok(after.order.indexOf(orderBefore[2]) < after.order.indexOf(orderBefore[0]), "第 3 首被移到了第 1 首之前",
    JSON.stringify({ before: orderBefore, after: after.order }));
  ok(!after.dragging, "松手后拖动状态已复位");
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem("hpa.lib.v1")).playlists[0].items.map(i => i.id).join(","));
  eq(persisted, after.order.join(","), "新顺序已持久化");
  await shot(page, "65-reorder-touch");

  ok(errors.length === 0, "全程无 JS 错误", errors.slice(0, 3).join(" | "));
  console.log("");
  console.log("通过 " + passed + " / " + (passed + failed));
  if (failed) console.log("失败：" + failures.join("; "));
  await browser.close();
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });

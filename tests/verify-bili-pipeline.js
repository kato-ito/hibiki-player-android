// B 站真实接口管线验证（需要网络；ffmpeg 用于封装环节，可用 --no-mux 跳过）
// 用法：node verify-bili-pipeline.js [BV号] [--no-mux]
// 作用：用真实 B 站接口走一遍 App 内同款流程，确认接口与 CDN 行为未变：
//   view（视频信息）→ playurl(fnval=4048)（DASH 音频流）→ PC UA + Referer 下载 → ffmpeg 无损封装 + 标签
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

// ffmpeg 可执行文件：默认用 PATH 里的 ffmpeg，也可用环境变量 HIBIKI_FFMPEG 指定完整路径
const FF = process.env.HIBIKI_FFMPEG || "ffmpeg";
const OUT = path.resolve(__dirname, ".bili-pipeline");
const PC_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MOBILE_UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

let passed = 0, failed = 0;
const ok = (c, name, extra) => {
  if (c) { passed++; console.log("  \u2713 " + name); }
  else { failed++; console.log("  \u2717 FAIL: " + name + (extra !== undefined ? "  \u2014 " + extra : "")); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function header(url, ua, referer) {
  const h = { "User-Agent": ua };
  if (referer) h.Referer = referer;
  const r = await fetch(url, { headers: h });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, buf };
}

(async () => {
  const args = process.argv.slice(2);
  const noMux = args.includes("--no-mux");
  let bvid = args.filter(a => /^BV/.test(a))[0];
  fs.mkdirSync(OUT, { recursive: true });

  console.log("=== 1. 取样本视频 ===");
  if (!bvid) {
    const pop = await (await fetch("https://api.bilibili.com/x/web-interface/popular?ps=1&pn=1", { headers: { "User-Agent": PC_UA, Referer: "https://www.bilibili.com" } })).json();
    bvid = pop.data.list[0].bvid;
  }
  const view = await (await fetch("https://api.bilibili.com/x/web-interface/view?bvid=" + bvid, { headers: { "User-Agent": PC_UA, Referer: "https://www.bilibili.com" } })).json();
  ok(view.code === 0 && !!view.data, "view 接口可用（无需签名）", "code=" + view.code);
  const v = view.data;
  console.log("      视频:", v.title.slice(0, 30), "| UP:", v.owner.name, "| 时长:", v.duration + "s", "| 分P:", v.pages.length);
  const cid = v.pages[0].cid;

  console.log("=== 2. 取音频流（playurl） ===");
  const pu = await (await fetch("https://api.bilibili.com/x/player/playurl?bvid=" + bvid + "&cid=" + cid + "&fnval=4048&fourk=1",
    { headers: { "User-Agent": PC_UA, Referer: "https://www.bilibili.com/video/" + bvid } })).json();
  const dash = pu.data && pu.data.dash;
  ok(pu.code === 0 && !!dash && (dash.audio || []).length > 0, "playurl 返回 DASH 音频流（无需签名）");
  const audios = (dash.audio || []).slice().sort((a, b) => b.bandwidth - a.bandwidth);
  const best = audios[0];
  console.log("      可用音质:", audios.map(a => a.id + "(" + Math.round(a.bandwidth / 1000) + "k)").join(", "));
  console.log("      选择:", best.id, best.codecs, Math.round(best.bandwidth / 1000) + "kbps");
  ok((best.backupUrl || []).length >= 1, "提供备用线路", "backups=" + (best.backupUrl || []).length);

  console.log("=== 3. CDN 下载（UA 行为验证） ===");
  const bad = await header(best.baseUrl, MOBILE_UA, "https://www.bilibili.com/video/" + bvid);
  // CDN 对移动 UA 的态度会随节点/时间变化（历史上是 403），因此这里只做「有明确响应」的软断言：
  // App 侧固定使用 PC UA + Referer，不依赖这条外部行为。
  ok(bad.status === 200 || bad.status === 206 || bad.status === 403,
    "移动 UA 请求有明确响应（403 = 被 CDN 拒绝；App 一律用 PC UA）", "status=" + bad.status);
  if (bad.status !== 403) console.log("      注意：本次 CDN 未拒绝移动 UA（历史行为是 403），App 仍固定用 PC UA");
  const referer = "https://www.bilibili.com/video/" + bvid;
  const good = await header(best.baseUrl, PC_UA, referer);
  ok(good.status === 200 || good.status === 206, "PC UA + Referer 下载成功", "status=" + good.status + " " + good.buf.length + "B");
  const m4s = path.join(OUT, "audio.m4s");
  fs.writeFileSync(m4s, good.buf);
  const sizeMB = (good.buf.length / 1048576).toFixed(2);
  console.log("      下载:", sizeMB + "MB");
  // 分片的盒子结构决定了 App 能否用 ffmpeg 直接解复用（裸 moof 没有 moov 时 ffmpeg 认不出）
  const boxTypes = (function (b) {
    const list = [];
    let off = 0;
    while (off + 8 <= b.length && list.length < 14) {
      let sz = b.readUInt32BE(off);
      const ty = b.toString("latin1", off + 4, off + 8);
      if (sz === 1) sz = Number(b.readBigUInt64BE(off + 8));
      if (sz < 8) break;
      list.push(ty);
      off += sz;
    }
    return list;
  })(good.buf);
  console.log("      顶层盒子:", boxTypes.join(","));
  ok(boxTypes.indexOf("ftyp") >= 0 && boxTypes.indexOf("moov") >= 0,
    "B 站 DASH 音频分片自带 ftyp+moov（App 的 ffmpeg 才能直接解复用）", boxTypes.join(","));
  ok(boxTypes.indexOf("moof") >= 0, "含 moof（分片式 MP4）", boxTypes.join(","));

  console.log("=== 4. ffmpeg 无损封装 + 标签 ===");
  if (noMux) {
    console.log("  (已跳过 --no-mux)");
  } else {
    const covRes = await header(v.pic, PC_UA, referer);
    const cover = path.join(OUT, "cover.jpg");
    fs.writeFileSync(cover, covRes.buf);
    ok(covRes.status === 200 && covRes.buf.length > 1000, "封面下载成功", covRes.buf.length + "B");
    const outFile = path.join(OUT, "out.m4a");
    try {
      execFileSync(FF, ["-y", "-hide_banner", "-loglevel", "error", "-i", m4s, "-i", cover,
        "-map", "0:a:0", "-map", "1:v", "-c", "copy", "-disposition:v", "attached_pic",
        "-metadata", "title=" + v.title, "-metadata", "artist=" + v.owner.name,
        "-metadata", "album=Bilibili", "-metadata", "comment=" + referer, outFile]);
      ok(fs.existsSync(outFile) && fs.statSync(outFile).size > 10000, "封装输出有效（App 内为 ffmpeg-kit 同参数）",
        (fs.statSync(outFile).size / 1048576).toFixed(2) + "MB");
      // 只做探测：ffmpeg 无输出参数会返回非 0，用 spawnSync 直接取 stderr 文本
      const probe = spawnSync(FF, ["-hide_banner", "-i", outFile], { encoding: "utf8" }).stderr || "";
      ok(/Audio: aac/.test(probe) && /Duration/.test(probe), "输出为 AAC 音频（流拷贝未重编码）");
      ok(new RegExp("title\\s*:\\s*" + v.title.slice(0, 6).replace(/[.*+?^\${}()|[\]\\]/g, "\\$&")).test(probe) || /title/.test(probe), "标题标签写入");
      ok(/artist/.test(probe), "UP主标签写入");
      ok(/Video: mjpeg/.test(probe), "封面作为附加图嵌入");
      // App 里杜比（E-AC-3）走的是 MP4 容器（-f mp4 + covr 封面），这里用同一分片验证该参数组合
      const outMp4 = path.join(OUT, "out-dolby-args.m4a");
      try {
        execFileSync(FF, ["-y", "-hide_banner", "-loglevel", "error", "-i", m4s, "-i", cover,
          "-map", "0:a:0", "-map", "1:v", "-c:v", "copy", "-disposition:v", "attached_pic",
          "-c:a", "copy", "-f", "mp4", "-metadata", "title=" + v.title, "-metadata", "artist=" + v.owner.name,
          "-metadata", "album=Bilibili", outMp4]);
        const mb = fs.readFileSync(outMp4);
        const covr = mb.indexOf(Buffer.from("covr", "latin1"));
        ok(covr > 0, "用杜比参数（MP4 容器）封装同一分片也带 covr 封面", covr > 0 ? "covr@" + covr : "无 covr");
        ok(mb.includes(Buffer.from(v.title.slice(0, 4), "utf8")), "中文标题以 UTF-8 写进 MP4");
      } catch (e) {
        ok(false, "杜比参数封装", String(e.message).slice(0, 120));
      }
    } catch (e) {
      ok(false, "ffmpeg 封装", String(e.message).slice(0, 120));
    }
  }

  console.log("\n========== B站真实接口管线: " + passed + " 通过, " + failed + " 失败 ==========");
  if (failed === 0) {
    try { fs.rmSync(OUT, { recursive: true, force: true }); } catch (e) {}
    console.log("（测试产物已清理）");
  } else {
    console.log("产物目录（用于排查）:", OUT);
  }
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("异常:", e.message); process.exit(2); });

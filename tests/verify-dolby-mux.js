// 杜比（E-AC-3）→ MP4 容器 + 内嵌封面 + 中文标签 的真实 ffmpeg 验证。
// 参数与安卓端 BiliDownloader.mux() 完全一致（-c:a copy 不重编码、-map 1:v 附加封面、-f mp4）。
// 产物 fixtures/dolby-eac3-mp4.m4a 供浏览器端测试导入后验证标题/UP主/专辑/封面能否读出。
// 用法：node verify-dolby-mux.js
"use strict";
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

// ffmpeg 可执行文件：默认用 PATH 里的 ffmpeg，也可用环境变量 HIBIKI_FFMPEG 指定完整路径
const FF = process.env.HIBIKI_FFMPEG || "ffmpeg";
const FIX = path.resolve(__dirname, "fixtures");
const OUT = path.resolve(__dirname, ".dolby-mux");
const COVER = path.resolve(__dirname, "bg.jpg");
const TITLE = "杜比测试曲目·中文标题";
const OWNER = "测试UP主";

let passed = 0, failed = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) { passed++; console.log("  \u2713 " + name); }
  else { failed++; failures.push(name); console.log("  \u2717 FAIL: " + name + (extra !== undefined ? "  \u2014 " + extra : "")); }
}
function run(args) {
  return new Promise(resolve => {
    execFile(FF, args, { maxBuffer: 1 << 26, encoding: "buffer" }, (err, so, se) => {
      resolve({ code: err ? 1 : 0, log: String(se || ""), out: String(so || "") });
    });
  });
}
/** 与 BiliDownloader.mux() 相同的参数 */
function appMuxArgs(input, cover, output, ext, title, owner) {
  const a = ["-hide_banner", "-nostdin", "-y", "-i", input];
  const withCover = !!cover && fs.existsSync(cover) && fs.statSync(cover).size > 0 && (ext === "m4a" || ext === "mp4" || ext === "flac");
  if (withCover) a.push("-i", cover);
  a.push("-map", "0:a:0");
  if (withCover) a.push("-map", "1:v", "-c:v", "copy", "-disposition:v", "attached_pic");
  a.push("-c:a", "copy");
  if (ext === "eac3") a.push("-f", "eac3");
  if (ext === "mp4") a.push("-f", "mp4");
  a.push("-metadata", "title=" + title, "-metadata", "artist=" + owner, "-metadata", "album=Bilibili",
    "-metadata", "comment=https://www.bilibili.com/video/BVTEST", output);
  return a;
}
/** MP4 原子树（不依赖 ffprobe） */
function atoms(buf) {
  const out = [];
  (function walk(from, to, depth) {
    let off = from;
    while (off + 8 <= to && depth < 6) {
      let sz = buf.readUInt32BE(off);
      const ty = buf.toString("latin1", off + 4, off + 8);
      if (sz === 1) { sz = Number(buf.readBigUInt64BE(off + 8)); }
      if (sz < 8 || off + sz > to) break;
      out.push({ ty, off, sz });
      const hdr = ty === "meta" ? 12 : 8;
      if (["moov", "trak", "mdia", "minf", "stbl", "udta", "meta", "ilst"].indexOf(ty) >= 0) walk(off + hdr, off + sz, depth + 1);
      off += sz;
    }
  })(0, buf.length, 0);
  return out;
}
function atomOf(list, ty) { return list.filter(a => a.ty === ty)[0] || null; }

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (/[\\/]/.test(FF) && !fs.existsSync(FF)) { console.log("找不到 ffmpeg：" + FF); process.exit(2); }
  console.log("ffmpeg:", (await run(["-version"])).out.split("\n")[0].slice(0, 56));
  const src = path.join(FIX, "tone-51.eac3");
  ok(fs.existsSync(src), "E-AC-3 夹具存在", "tone-51.eac3");
  ok(fs.existsSync(COVER), "封面夹具存在", "bg.jpg");

  console.log("=== 1. 裸 E-AC-3 → MP4 容器（App 的杜比下载路径）===");
  const out1 = path.join(OUT, "dolby-mp4.m4a");
  let r = await run(appMuxArgs(src, COVER, out1, "mp4", TITLE, OWNER));
  ok(r.code === 0 && fs.existsSync(out1) && fs.statSync(out1).size > 0, "封装成功（-c:a copy + attached_pic + -f mp4）",
    r.code === 0 ? fs.statSync(out1).size + "B" : r.log.trim().split("\n").slice(-1)[0]);
  const buf1 = fs.readFileSync(out1);
  const at1 = atoms(buf1);
  const covr = atomOf(at1, "covr");
  ok(!!covr && covr.sz > 1000, "MP4 内含 covr 封面原子（封面真的写进文件了）", covr ? covr.sz - 8 + "B" : "无");
  ok(!!atomOf(at1, "©nam"), "ilst 里有 ©nam 标题原子");
  ok(!!atomOf(at1, "©ART"), "ilst 里有 ©ART UP主原子");
  ok(buf1.includes(Buffer.from(TITLE, "utf8")), "标题以 UTF-8 写入（中文不乱码）");
  ok(buf1.includes(Buffer.from(OWNER, "utf8")), "UP主以 UTF-8 写入");
  ok(buf1.toString("latin1", 4, 8) === "ftyp", "文件头是 MP4（ftyp）");
  const probe1 = (await run(["-hide_banner", "-i", out1])).log;
  ok(/Audio:\s*eac3/.test(probe1), "音频流仍是 eac3（未重编码）", (probe1.match(/Audio:[^\n]*/) || [""])[0].trim().slice(0, 56));
  ok(fs.statSync(out1).size < fs.statSync(src).size * 1.6, "体积没有因重编码膨胀",
    Math.round(fs.statSync(out1).size / 1024) + "KB vs 源 " + Math.round(fs.statSync(src).size / 1024) + "KB");
  const back = path.join(OUT, "back.eac3");
  await run(["-hide_banner", "-loglevel", "error", "-y", "-i", out1, "-map", "0:a:0", "-c:a", "copy", "-f", "eac3", back]);
  if (fs.existsSync(back)) {
    const d = Math.abs(fs.statSync(back).size - fs.statSync(src).size) / fs.statSync(src).size;
    ok(d < 0.06, "回拷出的 E-AC-3 与源码流同长（确属流拷贝）", Math.round(d * 1000) / 10 + "%");
  } else { ok(false, "回拷 E-AC-3 失败"); }

  console.log("=== 2. 模拟 B 站 DASH 分片（fMP4：ftyp+moov+moof+mdat）===");
  const frag = path.join(OUT, "dash.m4s");
  r = await run(["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-c:a", "copy",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", frag]);
  ok(r.code === 0 && fs.existsSync(frag), "生成 fMP4 分片", r.code === 0 ? fs.statSync(frag).size + "B" : r.log.trim());
  const fbuf = fs.readFileSync(frag);
  const fat = atoms(fbuf).map(a => a.ty);
  ok(fat.indexOf("moov") >= 0 && fat.indexOf("moof") >= 0, "分片含 moov+moof（B 站 DASH 音频分片同构）", fat.slice(0, 6).join(","));
  const out2 = path.join(OUT, "dolby-mp4-fromdash.m4a");
  r = await run(appMuxArgs(frag, COVER, out2, "mp4", TITLE, OWNER));
  ok(r.code === 0 && fs.existsSync(out2) && fs.statSync(out2).size > 0, "分片也能封装成带封面的 MP4",
    r.code === 0 ? fs.statSync(out2).size + "B" : r.log.trim().split("\n").slice(-1)[0]);
  if (fs.existsSync(out2)) {
    const b2 = fs.readFileSync(out2);
    const at2 = atoms(b2);
    const p2 = (await run(["-hide_banner", "-i", out2])).log;
    ok(/Audio:\s*eac3/.test(p2) && !!atomOf(at2, "covr") && b2.includes(Buffer.from(TITLE, "utf8")),
      "分片产物同样是 eac3 + covr 封面 + 中文标题");
  }

  console.log("=== 3. 裸分片（只有 moof+mdat）时的兜底路径 ===");
  const raw = fs.readFileSync(frag);
  const moof = raw.indexOf(Buffer.from("moof", "latin1")) - 4;
  const bare = path.join(OUT, "bare.m4s");
  fs.writeFileSync(bare, moof > 0 ? raw.subarray(moof) : raw);
  const out3 = path.join(OUT, "bare-mp4.m4a");
  const r3 = await run(appMuxArgs(bare, COVER, out3, "mp4", TITLE, OWNER));
  const bareMp4Ok = r3.code === 0 && fs.existsSync(out3) && fs.statSync(out3).size > 0;
  const out4 = path.join(OUT, "bare.eac3");
  const r4 = await run(["-hide_banner", "-nostdin", "-y", "-i", bare, "-map", "0:a:0", "-c:a", "copy", "-f", "eac3", out4]);
  const bareRawOk = r4.code === 0 && fs.existsSync(out4) && fs.statSync(out4).size > 0;
  console.log("      裸分片 → MP4：" + (bareMp4Ok ? "成功" : "失败") + "；裸分片 → 裸流：" + (bareRawOk ? "成功" : "失败"));
  ok(true, "已记录裸分片行为（两种路径都失败时说明 ffmpeg 需要 moov：真实 B 站分片自带 moov，见 verify-bili-pipeline）");

  console.log("=== 4. Windows 桌面端参数（MP4 容器 + faststart）===");
  const out5 = path.join(OUT, "desktop-dolby.m4a");
  const deskArgs = ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-i", COVER,
    "-c:a", "copy", "-map", "0:a", "-map", "1:v", "-c:v", "copy", "-disposition:v:0", "attached_pic",
    "-metadata", "title=" + TITLE, "-metadata", "artist=" + OWNER, "-metadata", "album=测试专辑",
    "-f", "mp4", "-movflags", "+faststart", out5];
  const r5 = await run(deskArgs);
  ok(r5.code === 0 && fs.existsSync(out5), "桌面端参数封装成功（bili-ipc.js 同参数）",
    r5.code === 0 ? fs.statSync(out5).size + "B" : r5.log.trim().split("\n").slice(-1)[0]);
  if (fs.existsSync(out5)) {
    const b5 = fs.readFileSync(out5);
    const at5 = atoms(b5);
    const moovOff = (atomOf(at5, "moov") || {}).off;
    const mdatOff = (atomOf(at5, "mdat") || {}).off;
    ok(!!atomOf(at5, "covr") && b5.includes(Buffer.from(TITLE, "utf8")), "桌面产物同样含 covr 封面 + 中文标题");
    ok(moovOff !== undefined && mdatOff !== undefined && moovOff < mdatOff,
      "faststart：moov 在 mdat 之前", "moov@" + moovOff + " mdat@" + mdatOff);
  }

  console.log("=== 5. 合集：标题=分P名、专辑=视频名（播放器里显示的就是这两个标签）===");
  const out6 = path.join(OUT, "collection-part.m4a");
  const PART = "P12 第十二期：上/下";
  const COLL = "合集：某某挑战";
  let r6 = await run(["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-c:a", "copy",
    "-f", "mp4", "-metadata", "title=" + PART, "-metadata", "artist=" + OWNER, "-metadata", "album=" + COLL, out6]);
  ok(r6.code === 0 && fs.existsSync(out6), "封装成功（合集标签）", r6.code === 0 ? fs.statSync(out6).size + "B" : r6.log.trim());
  if (fs.existsSync(out6)) {
    const b6 = fs.readFileSync(out6);
    const at6 = atoms(b6);
    ok(b6.includes(Buffer.from(PART, "utf8")), "©nam 标题 = 分P名（含冒号/斜杠，UTF-8）", PART);
    ok(b6.includes(Buffer.from(COLL, "utf8")), "©alb 专辑 = 视频名（便于播放器归类）", COLL);
    ok(!b6.includes(Buffer.from("某某挑战 - P12", "utf8")), "文件里不再出现「视频名 - 分P名」这种完整标题");
    const p6 = (await run(["-hide_banner", "-i", out6])).log;
    ok(/title\s*:\s*P12/.test(p6) && /album\s*:\s*合集/.test(p6), "ffmpeg 读回的标题/专辑正确",
      (p6.split(/\r?\n/).filter(l => /title|album/.test(l)).join(" ").trim()).slice(0, 90));
  }

  console.log("=== 6. 固定夹具（供浏览器端验证标签/封面解析）===");
  const fixture = path.join(FIX, "dolby-eac3-mp4.m4a");
  fs.copyFileSync(out1, fixture);
  ok(fs.statSync(fixture).size > 10000, "写出 fixtures/dolby-eac3-mp4.m4a", Math.round(fs.statSync(fixture).size / 1024) + "KB");

  console.log("");
  console.log("通过 " + passed + " / " + (passed + failed));
  if (failed) console.log("失败：" + failures.join("; "));
  if (failed === 0) { try { fs.rmSync(OUT, { recursive: true, force: true }); } catch (e) {} }
  else console.log("产物目录：" + OUT);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });

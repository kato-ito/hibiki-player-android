// 组装 www/index.html：head.html + body.html + qrcode.js(包在 script 内) + app1.js + app2.js + app3.js + 收尾
const fs = require("fs");
const path = require("path");
const src = __dirname;
const parts = ["head.html", "body.html", "qrcode.js", "app1.js", "app2.js", "app3.js"];
let out = parts.map(p => {
  const text = fs.readFileSync(path.join(src, p), "utf8");
  // 纯 JS 文件（如二维码库）需要包上 script 标签；app*.js 自带标签
  return p === "qrcode.js" ? "<script>\n" + text + "\n</script>" : text;
}).join("\n");
out += "\n</body>\n</html>\n";
const target = path.join(__dirname, "..", "www", "index.html");
fs.writeFileSync(target, out, "utf8");
console.log("built", target, out.length, "chars");

"use strict";
const zlib = require("zlib");
function decodePNG(buf){
  let p = 8, w=0,h=0,bitDepth=0,colorType=0, idat=[];
  while (p < buf.length){
    const len = buf.readUInt32BE(p); const type = buf.toString("ascii", p+4, p+8);
    const data = buf.subarray(p+8, p+8+len);
    if (type==="IHDR"){ w=data.readUInt32BE(0); h=data.readUInt32BE(4); bitDepth=data[8]; colorType=data[9]; }
    else if (type==="IDAT") idat.push(data);
    else if (type==="IEND") break;
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = colorType===6?4:colorType===2?3:colorType===0?1:4;
  const stride = w*ch;
  const out = Buffer.alloc(h*stride);
  let pos=0;
  for (let y=0;y<h;y++){
    const ft = raw[pos++]; const line = raw.subarray(pos,pos+stride); pos+=stride;
    const cur = out.subarray(y*stride,(y+1)*stride);
    const prev = y>0? out.subarray((y-1)*stride,y*stride): Buffer.alloc(stride);
    for (let x=0;x<stride;x++){
      const a = x>=ch? cur[x-ch]:0, b = prev[x], c = x>=ch? prev[x-ch]:0; let v=line[x];
      if (ft===1) v+=a; else if (ft===2) v+=b; else if (ft===3) v+=((a+b)>>1);
      else if (ft===4){ const pa=Math.abs(b-c), pb=Math.abs(a-c), pc=Math.abs(a+b-2*c); v += (pa<=pb&&pa<=pc)?a:(pb<=pc?b:c); }
      cur[x]=v&255;
    }
  }
  return {w,h,ch,data:out};
}
function px(img,x,y){ const i=(y*img.w+x)*img.ch; return [img.data[i],img.data[i+1],img.data[i+2]]; }
function isRed(img,x,y){ const [r,g,b]=px(img,x,y); return r>150 && r-g>60 && r-b>60; }
module.exports = { decodePNG, px, isRed };

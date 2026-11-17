// 往返测试：把原始 app.asar 原样重打包一遍，验证结构一致 + 每个文件逐字节相同
// 用途：改动 repack.js 后跑一次，确认没有破坏 asar 格式
//
// 用法（在仓库根目录）：
//   node tools/test-roundtrip.js
const fs = require('fs');
const path = require('path');
const { repack, readHeader, collectFiles } = require('../repack.js');
const P = require('../paths.js');

const appDir = P.findAppDir();
if (!appDir) {
  console.error('❌ 找不到 Antigravity 安装目录');
  process.exit(1);
}
const SRC = path.join(appDir, 'resources', 'app.asar');
const OUT_DIR = path.join(__dirname, '..', 'build');
const OUT = path.join(OUT_DIR, 'app.roundtrip.asar');

fs.mkdirSync(OUT_DIR, { recursive: true });
console.log('源文件:', SRC);
const r = repack(SRC, OUT, {});
console.log('重打包结果:', JSON.stringify(r));

function loadMeta(p) {
  const fd = fs.openSync(p, 'r');
  const m = readHeader(fd);
  const files = collectFiles(m.header);
  const map = new Map();
  for (const f of files) map.set(f.path, { size: f.node.size, offset: Number(f.node.offset) });
  return { fd, m, map };
}

const A = loadMeta(SRC);
const B = loadMeta(OUT);
console.log('原 asar 文件数:', A.map.size, ' 新 asar 文件数:', B.map.size);

const onlyA = [...A.map.keys()].filter(k => !B.map.has(k));
const onlyB = [...B.map.keys()].filter(k => !A.map.has(k));
if (onlyA.length) console.log('仅在原版:', onlyA.length, onlyA.slice(0, 5));
if (onlyB.length) console.log('仅在新版:', onlyB.length, onlyB.slice(0, 5));

let mismatch = 0, checked = 0;
for (const p of A.map.keys()) {
  const a = A.map.get(p), b = B.map.get(p);
  if (!b) continue;
  if (a.size !== b.size) { mismatch++; if (mismatch < 4) console.log('  大小不符:', p, a.size, b.size); continue; }
  const ba = Buffer.alloc(a.size), bb = Buffer.alloc(b.size);
  if (a.size > 0) {
    fs.readSync(A.fd, ba, 0, a.size, A.m.dataBase + a.offset);
    fs.readSync(B.fd, bb, 0, b.size, B.m.dataBase + b.offset);
  }
  checked++;
  if (!ba.equals(bb)) { mismatch++; if (mismatch < 4) console.log('  内容不符:', p); }
}
console.log('逐字节校验: ' + checked + ' 个文件, 不符 ' + mismatch + ' 个');
console.log(mismatch === 0 && onlyA.length === 0 && onlyB.length === 0
  ? '✅ 往返无损，repack.js 正常'
  : '❌ 存在差异，repack.js 有问题');
process.exit(mismatch === 0 && onlyA.length === 0 ? 0 : 1);

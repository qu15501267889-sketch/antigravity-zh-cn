// 精确 asar 重打包：只替换指定文件，其余字节原样保留，重算 offset
const fs = require('fs');
const crypto = require('crypto');

// 按 asar 规则重算 integrity（SHA256，4MB 分块）
function computeIntegrity(buf) {
  const BLOCK = 4194304;
  const blocks = [];
  for (let i = 0; i < buf.length || i === 0; i += BLOCK) {
    blocks.push(crypto.createHash('sha256').update(buf.subarray(i, Math.min(i + BLOCK, buf.length))).digest('hex'));
    if (i + BLOCK >= buf.length) break;
  }
  return {
    algorithm: 'SHA256',
    hash: crypto.createHash('sha256').update(buf).digest('hex'),
    blockSize: BLOCK,
    blocks
  };
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function readHeader(fd) {
  const b = Buffer.alloc(16);
  fs.readSync(fd, b, 0, 16, 0);
  const pickleMagic = b.readUInt32LE(0);
  const headerPickleLen = b.readUInt32LE(4);
  const jsonLen = b.readUInt32LE(12);
  const jb = Buffer.alloc(jsonLen);
  fs.readSync(fd, jb, 0, jsonLen, 16);
  const txt = jb.toString('utf8');
  const header = JSON.parse(txt.slice(txt.indexOf('{')));
  return {
    header,
    dataBase: 8 + headerPickleLen,
    jsonLen,
    headerPickleLen,
    pickleMagic
  };
}

// 收集所有非 unpacked 文件（保持 header 中的遍历顺序）
function collectFiles(header) {
  const files = [];
  function walk(node, prefix) {
    for (const k of Object.keys(node.files || {})) {
      const x = node.files[k];
      const p = prefix + '/' + k;
      if (x.files) walk(x, p);
      else if (!x.unpacked) files.push({ node: x, path: p });
    }
  }
  walk(header, '');
  return files;
}

function repack(srcAsar, outAsar, replacements) {
  const fd = fs.openSync(srcAsar, 'r');
  const meta = readHeader(fd);
  const { header, dataBase } = meta;
  const files = collectFiles(header);

  // 按原 offset 排序，保证写入顺序与 header 声明一致
  files.sort((a, b) => Number(a.node.offset) - Number(b.node.offset));

  const chunks = [];
  let cursor = 0;
  const replacedPaths = new Set(Object.keys(replacements));

  for (const f of files) {
    let buf;
    if (replacements[f.path] !== undefined) {
      buf = Buffer.isBuffer(replacements[f.path])
        ? replacements[f.path]
        : Buffer.from(replacements[f.path], 'utf8');
      // 内容变了，重算 integrity（保持字段存在，结构与原版一致）
      if (f.node.integrity) f.node.integrity = computeIntegrity(buf);
      replacedPaths.delete(f.path);
    } else {
      buf = Buffer.alloc(f.node.size);
      if (f.node.size > 0) fs.readSync(fd, buf, 0, f.node.size, dataBase + Number(f.node.offset));
    }
    // 数据区按 4 字节对齐填充
    const pad = (4 - (buf.length % 4)) % 4;
    f.node.size = buf.length;
    f.node.offset = String(cursor);
    chunks.push(buf);
    if (pad) chunks.push(Buffer.alloc(pad));
    cursor += buf.length + pad;
  }
  fs.closeSync(fd);

  if (replacedPaths.size) {
    console.warn('警告：以下指定文件在 asar 中不存在:', [...replacedPaths].join(', '));
  }

  // 重组 header
  const jsonBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const payload = Buffer.concat([u32(jsonBuf.length), jsonBuf, Buffer.alloc(jsonPad)]);
  const headerPickle = Buffer.concat([u32(payload.length), payload]);
  const prefix = Buffer.concat([u32(4), u32(headerPickle.length)]);

  const out = fs.openSync(outAsar, 'w');
  fs.writeSync(out, prefix);
  fs.writeSync(out, headerPickle);
  for (const c of chunks) fs.writeSync(out, c);
  fs.closeSync(out);

  return { fileCount: files.length, dataSize: cursor, headerSize: headerPickle.length };
}

module.exports = { repack, readHeader, collectFiles };

if (require.main === module) {
  const [, , src, out] = process.argv;
  if (!src || !out) {
    console.log('用法: node repack.js <源asar> <目标asar>');
    process.exit(1);
  }
  const r = repack(src, out, {});
  console.log('重打包完成:', JSON.stringify(r));
}

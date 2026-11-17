// 路径自动探测：让脚本在任意 Windows 机器上都能跑，不硬编码用户名
const fs = require('fs');
const path = require('path');

const HOME = process.env.USERPROFILE || '';
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const PROGRAMFILES = process.env.ProgramFiles || 'C:\\Program Files';
const PROGRAMFILES_X86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

function hasAsar(dir) {
  try {
    return fs.existsSync(path.join(dir, 'resources', 'app.asar'));
  } catch { return false; }
}

// 找安装目录（含 resources/app.asar 的那一层）
function findAppDir() {
  const direct = [
    path.join(LOCALAPPDATA, 'Programs', 'antigravity'),
    path.join(LOCALAPPDATA, 'Programs', 'Antigravity'),
    path.join(PROGRAMFILES, 'Antigravity'),
    path.join(PROGRAMFILES_X86, 'Antigravity'),
    path.join(LOCALAPPDATA, 'Antigravity'),
  ];
  for (const d of direct) if (hasAsar(d)) return d;

  // 兜底：扫描常见父目录下的一级子目录
  const parents = [
    path.join(LOCALAPPDATA, 'Programs'),
    PROGRAMFILES,
    PROGRAMFILES_X86,
  ];
  for (const parent of parents) {
    let entries = [];
    try { entries = fs.readdirSync(parent, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!/antigravity/i.test(e.name)) continue;
      const d = path.join(parent, e.name);
      if (hasAsar(d)) return d;
    }
  }
  return null;
}

// 找用户数据目录（含 DevToolsActivePort 的那一层）
function findUserDataDir() {
  const direct = [
    path.join(APPDATA, 'Antigravity'),
    path.join(APPDATA, 'antigravity'),
  ];
  for (const d of direct) if (fs.existsSync(path.join(d, 'DevToolsActivePort'))) return d;

  let entries = [];
  try { entries = fs.readdirSync(APPDATA, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory() || !/antigravity/i.test(e.name)) continue;
    const d = path.join(APPDATA, e.name);
    if (fs.existsSync(path.join(d, 'DevToolsActivePort'))) return d;
  }
  return null;
}

// 读调试端口（CDP 用）
function readDebugPort(userDataDir) {
  const dir = userDataDir || findUserDataDir();
  if (!dir) return null;
  try {
    const raw = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8');
    const port = parseInt(raw.split(/\r?\n/)[0].trim(), 10);
    return Number.isFinite(port) ? port : null;
  } catch { return null; }
}

// 读 app 版本
function readVersion(appDir) {
  const dir = appDir || findAppDir();
  if (!dir) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'resources', 'app.asar'), 'utf8').slice(0, 0));
  } catch { }
  try {
    // 优先读 version 文件（Electron 版本的），再看 package.json
    const v = fs.readFileSync(path.join(dir, 'version'), 'utf8').trim();
    return v;
  } catch { }
  return null;
}

// 从 asar 里读 productName/version（不依赖外部解包工具）
function readAppVersionFromAsar(asarPath) {
  const fs2 = require('fs');
  try {
    const fd = fs2.openSync(asarPath, 'r');
    const b = Buffer.alloc(16);
    fs2.readSync(fd, b, 0, 16, 0);
    const headerPickleLen = b.readUInt32LE(4);
    const jsonLen = b.readUInt32LE(12);
    const jb = Buffer.alloc(jsonLen);
    fs2.readSync(fd, jb, 0, jsonLen, 16);
    const txt = jb.toString('utf8');
    const header = JSON.parse(txt.slice(txt.indexOf('{')));
    const pkgNode = header.files && header.files['package.json'];
    if (!pkgNode) { fs2.closeSync(fd); return null; }
    const dataBase = 8 + headerPickleLen;
    const buf = Buffer.alloc(pkgNode.size);
    fs2.readSync(fd, buf, 0, pkgNode.size, dataBase + Number(pkgNode.offset));
    fs2.closeSync(fd);
    const pkg = JSON.parse(buf.toString('utf8').replace(/^[^{]*/, ''));
    return { version: pkg.version, productName: pkg.productName, name: pkg.name };
  } catch (e) {
    return null;
  }
}

// 解析 Antigravity.exe 是否存在
function findExe(appDir) {
  const dir = appDir || findAppDir();
  if (!dir) return null;
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return null; }
  const exe = entries.find(f => /^antigravity\.exe$/i.test(f));
  return exe ? path.join(dir, exe) : null;
}

module.exports = {
  HOME, LOCALAPPDATA, APPDATA, PROGRAMFILES,
  findAppDir, findUserDataDir, readDebugPort, readVersion,
  readAppVersionFromAsar, findExe, hasAsar
};

// 直接运行时打印探测结果
if (require.main === module) {
  const appDir = findAppDir();
  const userData = findUserDataDir();
  console.log('安装目录 :', appDir || '未找到');
  console.log('数据目录 :', userData || '未找到');
  console.log('主程序   :', findExe(appDir) || '未找到');
  console.log('调试端口 :', readDebugPort(userData) || '未运行/未找到');
  if (appDir) {
    const v = readAppVersionFromAsar(path.join(appDir, 'resources', 'app.asar'));
    console.log('应用版本 :', v ? `${v.productName} ${v.version}` : '读取失败');
  }
}

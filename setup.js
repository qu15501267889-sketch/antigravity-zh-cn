#!/usr/bin/env node
/**
 * Antigravity 汉化补丁 —— 一体化安装器
 *
 * 用法：
 *   node setup.js status     查看环境与补丁状态
 *   node setup.js prepare    备份原版 + 生成补丁包（不改动正在运行的程序）
 *   node setup.js install    关闭程序 → 写入补丁 → 重新启动
 *   node setup.js restore    还原成原版英文
 *
 * 设计原则：
 *   - 所有路径自动探测，不硬编码用户名
 *   - 幂等：重复执行不会叠加补丁
 *   - 任何一步失败都不破坏原文件（写入前先校验，失败自动回滚）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const P = require('./paths.js');
const { repack, readHeader, collectFiles } = require('./repack.js');

const ROOT = __dirname;
const DICT_DIR = path.join(ROOT, 'dict');
const BACKUP_DIR = path.join(ROOT, 'backup');
const BUILD_DIR = path.join(ROOT, 'build');
const BACKUP_ASAR = path.join(BACKUP_DIR, 'app.asar.orig');
const PATCHED_ASAR = path.join(BUILD_DIR, 'app.asar.patched');
const ENGINE_FILE = path.join(ROOT, 'engine.js');
const TARGET_IN_ASAR = '/dist/preload.js';
const MARK = 'AGY-CN-BEGIN';

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function sh(cmd) {
  try { return execSync(cmd, { stdio: 'pipe' }).toString(); }
  catch (e) { return ((e.stdout || '') + (e.stderr || '')).toString(); }
}
function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
function humanSize(n) { return (n / 1024).toFixed(1) + ' KB'; }
function die(msg) { console.error('❌ ' + msg); process.exit(1); }

// ---------- 环境探测 ----------
function detect() {
  const appDir = P.findAppDir();
  if (!appDir) die('找不到 Antigravity 安装目录（需要 resources/app.asar）。请确认已安装 Antigravity。');
  const asar = path.join(appDir, 'resources', 'app.asar');
  const exe = P.findExe(appDir);
  if (!exe) die('找不到 Antigravity.exe');
  const info = P.readAppVersionFromAsar(asar);
  return { appDir, asar, exe, version: info };
}

// ---------- 读 asar 里某个文件 ----------
function readMember(asarPath, memberPath) {
  const fd = fs.openSync(asarPath, 'r');
  const m = readHeader(fd);
  const files = collectFiles(m.header);
  const hit = files.find(f => f.path === memberPath);
  if (!hit) { fs.closeSync(fd); return null; }
  const buf = Buffer.alloc(hit.node.size);
  if (hit.node.size > 0) fs.readSync(fd, buf, 0, hit.node.size, m.dataBase + Number(hit.node.offset));
  fs.closeSync(fd);
  return { buf, node: hit.node };
}

// ---------- 状态 ----------
function status() {
  const env = detect();
  console.log('===== 环境 =====');
  console.log('安装目录 :', env.appDir);
  console.log('主程序   :', env.exe);
  console.log('app.asar :', env.asar, '(' + humanSize(fs.statSync(env.asar).size) + ')');
  console.log('应用版本 :', env.version ? env.version.productName + ' ' + env.version.version : '未知');
  console.log('数据目录 :', P.findUserDataDir() || '未找到');
  console.log('调试端口 :', P.readDebugPort() || '未运行');

  const pre = readMember(env.asar, TARGET_IN_ASAR);
  const patched = pre ? pre.buf.toString('utf8').includes(MARK) : false;
  console.log('');
  console.log('===== 补丁状态 =====');
  console.log('安装目录的 preload.js :', pre ? humanSize(pre.buf.length) : '读取失败');
  console.log('是否已含汉化补丁     :', patched ? '是 ✅' : '否（原版英文）');
  console.log('本地备份(原版)       :', exists(BACKUP_ASAR) ? humanSize(fs.statSync(BACKUP_ASAR).size) : '无');
  console.log('待安装补丁包         :', exists(PATCHED_ASAR) ? humanSize(fs.statSync(PATCHED_ASAR).size) : '无');

  if (exists(BACKUP_ASAR)) {
    const b = fs.statSync(BACKUP_ASAR).size;
    const c = fs.statSync(env.asar).size;
    console.log('当前 asar 与备份的关系 :', b === c ? '大小相同（可能是原版）' : '大小不同（可能已打补丁）');
  }
  const dictCount = (() => {
    let all = {};
    for (const f of fs.readdirSync(DICT_DIR).filter(x => /^dict-\d+\.json$/.test(x))) {
      try { Object.assign(all, JSON.parse(fs.readFileSync(path.join(DICT_DIR, f), 'utf8'))); } catch { }
    }
    return Object.keys(all).length;
  })();
  console.log('字典词条总数         :', dictCount);
}

// ---------- 构建 engine.js ----------
function buildEngine() {
  const tplPath = path.join(ROOT, 'engine-template.js');
  if (!exists(tplPath)) die('缺少 engine-template.js');
  const dictFiles = fs.readdirSync(DICT_DIR).filter(f => /^dict-\d+\.json$/.test(f)).sort();
  if (!dictFiles.length) die('缺少 dict/*.json 字典文件');

  const dict = {};
  let dup = 0;
  for (const f of dictFiles) {
    let part;
    try { part = JSON.parse(fs.readFileSync(path.join(DICT_DIR, f), 'utf8')); }
    catch (e) { die('字典解析失败: ' + f + ' -> ' + e.message); }
    for (const [k, v] of Object.entries(part)) {
      if (dict[k] !== undefined && dict[k] !== v) dup++;
      dict[k] = v;
    }
  }
  const tpl = fs.readFileSync(tplPath, 'utf8');
  if (!tpl.includes('__DICT__')) die('engine-template.js 里找不到 __DICT__ 占位符');
  const out = tpl.split('__DICT__').join(JSON.stringify(dict));
  fs.writeFileSync(ENGINE_FILE, out, 'utf8');
  console.log('  字典词条:', Object.keys(dict).length, '（冲突覆盖', dup, '处）');
  console.log('  引擎大小:', humanSize(Buffer.byteLength(out)));
  return { count: Object.keys(dict).length };
}

// ---------- 准备补丁 ----------
function prepare() {
  const env = detect();
  console.log('===== 1/4 环境检查 =====');
  console.log('  安装目录:', env.appDir);
  console.log('  版本:', env.version ? env.version.version : '未知');

  console.log('===== 2/4 备份原版 =====');
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (exists(BACKUP_ASAR)) {
    console.log('  已有备份，跳过（如需重建请手动删除 backup/app.asar.orig）');
  } else {
    // 关键：只有当前 asar 不含补丁时才允许备份，否则会把补丁版当原版
    const pre = readMember(env.asar, TARGET_IN_ASAR);
    if (pre && pre.buf.toString('utf8').includes(MARK)) {
      die('当前 app.asar 已经打过补丁，无法作为"原版"备份。请先用原版备份还原，或从其他机器拷贝干净的 app.asar。');
    }
    fs.copyFileSync(env.asar, BACKUP_ASAR);
    console.log('  已备份:', BACKUP_ASAR, humanSize(fs.statSync(BACKUP_ASAR).size));
  }

  console.log('===== 3/4 生成引擎 =====');
  buildEngine();

  console.log('===== 4/4 打包补丁 =====');
  const engine = fs.readFileSync(ENGINE_FILE, 'utf8');
  const src = readMember(BACKUP_ASAR, TARGET_IN_ASAR);
  if (!src) die('备份里找不到 ' + TARGET_IN_ASAR);

  let origText = src.buf.toString('utf8');
  // 幂等：剥离旧补丁
  const bi = origText.indexOf('/* ==== ' + MARK);
  if (bi !== -1) {
    const ei = origText.indexOf('/* ==== AGY-CN-END ==== */');
    if (ei !== -1) origText = origText.slice(0, bi) + origText.slice(ei + '/* ==== AGY-CN-END ==== */'.length);
  }
  const patchedText =
    origText +
    '\n/* ==== ' + MARK + ' (antigravity 汉化补丁，可整段删除还原) ==== */\n' +
    engine +
    '\n/* ==== AGY-CN-END ==== */\n';
  const patchedBuf = Buffer.from(patchedText, 'utf8');

  // 语法自检：注入的代码不能有语法错误
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const tmp = path.join(BUILD_DIR, '.preload.syntax-check.js');
  fs.writeFileSync(tmp, patchedBuf);
  const chk = sh('node --check "' + tmp + '"');
  if (chk && /SyntaxError|Error:/.test(chk)) { die('注入后语法检查失败:\n' + chk); }
  fs.unlinkSync(tmp);

  const r = repack(BACKUP_ASAR, PATCHED_ASAR, { [TARGET_IN_ASAR]: patchedBuf });
  console.log('  preload.js:', humanSize(src.buf.length), '->', humanSize(patchedBuf.length));
  console.log('  打包结果: 文件数', r.fileCount, ' 数据区', humanSize(r.dataSize));

  // 回读校验
  const check = readMember(PATCHED_ASAR, TARGET_IN_ASAR);
  if (!check || !check.buf.equals(patchedBuf)) die('回读校验失败，补丁包可能损坏');
  console.log('  回读校验: ✅ 一致');
  console.log('');
  console.log('✅ 准备完成。执行 `node setup.js install` 写入并重启。');
}

// ---------- 安装 ----------
function install() {
  if (!exists(PATCHED_ASAR)) die('补丁包不存在，请先执行: node setup.js prepare');
  const env = detect();
  const sizeBefore = fs.statSync(env.asar).size;

  console.log('===== 1/3 关闭 Antigravity =====');
  sh('taskkill /IM Antigravity.exe /F');
  sh('taskkill /IM language_server.exe /F');
  for (let i = 0; i < 20; i++) {
    if (!/Antigravity\.exe/i.test(sh('tasklist /FI "IMAGENAME eq Antigravity.exe" /NH'))) break;
    sleep(700);
  }
  console.log('  进程已退出');

  console.log('===== 2/3 写入补丁 =====');
  // 先备份"当前"状态，便于失败回滚
  const rollback = path.join(BUILD_DIR, 'app.asar.before-install');
  fs.copyFileSync(env.asar, rollback);
  try {
    fs.copyFileSync(PATCHED_ASAR, env.asar);
    const after = fs.statSync(env.asar).size;
    const expect = fs.statSync(PATCHED_ASAR).size;
    if (after !== expect) throw new Error('写入后大小不符: ' + after + ' != ' + expect);
    console.log('  ' + sizeBefore + ' -> ' + after + ' 字节 ✅');
  } catch (e) {
    console.error('  ❌ 写入失败，正在回滚:', e.message);
    try { fs.copyFileSync(rollback, env.asar); console.error('  已回滚'); } catch { }
    die('安装失败');
  }

  console.log('===== 3/3 启动 =====');
  // 用 explorer 启动：直接 spawn 在部分沙箱/终端环境下会被回收
  sh('explorer.exe "' + env.exe + '"');
  console.log('  已通过资源管理器启动');
  console.log('');
  console.log('✅ 安装完成。界面文案应为中文。');
  console.log('   若异常，执行 `node setup.js restore` 还原。');
}

// ---------- 还原 ----------
function restore() {
  if (!exists(BACKUP_ASAR)) die('找不到原版备份 backup/app.asar.orig，无法还原');
  const env = detect();
  console.log('===== 1/3 关闭 Antigravity =====');
  sh('taskkill /IM Antigravity.exe /F');
  sh('taskkill /IM language_server.exe /F');
  sleep(2500);
  console.log('  进程已退出');

  console.log('===== 2/3 还原原版 =====');
  fs.copyFileSync(BACKUP_ASAR, env.asar);
  console.log('  已还原:', humanSize(fs.statSync(env.asar).size));

  console.log('===== 3/3 启动 =====');
  sh('explorer.exe "' + env.exe + '"');
  console.log('✅ 已恢复英文原版。');
}

// ---------- 入口 ----------
const cmd = (process.argv[2] || 'status').toLowerCase();
try {
  if (cmd === 'status') status();
  else if (cmd === 'prepare') prepare();
  else if (cmd === 'install') install();
  else if (cmd === 'restore') restore();
  else {
    console.log('用法: node setup.js [status|prepare|install|restore]');
    process.exit(1);
  }
} catch (e) {
  console.error('❌ 执行出错:', e.message);
  process.exit(1);
}

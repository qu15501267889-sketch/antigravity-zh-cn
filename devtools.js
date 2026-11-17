#!/usr/bin/env node
/**
 * Antigravity 汉化 —— 调试与覆盖率工具
 *
 * 用法（需 Antigravity 正在运行）：
 *   node devtools.js check    扫描当前界面，列出还没翻译的文案
 *   node devtools.js misses   读取引擎自动收集的漏翻清单
 *   node devtools.js clear    清空漏翻收集缓存
 *   node devtools.js eval "<js>"  在当前页面执行任意 JS（调试用）
 *
 * 原理：Antigravity 是 Electron，启动时会开一个 CDP 调试端口（记录在
 * 用户数据目录的 DevToolsActivePort 文件里）。连上去即可操作页面 DOM。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const P = require('./paths.js');

function getPort() {
  const port = P.readDebugPort();
  if (!port) {
    console.error('❌ 读不到调试端口。请确认 Antigravity 正在运行。');
    console.error('   数据目录:', P.findUserDataDir() || '未找到');
    process.exit(1);
  }
  return port;
}

function httpJSON(port, p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path: p }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(new Error('返回不是 JSON: ' + d.slice(0, 200))); } });
    }).on('error', rej);
  });
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const waiting = new Map();
    const timer = setTimeout(() => reject(new Error('连接超时')), 10000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve({
        eval(expression, timeout = 20000) {
          return new Promise((res, rej) => {
            const myId = ++id;
            const t = setTimeout(() => { waiting.delete(myId); rej(new Error('执行超时')); }, timeout);
            waiting.set(myId, { res, rej, t });
            ws.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
          });
        },
        close() { try { ws.close(); } catch { } }
      });
    };
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && waiting.has(m.id)) {
        const w = waiting.get(m.id); waiting.delete(m.id); clearTimeout(w.t);
        if (m.error) w.rej(new Error(JSON.stringify(m.error)));
        else w.res(m.result);
      }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket 连接失败')); };
  });
}

async function getMainPage(port) {
  const list = await httpJSON(port, '/json/list');
  const pages = list.filter(t => t.type === 'page' && /^https?:\/\/127\.0\.0\.1:\d+\//.test(t.url));
  if (!pages.length) {
    console.error('❌ 找不到主界面页面。当前可见的页面：');
    list.forEach(t => console.error('   [' + t.type + '] ' + t.url.slice(0, 90)));
    process.exit(1);
  }
  return pages[0];
}

const SNAP_EXPR = `(() => {
  const out = new Set();
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = tw.nextNode())) {
    const p = n.parentElement;
    if (!p) continue;
    if (p.tagName === 'STYLE' || p.tagName === 'SCRIPT') continue;
    if (p.closest('code,pre,.monaco-editor,.cm-editor')) continue;
    const t = n.nodeValue.trim();
    if (!t || t.length > 240 || !/[A-Za-z]/.test(t) || /[\\u4e00-\\u9fa5]/.test(t)) continue;
    out.add(t);
  }
  document.querySelectorAll('[placeholder],[title],[aria-label]').forEach(el => {
    ['placeholder','title','aria-label'].forEach(a => {
      const v = el.getAttribute(a);
      if (v && /[A-Za-z]/.test(v) && !/[\\u4e00-\\u9fa5]/.test(v) && v.length < 160) out.add('[' + a + '] ' + v.trim());
    });
  });
  return JSON.stringify([...out]);
})()`;

// 明显应该保留英文的（产品名/模型名/路径/键名等），从清单里滤掉减少噪音
function filterNoise(items) {
  const KEEP = /^(Antigravity|Gemini.*|Claude.*|GPT.*|Turbo|Swarm|Ctrl|Shift|Alt|Enter|Esc|Tab|Esc|Cmd|Meta|Win|Option|[\d.]+(px|%|GB|MB|KB)?)$/;
  return items.filter(x => {
    const raw = x.replace(/^\[[a-z-]+\]\s*/, '').trim();
    if (KEEP.test(raw)) return false;
    if (/^[A-Za-z]:[\\/]/.test(raw)) return false;
    if (/^~\//.test(raw)) return false;
    if (/@[\w.-]+\.(com|cn|net|org)/.test(raw)) return false;
    if (/\.(png|jpg|jpeg|gif|json|md|yaml|yml|gguf|safetensors|log|txt|exe|dll|bat|cmd|py|js|ts)$/i.test(raw)) return false;
    if (/^[a-z][a-z0-9_\-]*$/.test(raw)) return false;           // 小写标识符 / skill 名
    if (/^[a-z][a-z0-9]*\/[a-z0-9_/]+$/.test(raw)) return false;  // 路径段
    return true;
  });
}

(async () => {
  const cmd = (process.argv[2] || 'check').toLowerCase();
  const port = getPort();

  if (cmd === 'clear') {
    const page = await getMainPage(port);
    const c = await connect(page.webSocketDebuggerUrl);
    const r = await c.eval(`(() => {
      try {
        const before = (() => { try { return Object.keys(JSON.parse(localStorage.getItem('__AGY_CN_MISSES') || '{}')).length; } catch(e) { return -1; } })();
        localStorage.removeItem('__AGY_CN_MISSES');
        return '已清空（原有 ' + before + ' 条）';
      } catch (e) { return '失败: ' + e; }
    })()`);
    c.close();
    console.log('漏翻缓存:', r.result.value);
    return;
  }

  if (cmd === 'eval') {
    const page = await getMainPage(port);
    const c = await connect(page.webSocketDebuggerUrl);
    const r = await c.eval(process.argv[3] || '1+1');
    c.close();
    console.log(typeof r.result.value === 'undefined' ? JSON.stringify(r) : r.result.value);
    return;
  }

  const page = await getMainPage(port);
  console.log('目标页面:', page.url.slice(0, 90));
  const c = await connect(page.webSocketDebuggerUrl);

  if (cmd === 'check') {
    const r = await c.eval(SNAP_EXPR);
    c.close();
    const all = JSON.parse(r.result.value);
    const interesting = filterNoise(all);
    console.log('');
    console.log('未翻译原文合计:', all.length, ' 其中疑似界面文案:', interesting.length);
    console.log('---');
    if (!interesting.length) {
      console.log('（当前页面没有需要翻译的英文文案）');
    } else {
      interesting.forEach((x, i) => console.log(String(i).padStart(3), x.slice(0, 130)));
    }
    const outFile = path.join(__dirname, 'check-output.json');
    fs.writeFileSync(outFile, JSON.stringify(interesting, null, 1));
    console.log('');
    console.log('清单已保存:', outFile);
    return;
  }

  if (cmd === 'misses') {
    const r = await c.eval(`(() => {
      try {
        const raw = localStorage.getItem('__AGY_CN_MISSES');
        const obj = raw ? JSON.parse(raw) : {};
        return JSON.stringify(Object.keys(obj));
      } catch (e) { return JSON.stringify({ error: String(e) }); }
    })()`);
    c.close();
    const arr = JSON.parse(r.result.value);
    if (arr.error) { console.error('读取失败:', arr.error); process.exit(1); }
    const interesting = filterNoise(arr);
    console.log('');
    console.log('引擎累计收集:', arr.length, ' 其中疑似界面文案:', interesting.length);
    console.log('（这是引擎运行期间遇到的、字典里没有的所有文本，含大量用户内容/代码，属正常）');
    console.log('---');
    interesting.forEach((x, i) => console.log(String(i).padStart(3), x.slice(0, 130)));
    const outFile = path.join(__dirname, 'misses-output.json');
    fs.writeFileSync(outFile, JSON.stringify(interesting, null, 1));
    console.log('');
    console.log('清单已保存:', outFile);
    return;
  }

  c.close();
  console.log('用法: node devtools.js [status|check|misses|clear|eval]');
})();

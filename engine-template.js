// 引擎模板：__DICT__ 会被替换为字典 JSON
// 运行在 preload（isolated world），通过共享 DOM 修改界面文案
(function () {
  if (window.__AGY_CN_ACTIVE) return;
  window.__AGY_CN_ACTIVE = true;

  var DICT = __DICT__;

  // 动态文案规则（处理带数字/变量、无法精确匹配的）
  var PATTERNS = [
    [/^No more older messages, showing (\d+) of (\d+)$/i, '没有更早的消息（已显示 $1 / $2）'],
    [/^Load older messages, showing (\d+) of (\d+)$/i, '加载更早的消息（已显示 $1 / $2）'],
    [/^Where the agent runs, current: (.+)$/i, '智能体运行位置，当前：$1'],
    [/^For Turn (\d+)$/i, '针对第 $1 轮'],
    [/^(\d+) tasks? running$/i, '$1 个任务运行中'],
    [/^Resets in (.{1,30})$/i, '$1 后重置'],
    [/^(\d+)h limit$/i, '$1 小时限额'],
    [/^Reading (.{1,70})$/i, '正在读取 $1'],
    [/^Editing (.{1,70})$/i, '正在编辑 $1'],
    [/^Analyzing (.{1,70})$/i, '正在分析 $1'],
    [/^Running (.{1,70})$/i, '正在运行 $1'],
    [/^Searching (.{1,70})$/i, '正在搜索 $1'],
    [/^Exploring (.{1,70})$/i, '正在探索 $1'],
    [/^Close (.{1,70})$/i, '关闭 $1'],
    [/^Remove shortcut (.+) for (.+)$/i, '移除快捷键 $1 — $2'],
    [/^Shortcut (.+) for (.+)$/i, '快捷键 $1 — $2'],
    [/^Add shortcut for (.+)$/i, '为「$1」添加快捷键'],
    [/^Your Plan: (.+)$/i, '你的方案：$1'],
    [/^Select project, current: (.+)$/i, '选择项目，当前：$1'],
    [/^Send feedback as (.+)$/i, '以 $1 身份发送反馈'],
    [/^Rules: (\d+) tokens?$/i, '规则：$1 个令牌'],
    [/^Show (\d+) breakdown$/i, '显示 $1 项明细'],
    [/^You have used some of your weekly limit, it will fully refresh in (.+)$/i, '你已用掉部分每周限额，将在 $1 后完全刷新。'],
    [/^Worked for (\d+m?s?)$/i, '耗时 $1'],
    [/^Thinking for (\d+m?s?)$/i, '思考了 $1'],
    [/^Worked for (.+)$/i, '耗时 $1'],
    [/^Turn (\d+) of (\d+)$/i, '第 $1 轮，共 $2 轮'],
    [/^Select model, current: (.+)$/i, '选择模型，当前：$1'],
    [/^Agent permissions preset selector, current: (.+)$/i, '智能体权限预设，当前：$1'],
    [/^(\d+)\s+files?$/i, '$1 个文件'],
    [/^(\d+)\s+file changes?$/i, '$1 处文件更改'],
    [/^(\d+)\s+files? changed$/i, '$1 个文件已更改'],
    [/^(\d+)\s+results?$/i, '$1 个结果'],
    [/^(\d+)\s+matches?$/i, '$1 个匹配'],
    [/^(\d+)\s+items?$/i, '$1 项'],
    [/^(\d+)\s+lines?$/i, '$1 行'],
    [/^(\d+)\s+errors?$/i, '$1 个错误'],
    [/^(\d+)\s+warnings?$/i, '$1 个警告'],
    [/^(\d+)\s+characters?$/i, '$1 个字符'],
    [/^(\d+)\s+tokens?$/i, '$1 个令牌'],
    [/^(\d+)\s+of\s+(\d+)$/i, '$1 / $2'],
    [/^Show (\d+) more$/i, '再显示 $1 项'],
    [/^and (\d+) more$/i, '及其他 $1 项'],
    [/^(\d+)s ago$/i, '$1 秒前'],
    [/^(\d+)m ago$/i, '$1 分钟前'],
    [/^(\d+)h ago$/i, '$1 小时前'],
    [/^(\d+)d ago$/i, '$1 天前'],
    [/^(\d+)s$/i, '$1 秒'],
    [/^(\d+)m$/i, '$1 分钟'],
    [/^(\d+)h$/i, '$1 小时'],
    [/^(\d+)d$/i, '$1 天'],
    [/^(\d+)\s+seconds? ago$/i, '$1 秒前'],
    [/^(\d+)\s+minutes? ago$/i, '$1 分钟前'],
    [/^(\d+)\s+hours? ago$/i, '$1 小时前'],
    [/^(\d+)\s+days? ago$/i, '$1 天前'],
    [/^(\d+)\s+weeks? ago$/i, '$1 周前'],
    [/^(\d+)\s+months? ago$/i, '$1 个月前'],
    [/^(\d+)\s+years? ago$/i, '$1 年前']
  ];

  // 大小写无关的兜底索引
  var DICT_LOWER = {};
  var DICT_KEYS = Object.keys(DICT);
  for (var di = 0; di < DICT_KEYS.length; di++) {
    var lk = DICT_KEYS[di].toLowerCase();
    if (DICT_LOWER[lk] === undefined) DICT_LOWER[lk] = DICT[DICT_KEYS[di]];
  }

  // 永不翻译的标签
  var SKIP_TAGS = {
    CODE: 1, PRE: 1, SCRIPT: 1, STYLE: 1, TEXTAREA: 1, KBD: 1, SAMP: 1,
    INPUT: 1, SELECT: 1, OPTION: 1, SVG: 1, IFRAME: 1, CANVAS: 1, LINK: 1, META: 1
  };

  // 跳过这些容器（代码编辑器 / 正文区 / 用户输入）
  var SKIP_CLASS = /(monaco-editor|cm-editor|codemirror|markdown|prose|chat-message|message-content|diff-|hljs|prism|katex|mermaid)/i;

  var modifiedNodes = new WeakSet();
  var HAS_ZH = /[\u4e00-\u9fa5]/;

  function inSkippedContext(el) {
    var depth = 0;
    while (el && depth < 12) {
      if (el.nodeType === 1) {
        if (SKIP_TAGS[el.tagName] === 1) return true;
        if (el.isContentEditable) return true;
        var cls = el.className;
        if (typeof cls === 'string' && SKIP_CLASS.test(cls)) return true;
        var role = el.getAttribute && el.getAttribute('role');
        if (role === 'code' || role === 'textbox') return true;
      }
      el = el.parentElement;
      depth++;
    }
    return false;
  }

  function lookup(text) {
    if (!text) return null;
    var v = DICT[text];
    if (v !== undefined) return v;
    // 大小写无关兜底只对短文本生效，避免误伤正文里的普通英文词
    if (text.length <= 25) {
      var lv = DICT_LOWER[text.toLowerCase()];
      if (lv !== undefined) return lv;
    }
    // 去掉尾部冒号/省略号再试一次
    var alt = text.replace(/[:：]\s*$/, '');
    if (alt !== text) {
      if (DICT[alt] !== undefined) return DICT[alt] + '：';
      if (alt.length <= 25 && DICT_LOWER[alt.toLowerCase()] !== undefined) return DICT_LOWER[alt.toLowerCase()] + '：';
    }
    for (var i = 0; i < PATTERNS.length; i++) {
      if (PATTERNS[i][0].test(text)) return text.replace(PATTERNS[i][0], PATTERNS[i][1]);
    }
    return null;
  }

  // 判断文本是否值得翻译
  // 注意：这里不再做"代码特征"排除——字典是精确匹配，代码片段本就不在字典里；
  // 用 & = ` 等符号排除会误杀 "Models & Usage"、"Shortcut Ctrl+=" 这类正常文案。
  function eligible(text) {
    if (!text) return false;
    if (text.length < 2 || text.length > 220) return false;
    if (!/[A-Za-z]/.test(text)) return false;
    if (/^[\s\d.,:;!?·—\-–]+$/.test(text)) return false;
    // 纯路径 / URL / 文件名
    if (/^[a-zA-Z]:[\\/]/.test(text)) return false;
    if (/^(https?|mailto|file|data|blob|ws|wss):/i.test(text)) return false;
    if (/^[\w.\-@]+\.[a-z]{2,6}$/i.test(text)) return false;
    if (/[\\/][\w.\-]+\.[a-z0-9]{1,5}$/i.test(text)) return false;
    return true;
  }

  function handleTextNode(node) {
    if (modifiedNodes.has(node)) return;
    var raw = node.nodeValue;
    if (!raw) return;
    var trimmed = raw.trim();
    if (!eligible(trimmed)) return;
    if (HAS_ZH.test(trimmed)) return;        // 已是中文
    if (inSkippedContext(node.parentElement)) return;
    var zh = lookup(trimmed);
    if (zh === null || zh === trimmed) { recordMiss(trimmed); return; }
    var lead = raw.match(/^\s*/)[0];
    var trail = raw.match(/\s*$/)[0];
    node.nodeValue = lead + zh + trail;
    modifiedNodes.add(node);
  }

  var ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  function handleAttrs(el) {
    if (!el.getAttribute) return;
    var changed = false;
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      var v = el.getAttribute(a);
      if (!v) continue;
      var t = v.trim();
      if (!eligible(t)) continue;
      if (HAS_ZH.test(t)) continue;          // 已是中文，跳过（防重复/防循环）
      var zh = lookup(t);
      if (zh === null || zh === t) { recordMiss(t); continue; }
      el.setAttribute(a, zh);
      changed = true;
    }
    return changed;
  }

  // ---- 漏翻收集：把没匹配到的文案静默存到 localStorage，供后续补全 ----
  var MISS_KEY = '__AGY_CN_MISSES';
  var missBuffer = {};
  var missCount = 0;
  var missTimer = null;
  function recordMiss(t) {
    if (t.length < 3 || t.length > 160) return;
    if (!/[A-Za-z]/.test(t)) return;
    if (missBuffer[t]) return;
    if (missCount > 1500) return;            // 防止无限增长
    missBuffer[t] = 1;
    missCount++;
    if (missTimer) return;
    missTimer = setTimeout(flushMisses, 5000);
  }
  function flushMisses() {
    missTimer = null;
    try {
      var prev = {};
      try { prev = JSON.parse(localStorage.getItem(MISS_KEY) || '{}'); } catch (e) { prev = {}; }
      for (var k in missBuffer) prev[k] = 1;
      localStorage.setItem(MISS_KEY, JSON.stringify(prev));
      missBuffer = {};
    } catch (e) { }
  }

  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { handleTextNode(root); return; }
    if (root.nodeType !== 1) return;
    if (root.tagName && SKIP_TAGS[root.tagName] === 1) return;
    handleAttrs(root);
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null, false);
    var n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 3) handleTextNode(n);
      else if (n.nodeType === 1) handleAttrs(n);
    }
  }

  // 批量调度，避免 React 高频重渲染时卡顿
  var pending = [];
  var scheduled = false;
  function flush() {
    scheduled = false;
    var batch = pending;
    pending = [];
    for (var i = 0; i < batch.length; i++) {
      try { walk(batch[i]); } catch (e) { }
    }
  }
  function schedule(node) {
    if (!node) return;
    if (pending.length > 400) return; // 防爆
    pending.push(node);
    if (!scheduled) {
      scheduled = true;
      if (window.requestAnimationFrame) window.requestAnimationFrame(flush);
      else setTimeout(flush, 16);
    }
  }

  var observer = new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var m = muts[i];
      if (m.type === 'childList') {
        for (var j = 0; j < m.addedNodes.length; j++) schedule(m.addedNodes[j]);
      } else if (m.type === 'characterData') {
        schedule(m.target);
      } else if (m.type === 'attributes') {
        schedule(m.target);
      }
    }
  });

  function boot() {
    try { walk(document.body); } catch (e) { }
    try {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ATTRS
      });
    } catch (e) { }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

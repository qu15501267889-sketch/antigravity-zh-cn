# 技术原理与实现细节

本文记录补丁的实现原理、关键决策，以及开发过程中踩过的坑。给想深挖或想自己动手改的人看。

---

## 1. 目标程序结构

Antigravity 是 Electron 应用，但它和常见的 Electron 应用（或 VS Code 换皮）结构差别很大：

```
C:\Users\<用户>\AppData\Local\Programs\antigravity\
├── Antigravity.exe                    246 MB   Electron 外壳
├── resources\
│   ├── app.asar                       5.5 MB   主进程 + preload
│   ├── app.asar.unpacked\             (chrome-devtools-mcp，被排除在 asar 外)
│   └── bin\
│       ├── language_server.exe        215 MB   ★ 界面和业务逻辑都在这里
│       └── webm_encoder.exe
├── locales\                                     Chromium 自身的语言包（与界面无关）
└── *.pak, *.dll                                 Chromium 运行时
```

### 关键发现：界面是本地 server 渲染的网页

启动日志：

```
Starting app (v2.32.1) with dynamic port…
Host bridge server listening on http://127.0.0.1:52424
Local: https://127.0.0.1:55517/
```

界面不是 `file://` 加载的本地 HTML，而是 `language_server.exe` 在本地起 HTTPS 服务后吐出来的网页：

```
GET https://127.0.0.1:<port>/
  → <html lang="en">
      <script src="/main.js">   ← 12 MB，Closure Compiler 压缩

GET https://127.0.0.1:<port>/main.js
  → 'use strict';var ia;function aaa(){return e}function e(a){return a};...
```

那 12 MB 的 bundle **编译进了 `language_server.exe` 的只读段**，磁盘上不存在独立文件。

### 因此以下方案都不可行

| 方案 | 为什么不行 |
|---|---|
| 装语言包 | 没有 `extensions` 目录，不是 VS Code 架构；`MSG_` / `zh-CN` / `zh-Hans` 在 bundle 里零命中 |
| 改 dll | 界面文案不在任何 dll 里，在 `language_server.exe` 内部 |
| 改 exe 二进制 | 替换文本要重算 PE 段长度和所有偏移，等于让程序崩溃 |
| 拦截并替换 `/main.js` | 需要改主进程拦截 HTTPS 请求，工作量和失败率都远高于实际方案 |
| 屏幕级 OCR 翻译 | 不是真汉化，影响性能和布局 |

### 唯一干净的注入点

`app.asar` 里的 `dist/preload.js`：

```js
// utils.js（主进程）
const hubWcv = new electron_1.WebContentsView({
    webPreferences: { ...webPreferences, transparent: true },
});
const windowOptions = {
    webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path_1.default.join(__dirname, 'preload.js'),  // ← 这里
        devTools: ...,
        webviewTag: builtInBrowser,
    },
};
```

特点：

- 明文 JS（30 KB）
- `contextIsolation: true`，但 isolated world **与主世界共享同一个 DOM**
- 每次界面加载都会执行
- 主进程另有 `app.commandLine.appendSwitch('no-sandbox')`，preload 权限充足

---

## 2. Electron fuses 检查

改 `app.asar` 前必须确认没开完整性校验，否则启动会静默失败（退出码 0、无日志）：

```bash
npx --yes @electron/fuses@1.8.0 read --app "<安装目录>\Antigravity.exe"
```

本机输出：

```
Fuse Version: v1
  RunAsNode is Enabled
  EnableCookieEncryption is Disabled
  EnableNodeOptionsEnvironmentVariable is Enabled
  EnableNodeCliInspectArguments is Enabled
  EnableEmbeddedAsarIntegrityValidation is Disabled   ← 关键
  OnlyLoadAppFromAsar is Disabled
  LoadBrowserProcessSpecificV8Snapshot is Disabled
  GrantFileProtocolExtraPrivileges is Enabled
```

`EnableEmbeddedAsarIntegrityValidation` 必须是 `Disabled`。

---

## 3. asar 格式与精确重打包

### 3.1 文件布局

```
[0..3]    uint32 = 4
[4..7]    uint32 = headerPickleLen      （header 总长，含 4 字节长度前缀）
[8..11]   uint32 = payloadLen           （= headerPickleLen - 4）
[12..15]  uint32 = jsonLen              （JSON 字符串真实长度）
[16..]    JSON header（jsonLen 字节，之后 padding 到 4 字节对齐）
[8+headerPickleLen ..]  文件数据区
```

数据区起始偏移 **`8 + headerPickleLen`**。

> 注意：不能简单地用 `8 + jsonLen`。JSON 之后有 padding（`payloadLen - 4 - jsonLen`），少算这几个字节就会读出错位的内容。早期版本的提取脚本就踩了这个坑，导致提取出的文件头部多了十几个字节垃圾。

### 3.2 header 结构

```json
{
  "files": {
    "dist": {
      "files": {
        "preload.js": {
          "size": 30251,
          "offset": "12345",
          "integrity": {
            "algorithm": "SHA256",
            "hash": "43592a84...",
            "blockSize": 4194304,
            "blocks": ["43592a84..."]
          }
        }
      }
    }
  }
}
```

- `offset` 是**字符串**，且相对于数据区起点
- `unpacked: true` 的文件不在 asar 数据区里（在 `app.asar.unpacked/`）
- `integrity` 是 SHA256 + 4 MB 分块；小于 4 MB 的文件只有一个 block，`hash === blocks[0]`

### 3.3 重打包策略

`repack.js` 的原则：**只替换目标文件，其余字节原样透传**。

1. 读原 header，收集所有非 unpacked 文件
2. 按原 offset 排序（保证数据顺序与 header 声明一致）
3. 逐个写入：替换的写新内容，其余从原 asar 拷贝原始字节
4. 重算每个文件的 `offset`（累加）和 `size`
5. 被替换的文件**重算 integrity**（不是删除——保持字段存在，结构更接近原版）
6. 每个文件数据按 4 字节对齐
7. 重组 header：`u32(4) + u32(headerPickleLen) + u32(payloadLen) + u32(jsonLen) + json + padding`

往返测试（`tools/test-roundtrip.js`）验证：原样重打包后 721 个文件**逐字节 0 差异**，header 长度与原版完全一致（283448 字节）。

---

## 4. 翻译引擎设计

### 4.1 判定流水线

```
文本节点 / 属性变化
  ↓
长度 2~220？含 ASCII 字母？不含中文？
  ↓
父元素在 SKIP_TAGS（code/pre/script/style/textarea/svg...）内？
  或命中 SKIP_CLASS（markdown/prose/monaco/cm-editor/codemirror/diff/hljs/katex/mermaid）？
  或 contenteditable？
  ↓
① 精确字典匹配
  ↓ 未命中
② 小写索引兜底（仅当文本 ≤ 25 字符）
  ↓ 未命中
③ 50+ 条正则模板（带变量的动态文案）
  ↓ 仍未命中
④ 记入漏翻收集器（localStorage，上限 1500）
```

### 4.2 防循环

React 高频重渲染，三个保护缺一不可：

1. **已含中文则跳过**——翻译结果必含中文字符，二次遇到直接放过
2. **MutationObserver + requestAnimationFrame 批量**——不逐条处理
3. **pending 队列上限 400**——异常时丢弃而非堆积

### 4.3 为什么不翻译代码

三层保护：

1. 标签级：`SKIP_TAGS` 排除 `code / pre / script / style / textarea / svg`
2. 容器级：`SKIP_CLASS` 排除编辑器与 markdown 正文
3. 匹配级：字典是**整段精确匹配**，代码片段本来就不在字典里

---

## 5. 踩坑记录

### 5.1 长度阈值设太小，长描述全废

最初 `eligible()` 写了 `text.length > 90` 就跳过，理由是"防止误伤正文"。结果设置页所有描述（普遍 80~200 字符）死活翻不出来，短按钮却正常。

**修正**：上限提到 `220`。误伤风险由"精确字典匹配"控制，不靠长度。

### 5.2 用符号特征判断代码，误杀正常文案

曾用 `/[{}<>=;|&`$]/` 判断"这是代码"。结果：

- `Models & Usage` —— 含 `&`，被拒
- `Shortcut Ctrl+=` —— 含 `=`，被拒
- `Shortcut Ctrl+`` —— 含反引号，被拒

**修正**：删掉该规则。代码保护靠 `SKIP_TAGS` + 字典精确匹配，不需要符号启发。

### 5.3 元素永久标记导致动态文本再也翻不动

早期用 `WeakSet` 记录"已处理过的元素"，避免重复处理。结果 React 更新 `aria-label` 后，元素被永久跳过，`Select model, current: ...` 这类始终不翻。

**修正**：改为判断**值的当前内容是否含中文**。

### 5.4 直接 spawn 启动 GUI 程序会被回收

`child_process.spawn(exe, {detached:true}).unref()` 和 `Start-Process` 在某些终端/沙箱环境下，进程启动后立即退出（退出码 0、无日志）。

排查过程：还原原版 asar 后同样复现，证明与补丁无关。

**修正**：`explorer.exe "<exe路径>"`，由系统资源管理器拉起，稳定生效。

### 5.5 设置面板无法程序化遍历

想自动扫完所有设置分类，三种方式全部失败：

| 尝试 | 结果 |
|---|---|
| `el.click()` 合成点击 | 页面不切换 |
| `Input.dispatchMouseEvent` 真实鼠标事件（CDP） | 页面不切换 |
| `?settingsOpen=true&settingsScreen=Appearance` | SPA 忽略该参数，始终停在默认页 |

**结论**：只能靠人正常点击，靠漏翻收集器被动积累。

### 5.6 补丁的源必须是干净备份

早期 `patch.js` 从**安装目录**读 asar 作为源。装过一次补丁后，源变成了补丁版，再打补丁就是补丁套补丁，且日志自相矛盾（报"原 preload 30251 字节"但增量算出来对不上）。

**修正**：永远从 `backup/app.asar.orig` 读源。`setup.js prepare` 里还会检查：如果当前 asar 已含补丁标记，拒绝备份（防止把补丁版存成"原版"）。

---

## 6. 调试手段

Antigravity 启动时会在用户数据目录写 `DevToolsActivePort`：

```
%APPDATA%\Antigravity\DevToolsActivePort
  56559
  /devtools/browser/bc7b411f-b252-...
```

连上去就能操作页面：

```bash
node devtools.js check          # 扫描当前页未翻译文案
node devtools.js misses         # 读漏翻收集清单
node devtools.js clear          # 清空收集
node devtools.js eval "1+1"     # 执行任意 JS
```

`/json/list` 里能看到所有 target（主界面、插件 iframe、webview）。主界面的 URL 形如 `https://127.0.0.1:<port>/c/<uuid>`。

---

## 7. 版本适配

如果 Antigravity 大版本更新，先验证注入点：

```bash
node -e "const{readHeader,collectFiles}=require('./repack.js');const fs=require('fs');const P=require('./paths.js');const a=P.findAppDir()+'/resources/app.asar';const fd=fs.openSync(a,'r');const m=readHeader(fd);const f=collectFiles(m.header).find(x=>x.path==='/dist/preload.js');console.log(f?'OK '+f.node.size:'NOT FOUND');"
```

如果找不到 `/dist/preload.js`，说明 Google 重构了应用结构，需要重新定位注入点：

1. 解包 `app.asar`，看 `dist/` 下的文件清单
2. 搜 `preload:` 找窗口配置
3. 搜 `new BrowserWindow` / `WebContentsView` 找渲染入口

参考：`grep -rn "preload:" extract/dist --include=*.js`

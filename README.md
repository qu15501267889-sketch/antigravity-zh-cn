# Antigravity 中文汉化补丁

> 给 **[Google Antigravity](https://antigravity.google)**（agent-first IDE）用的非官方界面汉化补丁。
> 一行命令安装，一行命令还原，不改动程序本体逻辑。

![version](https://img.shields.io/badge/Antigravity-2.32.1-blue)
![dict](https://img.shields.io/badge/词条-1425-green)
![platform](https://img.shields.io/badge/平台-Windows-lightgrey)
![license](https://img.shields.io/badge/license-MIT-orange)

---

## 这个项目解决什么问题

Google Antigravity 是一个 AI agent 驱动的代码编辑器。它**只有英文界面**，而且：

- ❌ 没有语言包机制（没有 `extensions` 目录，不是 VS Code 换皮）
- ❌ 没有 i18n 框架（界面 bundle 里 `MSG_` / `zh-CN` 零命中）
- ❌ 设置里没有语言选项
- ❌ 界面文案编译进了一个 215 MB 的二进制里，磁盘上没有明文文件

所以**没法装语言包，也没有 dll 可以改**。

这个项目用另一种办法：往 Electron 的 `preload.js` 注入一个运行时翻译引擎，在 DOM 渲染时把英文文案替换成中文。**只改渲染层，不碰网络、不改 API、不动模型调用。**

---

## 效果

汉化后：

| 区域 | 状态 |
|---|---|
| 顶部菜单（工作区 / 视图 / 窗口） | ✅ 中文 |
| 左侧栏（新建对话 / 自动化 / 项目 / 对话） | ✅ 中文 |
| 设置页（通用 / 外观 / 快捷键 / 通知 / 模型 / 浏览器） | ✅ 中文（含标题、描述、选项） |
| 按钮、右键菜单、对话框 | ✅ 中文 |
| 状态提示、错误信息、时间格式（`5m ago` → `5分钟前`） | ✅ 中文 |
| **代码块、终端输出、文件路径** | 🔒 保持英文（故意） |
| **模型名（Gemini 3.8 Flash）、项目名、产品名** | 🔒 保持英文（故意） |

代码和模型名不翻译是设计决定——翻了会导致你认不出自己在用哪个模型，或者代码无法复制粘贴。

---

## 安装

### 前置要求

- Windows 10 / 11
- [Node.js](https://nodejs.org/) ≥ 18（推荐 20+）
- 已安装 Google Antigravity，且**至少成功登录过一次**

### 三步走

下载本仓库，进入目录：

```bash
# 第一步：探测环境（只读，不改任何东西）
node setup.js status

# 第二步：备份原版 + 生成补丁（不动正在运行的程序）
node setup.js prepare

# 第三步：关闭程序 → 写入补丁 → 自动重启
node setup.js install
```

`status` 的正常输出：

```
===== 环境 =====
安装目录 : C:\Users\<你>\AppData\Local\Programs\antigravity
应用版本 : Antigravity 2.32.1
字典词条总数         : 1425
===== 补丁状态 =====
是否已含汉化补丁     : 否（原版英文）
```

装完重启后界面即为中文。

### 卸载 / 还原

```bash
node setup.js restore
```

十秒回到纯英文原版，无残留。

---

## ⚠️ 注意事项

1. **会强制关闭 Antigravity**。`install` 步骤会 `taskkill` 掉所有进程，有未保存的对话先处理完。

2. **Antigravity 自动更新后补丁会失效**。更新会整个替换 `app.asar`。重新执行 `prepare` + `install` 即可恢复（字典和脚本都还在）。

3. **不要删 `backup/` 目录**。里面是唯一的原版 `app.asar.orig`，删了就还原不了。

4. **仅 Windows 验证过**。macOS / Linux 理论上思路相同（改 `Contents/Resources/app.asar`），但未测试，脚本里的路径探测也只覆盖了 Windows。

5. 这是**非官方**项目，与 Google 无关。修改 `app.asar` 属于非官方修改行为，自行评估。

---

## 支持版本

| Antigravity 版本 | 状态 |
|---|---|
| 2.32.1 | ✅ 已验证（开发与测试版本） |
| 2.32.x 其他小版本 | 🟡 大概率可用，注入点路径一般不变 |
| 2.33+ / 3.x | ❓ 未验证，**先跑这条命令确认注入点还在** |

```bash
node -e "const{readHeader,collectFiles}=require('./repack.js');const fs=require('fs');const P=require('./paths.js');const a=P.findAppDir()+'/resources/app.asar';const fd=fs.openSync(a,'r');const m=readHeader(fd);const f=collectFiles(m.header).find(x=>x.path==='/dist/preload.js');console.log(f?'✅ OK, preload.js '+f.node.size+' 字节':'❌ 找不到 /dist/preload.js，应用结构已变');"
```

输出 `❌` 就说明 Google 改了应用结构，本补丁不适用。

---

## 工作原理（简述）

```
Antigravity.exe
  └── resources/bin/language_server.exe  ← 215 MB，界面资源编译在里面
        └── 本地起 HTTPS 服务，吐出界面 HTML + 12 MB JS bundle
              └── Electron 渲染进程加载
                    └── resources/app.asar → dist/preload.js  ← 唯一干净的注入点
```

`dist/preload.js` 有完整的 DOM 访问权限，所有界面都要经过它。补丁往这个文件末尾追加一个翻译引擎：

1. `MutationObserver` 监听 DOM 变化
2. 文本节点命中字典 → 替换为中文
3. 命中正则模板（`Worked for 29s` → `耗时 29s`）→ 按规则替换
4. 跳过 `code` / `pre` / 编辑器区域，保护代码不被误伤

打包时只替换 asar 里的**一个文件**，其余 720 个文件逐字节原样保留（有往返测试保证），并重算 SHA256 integrity 哈希。

技术细节见 [`docs/TECHNICAL.md`](docs/TECHNICAL.md)。

---

## 常见问题

<details>
<summary><b>装完启动不了 / 白屏怎么办？</b></summary>

立即还原：

```bash
node setup.js restore
```

如果 `restore` 也说文件被占用，先在任务管理器里结束所有 `Antigravity.exe` 进程再试。
</details>

<details>
<summary><b>界面上还有个别英文？</b></summary>

正常。字典覆盖高频路径，长尾文案靠运行时收集补充。

```bash
node devtools.js check     # 看当前页面还剩哪些
node devtools.js misses    # 看历史累计的漏翻清单
```

清单里混有用户内容（对话正文、代码），这是正常的——只挑界面文案补进 `dict/` 即可。
</details>

<details>
<summary><b>代码被翻译了？</b></summary>

不应该发生。检查 `engine-template.js` 里的 `SKIP_TAGS` 和 `SKIP_CLASS` 是否被改坏。

正常配置应包含 `code / pre / script / style / textarea`，以及 `monaco-editor / cm-editor / markdown / prose / hljs`。
</details>

<details>
<summary><b>报错 HTTP 404 Requested entity was not found？</b></summary>

**与汉化无关。** 这是账号侧的 project/tier 上下文没拿到，日志里能看到 `ProjectID called with projectID:` 为空。

完整退出 Antigravity 再重新进入即可恢复（强制重新拉取账号信息）。刚刚升级会员后最容易遇到。
</details>

<details>
<summary><b>macOS 能用吗？</b></summary>

思路相同，把 `paths.js` 里的探测路径改成 `Contents/Resources/app.asar` 即可，但未实测。
</details>

---

## 目录结构

```
.
├── setup.js              # 主入口：status / prepare / install / restore
├── devtools.js           # 覆盖率检查、漏翻清单、清缓存
├── paths.js              # 路径自动探测（不硬编码用户名）
├── repack.js             # asar 精确重打包（只替换单文件）
├── engine-template.js    # 翻译引擎模板
├── dict/                 # 字典分片，共 1425 条
│   └── dict-01.json ~ dict-13.json
├── tools/
│   └── test-roundtrip.js # asar 往返一致性测试
└── docs/
    └── TECHNICAL.md      # 技术原理与踩坑记录
```

---

## 贡献

欢迎补充字典。流程：

1. 运行 `node devtools.js misses` 拿到漏翻清单
2. 挑出界面文案，新建 `dict/dict-14.json`：

```json
{
  "Chat Layout": "对话布局",
  "Conversation Width": "对话宽度"
}
```

3. 重新生成验证：`node setup.js prepare`
4. 提 PR

翻译规范：

- 术语统一：Workspace=工作区、Conversation=对话、Subagent=子代理、Artifact=产物、Sandbox=沙箱、Agent=智能体
- 产品名/模型名/路径不译
- 长度尽量不超过原文 1.5 倍（按钮空间有限）

---

## 免责声明

本项目仅修改本地 Electon 渲染层的显示文本，不分发 Google 的任何程序代码或资源文件。

本项目与 Google 无关，未获其授权或认可。「Antigravity」「Gemini」等名称归 Google 所有。

使用本补丁造成的任何问题（包括但不限于界面异常、程序无法启动、数据丢失），由使用者自行承担。项目提供完整的还原机制，但不对结果作任何担保。

---

## License

[MIT](LICENSE)

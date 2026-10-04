# Omega Browser Bridge（浏览器分支）

让 Omega 智能体控制**用户日常使用的 Chrome**（保留登录态、Cookie、已登录会话），与 `chrome_devtools_*` 系列工具的 CDP 模式（自动启动独立临时 Profile）互补。

## 组成

- 本目录（`plugins/browser-plugin/`）：Chrome MV3 扩展，作为 WebSocket 客户端连接 Omega。
- `packages/omega-core/src/browser-extension/`：Omega 侧桥接模块，在 `ws://127.0.0.1:9334-9343` 中占用一个空闲端口（可用环境变量 `OMEGA_BROWSER_BRIDGE_PORT` 固定端口）并注册 `browser_ext` 工具。

多个 Omega 会话可并行运行：每个会话占用一个端口，并以 `agentId`/`agentName` 标识自己。扩展探测整个端口段，在侧边栏顶部的下拉框中选择聊天路由到哪个智能体。

## 安装

1. 打开 Chrome，访问 `chrome://extensions`。
2. 右上角开启「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择本目录（`plugins/browser-plugin`）。
4. 扩展会在安装后自动连接本机桥接端口；Omega 会话启动时自动开启桥接服务端。

## 智能体工具

10 个动作合并为一个编号调度工具 `browser_ext`：模型回答 `number`（下列编号）加该动作自己的参数，`tabId` 全部可选，默认当前活动标签页。

| # | 动作 | 参数 | 说明 |
| --- | --- | --- | --- |
| 1 | `status` | — | 查看桥接服务端与扩展连接状态 |
| 2 | `list_tabs` | — | 列出所有标签页 |
| 3 | `select_tab` | `tabId` | 将指定标签页置前 |
| 4 | `navigate` | `url`, `tabId?` | 导航（无 `tabId` 时新建标签页） |
| 5 | `evaluate` | `expression`, `tabId?` | 在页面主世界执行 JS（结果需可 JSON 序列化） |
| 6 | `get_content` | `tabId?`, `maxLength?` | 读取标题 / URL / 可见文本 / HTML |
| 7 | `screenshot` | `tabId?` | 截取可见区域并保存为 PNG（临时目录） |
| 8 | `click` | `selector`, `tabId?` | 点击 CSS 选择器匹配的元素 |
| 9 | `type` | `selector`, `text`, `tabId?` | 设置输入框值并派发 input/change 事件 |
| 10 | `get_auth` | `tabId?`, `maxCookies?` | 读取当前页鉴权上下文：Cookie（含 HttpOnly）、document.cookie、localStorage、sessionStorage |

CLI 命令：`/browser-bridge status|start|stop|name <名称>`。

`name` 给当前会话起一个浏览器插件会话名，写入 `~/.omega/browser-bridge-sessions.json`；侧边栏头部随即显示该名称，之后可用侧边栏的 `/switch <名称>` 切回。不带参数时显示当前名称。

## 侧边栏对话

Chrome 侧边栏（边栏图标 → Omega，或从 chrome://extensions 的「打开侧边栏」进入）提供聊天窗口：

- 输入消息经扩展 WebSocket 直达 Omega 会话（以 `[Chrome 侧边栏]` 前缀作为用户消息触发智能体回合）。
- 智能体的文本回复经 `message_end` 事件回流到侧边栏实时显示。
- 需要先在终端启动 Omega 并加载扩展桥接，侧边栏顶部显示「● 已连接」即可对话。

连接状态以应用层心跳为准：扩展每 5 秒向已连接端口发 `ping`，15 秒内没有收到任何消息即判定连接失效并断开重连。因此 Omega 进程退出、socket 半开等情况都会在 15 秒内显示为「● 未连接」，不会停留在假的已连接状态。

## 鉴权上下文说明

`browser_ext_get_auth` 通过 `chrome.cookies` API 可以读取目标页**全部 Cookie（包括 HttpOnly）**，以及 `document.cookie`、`localStorage`、`sessionStorage` 中的 token。因此常见鉴权（Session Cookie、JWT 存储等）都能交给 Omega 用于授权测试。

不能直接读取的内容：

- 浏览器已发出的历史请求头（如运行时附加的 `Authorization: Bearer` 头）——MV3 扩展无法回溯读取；若 token 在 localStorage/Cookie 中则可覆盖。
- 内存中的凭据。

如需抓取请求头，建议配合 Omega 现有 CDP 网络抓包（`chrome_devtools_network`）或代理工具。仅在授权测试环境使用。

## 协议

扩展 ↔ Omega 之间为 JSON 文本帧：

- 扩展 → Omega 握手：`{"type":"hello","extension":"omega-browser-bridge","version":"1.1.0"}`
- Omega → 扩展 身份与状态：`{"type":"agent_info","agentId":"agent-…","agentName":"…"}`、`{"type":"session_info","model":{...},"sessionId":"…"}`
- 扩展 → Omega 心跳：`{"type":"ping"}`；Omega 回 `{"type":"pong"}`
- 侧边栏 → Omega：`{"type":"chat","text":"…"}`、`{"type":"broadcast","text":"…"}`、`{"type":"switch_session","op":"new|switch","name":"…"}`、`{"type":"stop"}`
- Omega → 侧边栏：`{"type":"chat_reply","text":"…"}`（`done`/`queued`/`broadcast` 为可选标志）
- Omega → 扩展 命令：`{"type":"command","id":1,"tool":"navigate","params":{"url":"https://example.com"}}`
- 扩展 → Omega 响应：`{"type":"response","id":1,"ok":true,"result":{...}}` 或 `{"type":"response","id":1,"ok":false,"error":"..."}`

## 局限

- `evaluate` 在页面主世界使用 `eval`，受页面 CSP 限制的站点可能失败；此时改用 `get_content`。
- `screenshot` 依赖 `chrome.tabs.captureVisibleTab`，只能截取当前可见区域且标签页需在前台窗口。
- 桥接仅监听 `127.0.0.1`，不出本机；扩展具备 `<all_urls>` 脚本注入权限，请只在可信环境安装。

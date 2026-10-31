# 开发说明

面向改这个插件的人。用户只需要看仓库根目录的 README。

## 三种形态

浮窗是一个自绘的 WPF 窗口（不是系统通知），有三种形态：

```
临时卡片          新提醒到达时弹出，N 秒后自动消失
                 没有计数、没有展开箭头，只能「点进去」或「关闭」

   ┌─────────────────────────────┐
   │ [图标] DeepSeek Harness     │
   ├─────────────────────────────┤
   │ ● 重构通知模块          ✕   │
   │   需要审批 · Bash · 请求…   │
   └─────────────────────────────┘

小球              持久提醒攒下来后缩成右下角一个圆球
                 带计数角标，可拖动，拖动位置只存内存（重启回右下角）

   ╭────╮
   │ 3  │  ← 计数
   ╰────╯

列表              点小球展开
                 每条可「进入」或「✕」单独关掉，底部「收起」回到小球

   ┌─────────────────────────────┐
   │ [图标] DeepSeek Harness     │
   ├─────────────────────────────┤
   │ ● 重构通知模块          ✕   │
   │   需要审批 · Bash · 请求…   │
   ├─────────────────────────────┤
   │ ● 插件配置讨论          ✕   │
   │   需要你回答 · 要保留…      │
   ├─────────────────────────────┤
   │           收起              │
   └─────────────────────────────┘
```

## 提醒类型

持久性写死，不提供配置：会阻塞对话的提醒才值得一直留着。

| 类型 | 何时触发 | 持久 | 默认开关 |
|---|---|---|---|
| `approval` | 请求审批 | ✔ 进列表、计小球 | 开 |
| `question` | 请求你回答问题 | ✔ 进列表、计小球 | 开 |
| `error` | 执行出错 | ✔ 进列表、计小球 | 开 |
| `turnDone` | 轮次完成 | ✘ 弹卡片后丢弃 | 开 |
| `subagent` | 子代理完成 | ✘ 弹卡片后丢弃 | **关** |
| `sessionDone` | 会话被删除 | ✘ 弹卡片后丢弃 | **关** |

持久提醒在以下情况自动撤下：

- **审批 / 提问**：请求被回答或取消时，Host 收到结果并撤下对应条目
- **出错**：切到该错误所属的会话即视为「已看到」，客户端上报当前会话后撤下

## 它怎么工作

插件分两半：

**Host 半区**（`lib/index.js`，Node 子进程）
- 监听 `approval/request`、`user-questions/request`、`agent/status`、`agent/error`、`session/disposed`
- 监听 `session/event` 里的 `session/title`，用来跟上会话改名（见下节）
- 决定每条提醒走哪条通道：浮窗、只响一声、还是不发
- 浮窗模式：把一个常驻的 WPF 浮窗进程拉起，用 stdin/stdout 每行一个 JSON 通信
- 系统通知模式：调 `lib/system-notify.js` 起一个平台命令发通知
- 通过 `connection.fetch` 暴露回环端点，供浏览器半区取待跳转会话、上报主题和当前会话

**浏览器半区**（`lib/client.js`，渲染进程）
- 读 DSH 当前深浅色主题并上报
- 轮询待跳转会话，调 `uiWorkspace.openSession` 真正跳过去
- 上报当前正在查看的会话，用于撤下该会话的出错提醒

**浮窗进程**（`lib/native/dsh-notify-overlay.exe`）
- WPF 窗口，`Topmost` + `AllowsTransparency`，无边框无任务栏
- 三种形态的状态机、拖动、贴边吸附加动画
- 唤回 DSH 主窗口走 Win32（最小化用 `SW_RESTORE`，托盘隐藏用 `dsh://open`，已可见只抢前台）

跳会话为什么必须绕一圈：`uiWorkspace.openSession` 只存在于渲染进程，外部进程调不到。所以浮窗点击 → Host 缓存会话 id → 浏览器半区取走 → 渲染进程跳转。

### 卡片上的会话名从哪来

标题不在 `session.header` 里，而是会话日志中的 `session/title` 事件（取最后一条）。三种来源：用户改名（`source.kind === 'user'`）、模型生成（`provider`）、首条消息截断的兜底（`fallback`）。

`ctx.get('sessionTitle').get(session)` 能拿到最新标题，但它内部是 `snapshotEvents()` 复制整个日志再 `findLast`——**开销跟日志长度成正比**，而且 `snapshotEvents` 已标 `@deprecated`。所以只在两种时候调用：缓存里没有这个会话时（第一次弹提醒、从磁盘恢复的会话），之后靠 `session/event` 里的 `session/title` 事件更新缓存。

**为什么不能只靠监听**：从磁盘恢复的会话，日志是在 `Session` 构造函数里作为种子直接塞进去的，**不派发 `session/event`**。少了那次 `get()`，重启后所有卡片都会退回 id 前缀。

已经收进小球列表的旧卡片不会跟着改名，只有新弹的提醒用新标题。

### 系统通知为什么放在 Host

放渲染进程（Web Notification）的唯一好处是能保留点击跳转，但 DSH 的 `BrowserWindow` 没有关 `backgroundThrottling`，窗口隐藏时渲染进程的定时器会被节流到约每分钟一次——正好是通知唯一有意义的场景。Host 直接起平台命令没有这个问题，也不需要 Host→渲染进程的推流通道。

代价是点击没有反应（细节见 `docs/windows-notifications.md` 或笔记 §10）。

## 构建与测试

```bash
npm run build        # src/*.ts → lib/*.js
npm run build:native # src/native/OverlayWindow.cs → lib/native/*.exe（需要 .NET SDK）
npm run typecheck    # tsc 两个配置
npm run preflight    # 发布前检查：dsh.client 契约、exports、locale、icon
```

`lib/` 提交进仓库（DSH 直接加载），`lib/native/dsh-notify-overlay.exe` 也在其中——改动 C# 之后要重新编译并一起提交。

### 测试

```bash
export DSH_PACKAGES=<DSH 安装目录>/resources/app.asar.extracted/dsh/node_modules
npm test               # 十个套件，随时可跑
npm run test:toast     # Windows 真机：toast 是否真的进了系统通知库
npm run test:visual    # 需要真机窗口：会弹浮窗、读日志
```

`npm test` 覆盖：cordis 契约、配置默认值、面板字段一致性、热更新、过滤器决策、系统通知拼串、会话标题跟随。它不会拉起浮窗进程、不会弹系统通知、也不写生产日志——`overlay: false` 装载 + `DSH_NOTIFY_OVERLAY_TRACE` 重定向到临时文件。

**`DSH_PACKAGES` 是 `test/title.mjs` 要的**（其余九个不用）：它要跑在官方真实的 `SessionStore` + `SessionProjectionRegistry` + `SessionTitleService` 上，而且必须和宿主用**同一份 cordis**，否则 `Service` / `Context` 会分裂成两个世界、事件根本到不了对方。没设会打印提示并以退出码 2 结束。

`test/title.mjs` 把 `child_process.spawn` 换成假的来截下发往浮窗的 JSON，所以不会起浮窗进程。它断言的是 `sessionLabel`，覆盖三种场景：改名后下一条提醒、会话移出内存后的「会话结束」卡片、用种子日志恢复的会话首次提醒；中英各跑一遍。这个文件扩展名是 `.mjs`，`import` 前换 `spawn` 还要配 `syncBuiltinESMExports` 才生效。

`test:visual` 里的脚本会真的操作窗口和进程，各自独立：

```bash
node test/modes.mjs     # 三形态状态机流转
node test/logic.mjs     # 点击命中与跳转
node test/scale.mjs     # 缩放倍率
node test/height.mjs    # 卡片高度随内容增长
node test/sound.mjs     # 声音只在 sound 指令里响
node test/restart.mjs   # 浮窗挂掉后能重新拉起
node test/reuse.mjs     # 进程复用
node test/drift.mjs     # 拖动后位置漂移
node test/showcase.mjs  # 三种形态的视觉展示
node test/list-windows.mjs  # 枚举 DSH 顶层窗口
```

`test:toast` 单独拆出来是因为它只在本机实测有意义：它去查 `wpndatabase.db` 有没有多出一行，而不是看命令的退出码——WinRT 的 `Show()` 在 AUMID 不对时会正常返回、不抛异常、也不显示。

## 排查

Host 和浮窗各写一份 trace 日志：

- Host：`%TEMP%\dsh-notify-overlay-host.log`，可用环境变量 `DSH_NOTIFY_OVERLAY_TRACE` 改路径
- 浮窗：`%TEMP%\dsh-notify-overlay.log`

浮窗还支持几个调试指令（`hotzones` / `hittest` / `simclick` / `simfocus`），细节见 `src/native/OverlayWindow.cs` 顶部注释。

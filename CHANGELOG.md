# Changelog

All notable changes to Pi Desktop will be documented in this file.

## [0.7.0] — 2026-08-23

### Added
- **首屏骨架屏** — 应用窗口在 JS 执行前就画出外壳形状（56px 侧栏 + 48px 顶栏 + 呼吸的 π 标记）。此前 `BackendProvider` 要等客户端 effect 解析完容器才渲染，预渲染的 `<body>` 是空的，整个 bundle 解析 + hydrate 期间窗口一片空白。骨架屏是预渲染 HTML 里的静态标记，随样式表一起绘制，几何数值抄自 `NavRail` / `TopBar`，因此真实外壳接管时不会有位移

### Changed
- **宠物窗口不再阻塞首屏** — 此前 `setup()` 无条件预创建宠物窗口，而宠物默认是关闭的（`enabled: false`）。它是加载同一份 Next bundle 的第二个 webview，与主窗口争抢渲染预算（dev 下还要抢 Next 的按需编译），所有用户都为此付费，包括从不开启宠物的多数人。现在改由主窗口在首帧绘制完、主线程空闲后调用 `pet_window_prewarm` 隐藏预热，且仅在用户确实启用了宠物时才做；窗口保持隐藏直到 `/pet` 上报就绪，避免闪出预渲染的「No pet selected」占位
- **宠物窗口显示时不再抢焦点** — 移除 `pet_window_show` / `pet_window_toggle` 里的 `set_focus()`。它是 200x250 的置顶浮层，抢焦点只会打断用户正在输入的内容；开机自动唤起那条路径上它甚至会从主窗口手里抢走焦点。`always_on_top` 已足够保证它可见
- **宠物窗口 devtools 改为按需** — dev 下不再自动打开：那会在启动期再拉起一个 webview，正是本次要避开的开销。调试宠物本身时设 `PI_PET_DEVTOOLS=1`
- **MCP 配置页支持深浅色** — `mcp-tokens.ts` 原本是一份刻意写死的 light-only 调色板（注释即写着「in any theme」），因此深色模式下整页仍是亮白宣纸。现在取值搬到 `globals.css` 的 `:root` / `:root[data-theme="dark"]`，token 模块只做 `var()` 转发，消费方 JSX 一行未改。同一套设计两种纸：宣纸（白天）/ 墨夜（夜间），墨与纸两端对调，但 `elevated` / `sunken` 的语义不翻转。浅色取值与原调色板逐字节一致，白天观感无变化
  - 关键点：印章红必须拆成两个角色。`--mcp-seal` 是「墨」（错误文字、警示图标、caret），深色下要提亮才读得清；`--mcp-seal-fill` 是「地」（主按钮底，上压纸白色标签），必须保持够深否则标签对比度不足。因此 hover 方向相反：浅色变深，深色变浅

### Fixed
- **路由切换时的加载态不再闪底色，也不再漏出窗口材质** — `app/loading.tsx` 原先只给三个点上色，容器自身没有背景，于是最近的有底色祖先是 `<body>`（`--bg-base`）；而每个目标页各画自己的底（`/settings/`、`/skills/` 是 `--bg-elevated`，`/models/` 是渐变，`/mcp/` 是水墨宣纸），所以每次跳转都闪一下页面底色（实测深色 `rgb(0,0,0)` → `rgb(28,28,30)`，浅色 `rgb(255,255,255)` → `rgb(242,242,247)`）。更要紧的是靠 `<body>` 并不安全：用户设了背景图时 `appearance.ts` 会打 `body { background: transparent !important }`，而 Tauri 主窗口是 `transparent: true` + mica/acrylic，此时没有自身底色的 fallback 会直接漏出系统材质 —— Windows 浅色主题下就是一片亮的，与 app 自身是否深色无关。现在 fallback 自绘 `--bg-elevated` 并补上 48px 顶栏（含拖拽区），并对宠物窗口加了守卫（`data-shell="pet"` 下保持透明），否则那个透明浮层会在导航瞬间变成实心方块
- **在子路由上刷新会白屏** — `NavRail` 的 `pathname.startsWith()` 未判空。`usePathname()` 类型标注是 `string`，但 App Router 客户端挂载前会返回 `null`，因此硬加载子路由（在 `/mcp/` 上按刷新，或直接打开该地址）会在 render 中抛异常，整个外壳落入 `GlobalErrorBoundary`
- **MCP 页三处对比度不达标**（用脚本从实际生效样式表读值实测，非目测）：浅色占位符文字在输入框填充上仅 2.35:1（占位符底线 3:1）→ 3.19:1；浅色迁移警告文字在卡片上仅 2.61:1，而它承载正文信息 → 4.89:1；深色印章按钮 hover 态 3.99:1 → 4.63:1。最终 20 组文字/底色配对在双主题下全部通过
- 宠物窗口的显示状态现在会同步回 store 与持久化偏好，此前 `windowVisible` 始终停在默认值，导致「从未显示过」与「用户主动隐藏」无法区分，PetSettings 的显示/隐藏按钮文案也是错的

### Internal
- 新增 `runWhenIdle()`（`src/lib/idle.ts`）：把非关键启动工作推到首帧绘制之后的空闲间隙，附 rAF 双帧 + `requestIdleCallback` 回退（WKWebView 在 Safari 17.4 前没有该 API）
- `PetWindowPort` 新增 `prewarm()`，desktop / mock / 测试三处实现同步

---

## [0.6.0] — 2026-08-22

### Added
- **Provider 登录（设置 → 账号）** — 在应用内完成 pi 的 provider 认证，不再需要开终端跑 `/login`。订阅制 OAuth 支持 ChatGPT Plus/Pro (Codex)、Claude Pro/Max、GitHub Copilot、xAI、Kimi For Coding、OpenRouter、Radius，另可为任意 provider 保存 API key。实现方式是复用 pi 自己导出的 `ModelRuntime.login()`：PKCE、回调服务器、device code、token 交换、写 `auth.json` 全部仍由 pi 负责，桌面端只实现它的 `AuthInteraction` 并通过 sidecar 转发，因此 pi 更换 client id 或新增 provider 时无需同步改动
- **多任务并行对话** — 每个会话拥有独立的 `pi --mode rpc` 进程（按 `task_id` 索引），可同时跑多个对话；新增后台任务条显示非焦点任务的运行/等待/失败状态与当前工具名，支持点击切换与停止
- **MCP 配置管理页** — 读写、发现全局与项目级 MCP 配置，适配器检查，一键打开配置目录
- **远程控制** — 设备配对（QR）、已配对设备管理与吊销、网络地址与端口配置、身份重置
- **发送快捷键偏好** — 可在设置中选择 ⌘↩ / ↩ / ⇧↩ 作为聊天发送键，⌘/Ctrl+Enter 始终可用
- **三路主题切换** — 跟随系统 → 浅色 → 深色，并通过首屏内联脚本消除 SSR 主题闪烁
- **聊天面板宽度可拖拽** — 新增面板调整器，含最小/最大宽度限制
- **扩展交互支持自由文本** — 选择题在预设选项之外可直接输入自定义答案
- 消息气泡悬停显示复制按钮

### Changed
- **模型页展示内置 provider** — pi 内置的 provider（如已登录的 Kimi For Coding、Anthropic）现在与自定义 provider 一样以卡片形式出现在页面上方，带「内置」徽章，勾选即可在对话中选用。由于 pi 上报的模型列表本身包含 models.json 的 provider，合并时按 provider id 去重，models.json 的覆写优先——与 pi 自身的解析顺序一致
- 模型与 provider 的删除确认统一为一个确认对话框组件
- 会话生命周期：项目切换不再重启 pi，改为按任务释放客户端
- 消息列表滚动改为即时跟随（`followOutput: "auto"`），避免平滑动画跟不上流式输出
- pi 子进程的 PATH 前置 npm 全局 bin 目录，使 npm 安装的 CLI 在扩展中可被解析

### Removed
- **模型页底部「全部模型」区块** — 内置 provider 进入卡片区后，该区块会让每个内置模型重复出现两次，故连同左侧导航的跳转入口一并移除
- 远程任务页面及其样式（未被引用）

### Fixed
- 模型页在 pi 尚未连接时误报「没有提供商」——空状态改为同时要求 pi 就绪
- 桌面宠物精灵动画的 CPU 占用与内存泄漏：改用精确 `setTimeout` 调度替代 `requestAnimationFrame` 轮询、加入最小帧间隔、缓存动画时序、修正图片加载错误处理
- 宠物窗口因订阅整个 store 导致的无关重渲染——改为细粒度选择器
- 虚拟滚动中的外边距塌陷（`flow-root`）
- 聊天恢复服务重复配置

### Mobile
- **交互回答改为底部弹层** — `AwaitingCard` 收敛为状态卡片与入口，新增全局唯一的 `InteractionSheet`：支持下拉关闭、左右滑动切题、长按确认等手势；`AndroidManifest` 加入软键盘适配模式
- 底部导航栏改用 Lucide 图标并调整样式

### Internal
- 版本号统一：`package.json` 此前停留在 0.4.1，而 Tauri 侧已是 0.5.0，导致设置页显示的版本号（`APP_VERSION` 读自 `package.json`）与实际不符。现已与 `tauri.conf.json`、`Cargo.toml` 对齐
- 后端边界检查纳入 provider-auth、MCP、远程控制命令（命令清单 57 → 62）
- 新增 `tests/backend/provider-auth.test.ts`（8 个用例，覆盖 sidecar JSONL 解析与登录状态机）

---

## [0.5.0] — 2026-08-17

### Added
- **移动端流式回复** — 会话网关新增 `message.delta` 事件实时转发（`run_turn_with_stream` + 流式 outbox 写入），移动端回复逐字显示，不再等回合结束后一次性出现
- **移动端本地通知** — `@capacitor/local-notifications` 接入：会话回复完成、一次性任务完成、Pi 等待交互时推送系统横幅通知；正在观看对应页面不打扰；点击通知深链跳转会话/任务详情
- **CI/CD Android 打包** — `release.yml` 新增 `android` job：push tag 时自动构建并签名 APK 附到 GitHub Release（keystore 由 `PI_KEYSTORE_*` secrets 注入，未配置时 fallback debug 签名）
- **Android 签名配置** — `build.gradle` 支持环境变量驱动的 release 签名 + tag 版本号注入（`-PversionName`）
- 通知图标 `ic_stat_pi.xml`、通知渠道 `pi-task-events`（高优先级 + 震动）

### Changed
- **移动端聊天页布局重构** — 会话详情页按 iOS 信息架构重组：顶栏「返回 + 居中标题/副标题（状态·轮次·模型）+ ⋯ 菜单（归档/取消收进）」，模型选择移入 composer 底行，删除独立状态条、正文取消按钮与全宽归档按钮
- **沉浸式页面** — 聊天详情页、新建任务页、文件预览页隐藏顶部连接条与底部 TabBar，内容独占整屏
- **边框体系减淡** — 深色主题 `--color-separator` 0.6 → 0.34，TabBar/Composer 去除硬边框，改毛玻璃 + 背景色差分区
- 连接条移除「Pi Desktop」文字，仅保留连接状态徽标

### Fixed
- 移动端第二轮对话 AI 回复不可见（数据正常但列表无自动滚动）— 新增近底部条件滚动跟随
- 移动端只能看到回复最终内容、中间过程缺失 — 网关流式事件转发（桌面端需重启生效）

---

## [0.4.1] — 2026-08-02

### Added
- **会话自动标题生成** — 首条用户消息发送后，通过独立的临时 Pi 进程自动生成简洁会话标题（无工具/无扩展/无 session 副作用），含并发锁和超时保护
- **原生确认对话框** — 模型页面的删除确认从 `window.confirm` 改为 `@tauri-apps/plugin-dialog`，桌面端体验一致
- `pi_generate_title` Rust 命令注册 + `dialog:allow-message` capability

### Changed
- Agent 活动面板重构为紧凑单行动态指示行（`ActivityLine`），新增 `PiSpark` 旋转辐条和 `ShimmerText` 渐变动画
- `auto_retry_end` 处理逻辑改进：终端失败时将错误写入消息 transcript，避免 banner 消失后丢失上下文
- `appendAssistantError` 精确判断当前回合是否已有 assistant 消息，防止覆盖上一轮内容
- `renameSession` 同步桌面端命名至 Pi CLI 的 `set_session_name`

### Fixed
- 重试全部失败后错误信息随 banner 消失而丢失的问题

---

## [0.4.0] — 2026-08-01

### Added
- **OS 原生通知** — 通过 `tauri-plugin-notification` 实现双后端通知架构（Tauri 插件 + Web API fallback），窗口被遮挡/最小化时自动发送桌面通知
- **Steer/Queue 投递模式** — 流式回复进行中可选择 Steer（立即注入上下文）或 Queue（排队等待回合结束后发送）两种消息投递方式
- **ComposerInput 投递切换** — 新增投递模式切换药丸按钮、双发送按钮（Zap = steer, ListPlus = queue）、动态占位文字、⌘⇧⏎ 快捷键
- **Pet 状态通知** — 宠物进入 review/waiting/failed 等终态时触发桌面通知提醒用户
- **PetBubble 气泡组件** — 宠物对话气泡 UI 组件
- **model-scope 管理** — 新增 `provider/id` 规范引用格式，`modelRef()` / `hasGlobEntry()` / `isModelEnabled()` / `toggleModelEnabled()` 含旧格式兼容扩展
- **pet-restore-main** — 点击宠物气泡可恢复主窗口焦点
- 新增 `tests/pet-notifications.spec.ts` 测试覆盖

### Changed
- **通知系统重构** — `notifications.ts` 完全重写：`isWindowObscured()` 检测原生窗口可见性，`refreshNotificationPermission()` / `showViaPlugin()` 双通道
- **pet bridge** — 增加 `FALLBACK_SESSION_ID` 防止无 session 事件时宠物状态机卡死；`sessionKey()` 辅助函数；修复 body resolution 导致 idle 动画重启
- **Capabilities 扩展** — 新增 `core:window:allow-is-visible`、`core:window:allow-is-minimized`、`notification:default` 权限声明
- ComposerInput、ModelPicker、AgentPanel、MessageBubble、RetryBanner、PetSprite 等组件 UI 调整
- i18n 新增 composer/queue/pet 通知相关 key（en + zh）
- `chat.ts` / `client.ts` / `protocol.ts` / `sessions.ts` / `ext-ui.ts` 协议层重构适配 steer/queue
- `globals.css` 新增 +155 行样式
- `tests/queue.spec.ts` 重构

### Fixed
- 宠物因非模态 `extension_ui_request` 事件误入 "waiting" 状态
- idle 动画因冗余状态推送反复重启

---

## [0.3.1] — 2026-07-31

### Added
- **会话历史按项目隔离** — 侧边栏只展示当前项目的对话列表，切换项目时自动恢复该项目的最近会话上下文，避免跨项目 session 文件错乱 (`dda416f`)
- `chat_store` 新增 `project_root` 列与索引，带向后兼容迁移（旧数据自动回填到 last_project）
- 新增 `switchProject` / `flushActiveSession` API，workspace 切换时先落盘再恢复

### Changed
- `.gitignore` 添加 `.comate/` 目录

---

## [0.3.0] — 2026-07-31

### Added
- **Agent Panel scroll button** — 消息列表右下角新增悬浮滚动按钮；内容超出视口时自动显示，在底部时可跳到顶部，反之跳到底部 (`6a095a6`)
- 终端 bash 流式输出 + 子代理甲板功能 (`53a535d`)
- WSL 支持 + 虚拟滚动组件 (`0b70b9f`)

### Changed
- **Model selection UX** — 改进模型选择的可见性与交互 (`cc076db`)

### Fixed
- CI: 修复 `cc-no-brepro` wrapper 路径硬编码 (`b0b844a`)
- CI: 修复 pnpm 版本冲突 (`4f1a9c5`)

---

## [0.2.0] — 2026-07-28

### Added
- 跨平台 GitHub 发布与内置自动更新
- 自定义宠物支持、模型编辑优化
- 禅模式品牌标题
- 终端抽屉焦点保持与尺寸自适应
- streamdown 流式 Markdown 渲染

### Fixed
- 宠物窗口白屏及启动预加载问题
- 托盘交互与输入框样式

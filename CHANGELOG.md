# Changelog

All notable changes to Pi Desktop will be documented in this file.

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

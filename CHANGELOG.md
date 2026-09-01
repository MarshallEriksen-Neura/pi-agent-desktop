# Changelog

All notable changes to Pi Desktop will be documented in this file.

## [0.11.0] — 2026-09-01

### Added
- **Remote Agent —— 会话可以跑在另一台机器上的 pi 里**,通过 SSH。这是这个版本的主体,分几层落下来
  - **执行目标是每个会话自己的选择**,不是全局开关。`chat_sessions` 新增 `execution_binding` 字段(schema 1 → 2,带迁移),所以一个会话记得自己属于本地还是某台远程主机,重启之后仍然接回原处。侧边栏按 target 分域:切到远程主机看到的是那台机器上的会话列表,本地的会话不会混进来 —— 恢复一个跨域会话会把 pi 指向另一个 cwd 下的 session 文件
  - **两种生命周期**。`attached`:pi 的寿命就是 SSH 通道的寿命,通道断它就死。`detached`:pi 活在 launcher 的 supervisor 下、比通道长命,桌面关掉再打开能重新接上正在跑的任务、补播错过的事件(协议见 [docs/remote-agent-v2-supervisor-protocol.md](docs/remote-agent-v2-supervisor-protocol.md))。补播是按 sequence 游标做的精确一次投递,不是重新跑一遍
  - **`pi://exit` 不代表远端 pi 死了**,这是自动重连必须知道的事。那个事件报的是本地 `ssh` 子进程结束了。launcher 靠转发 SIGHUP 杀 pi,而这要 sshd 先注意到对端已死 —— 实测在双向网络分区下:桌面 24.2 秒放弃,远端 pi 在 122 秒时仍然活着,并且在分区恢复后继续存活。`sshd -T` 报 `ClientAliveInterval 0`,也就是没有应用层 keepalive,回落到内核 TCP keepalive 的 7200 秒。两边认知不一致的窗口是**两小时**量级,所以旧行为会在这个窗口里把两个 `pi --session` 进程放到同一份 transcript 上。自动重连现在只对本地生效;远程退出追加 `remoteAgent.target.statusUnknown` 并等一次显式重启
  - **launcher 能力握手**(`--capabilities`)。V1 launcher 对任何未知模式都回 `invalid launcher mode` 加 exit 64,和一个损坏的 launcher 逐字节相同,所以新桌面此前无法区分"这台主机要升级 launcher"和"这个 launcher 坏了",也就无法有意降级。不是假设:测试主机上装的 launcher 已经落后五个版本(7418 字节 vs 34846,`provider-sync` 出现零次),而这个漂移完全是静默的。`--capabilities` 由 `sh` 前导在**任何 node 探测之前**应答 —— 桌面最需要知道一台主机支持什么的时刻,恰好是 node 缺失或损坏的时刻,而那时其他所有模式都会失败。降级规则是承重部分:未被应答的查询不是失败,它意味着 V1 基线(只有 `run-v1` 和 `preflight-v1`)
  - **launcher 自动升级**。新增 `launcherRevision` 和 `statusVersion` 两个字段做版本判定,落后就就地替换。但主机上有活动任务、且升级会改变任务状态格式时**刻意不升** —— 那会让正在跑的任务变得既读不到也停不掉,而等待不花任何代价,任务两种情况下都活着
  - **远程文件浏览是只读的,而且在结构上不可能走错**。`WorkspaceFsPort` 此前是一个全局实例、每个路径都是裸字符串,没有任何结构性的东西阻止一个远程路径抵达本地文件系统桥 —— 只有散落在各 store 里的 `kind === "ssh"` 提前返回,每个新调用点都得记得写。`createWorkspaceFs(targetId)` 现在和 `createPiProcess` 一起挂在 `BackendPorts` 上,SSH target 解析到一个**拒绝每一次调用**的 port(稳定报 `remoteWorkspaceUnsupported`),永远不会解析到本地那个。读也拒绝,不只是写 —— 只拒绝写的 port 仍然会让远程路径被本地读出来
  - **远程文件夹选择器可以直接打路径**,不必只靠面包屑一层层点。上下箭头选、Tab 补全、Enter 打开,输入带防抖以免每敲一个字符就发一次 SSH 请求
  - **远程终端**。四个命令(`remote_terminal_start` / `write` / `resize` / `stop`)走独立通道,不占用 pi 的 RPC
  - **远程 provider 同步**,两阶段批准:先看要同步什么的脱敏预览,再决定。凭证按类别分别处理,协议契约见 [docs/remote-provider-sync-contract.md](docs/remote-provider-sync-contract.md)
- **键盘快捷键可以重绑**。新增 `SHORTCUT_REGISTRY` 集中持有系统里所有快捷键,设置页里改。带冲突检测 —— 跨固定命令和重叠作用域一起算,所以两个作用域不可能同时获得焦点时允许共用一个键位(聊天和终端都保留 `⌘⇧C`)。终端相关的 `Ctrl+C` 这类固定键位不可改
- **终端抽屉高度可拖**。顶边调整器,支持键盘操作,高度存进 localStorage
- **重启提示统一成一个全局 toast**。此前 models / settings / plugins / skills / store / mcp 六个页面各自挂一份重启提示,现在收敛到 `RestartPiToast` 一个组件
- **插件页支持全局与项目两种安装范围**

### Fixed
- **删除会话现在也删 pi 的 transcript** —— 此前只删了 Desktop 那一半。`chat_session_delete` 全文就一句 `DELETE`,删除路径上没有任何一条通向文件系统,于是 pi 的 `.jsonl` 原地留着:Desktop 报已删除、CLI 仍然列出来,而且这些孤儿没有任何东西能回收。实测单个项目 88 份 transcript 共 97.2 MB,其中只有 8 份还被某一行引用
  - 一个会话的磁盘足迹是**两样东西** —— transcript 加一个同名的兄弟目录(子 agent 的运行记录),后者是孤儿体积的大头。`subagent-artifacts/` 在同一层但是整个 slug 共享的,刻意够不到:它不是任何 transcript 的 stem
  - 用回收站而不是 unlink(`~/.pi/agent/session-trash/<slug>/`),因为任何已有安装第一次用到这个功能都是清理上面那批积压。时间戳前缀是**探测**过冲突的而不是直接信任:毫秒精度意味着同一毫秒内删两个同名文件会让两次 rename 指向同一路径、第二次静默覆盖第一次 —— 在一个存在意义就是让删除可撤销的目录里丢掉一份 transcript。transcript 和它的运行目录共用一个前缀,这样恢复时还能配对
  - **先删索引行,后移文件。** 反过来才是危险的:文件被移走而行还在,下次 `--session` 恢复会在那个路径新建**空** session,于是一个用户从未被告知成功的删除,反而静默吃掉了会话。当前顺序最坏只留一个孤儿 —— 正是这之前每次删除已经留下的状态。删行失败则中止,移文件失败被吞掉
  - 范围:仅本地会话。SSH 会话的 transcript 在对端主机,而 launcher 完全没有文件操作,要够到它需要新模式加协议 bump,所以那些文件留在远端 pi 仍能恢复的地方。这**没有**让 JSONL 成为会话内容的事实源 —— Desktop 之外创建的会话依然对侧边栏不可见,那是同一份报告更大的另一半
- **过期的 session pin 能覆盖 transcript**。`--session <path>` 不是只读恢复:文件缺失或为空时 pi 会**在那个路径新建** session。同一个数据库里有四行 pin 着已经不存在的文件。`is_resumable` 现在把这一步拦住,改为开新会话,随后的 `session` 通告会重新 pin 那一行 —— 过期条目自愈而不是被继续利用
- **被拒收的消息此前被报成"任务执行出错"**。pi 只在 `prompt` 的前置检查阶段抛错(`preflightResult` 决定成功/错误输出,`_runAgentPrompt` 只在它报成功之后才被 await),所以那一轮从未开始、文本也从未送达。"任务执行过程中出现错误,已停止"描述的是一次没发生的运行,还藏起了"这条消息仍然需要重发"这个事实 —— 现在是 `agent.promptRefused`
- **本地 streaming 镜像过期时消息会被丢掉**。`send` 和 `retryLast` 都以本地 `streaming` 为闸,但这个镜像会被 pi 不认为终止的路径清掉:`abort()` 在 pi 还在收尾 bash 子进程时就乐观清除,`appendAssistantError` 在模型报错(而 pi 随后要压缩)时清除,`load()` 在接回一个正在跑的 detached 任务时清除。这三个窗口里 pi 自己的 `isStreaming` 仍是 true,裸 `prompt` 会被"Agent is already processing"拒掉。现在传 `streamingBehavior: "followUp"` 让 pi 排队,最坏情况是消息等一会儿而不是消失。用 `followUp` 而不是 `steer`:用户是以为 agent 空闲才打的这条,所以它是一个迟到的新回合,不是对一个他们根本不知道在跑的回合的纠偏
- **接回 detached 任务时输入框不解锁**。助手内容本身就是"有一轮在跑"的证据,而它并不总是先有一个我们看见过的 `agent_start` —— 接回时那一轮开始于 attach 游标之前,所以内容是唯一证据。`ensureAssistant` 现在同时置上 store 级的 `streaming`

### Internal
- 桌面适配器命令清单:**90** 个唯一命令(0.10.0 是 67)
- `chat_sessions` schema 1 → 2(`execution_binding`),带迁移
- 会话文件的规则放在 `pi-backend-core::session_files` 而不是 `src-tauri` —— 后者的测试二进制**跑不起来**:`[lib] crate-type` 含 `cdylib`,测试进程在任何测试体之前就以 `STATUS_ENTRYPOINT_NOT_FOUND`(`0xc0000139`)载入失败。`src-tauri/src/pi_sessions.rs` 因此只负责解析本机那两个目录是哪两个
- 新增远程 agent 验收工具与实测记录(10 个可重复场景,含一次真实模型回合)。网络分区场景只封一个由持有本次运行的 sshd 会话推导出的对端端口,并装一条自删除规则,所以工具不会遗留规则也不会把自己锁在外面
- 五份新文档:[V2 supervisor 协议](docs/remote-agent-v2-supervisor-protocol.md)、[V2 会话恢复](docs/remote-agent-v2-session-recovery.md)、[V2 workspace 重构](docs/remote-agent-v2-workspace-refactor.md)、[V1 验收](docs/remote-agent-v1-acceptance.md)、[provider 同步契约](docs/remote-provider-sync-contract.md)
- 清掉两个 changeset 残留文件(`skills-install`、`terminal-clipboard`),内容已随 0.10.0 发布
- 后端套件 265 pass。3 个先前就存在的失败依旧 —— browser-mock 扩展 UI、chat-recovery resumePath(60 秒超时)、mcp-import OAuth fixture

## [0.10.0] — 2026-08-30

### Added
- **技能页面能装了** —— 此前它只能读:`useSkills.scan()` 走一遍 pi 的三个技能目录、解析每份 `SKILL.md` 的 frontmatter,于是页面能列、能搜、能预览,然后就到此为止。想把一个技能弄到磁盘上得离开应用开终端,还得自己记住哪个目录对应"到处可用"、哪个对应"只这个项目"
  - 驱动它的是 `npx skills`([vercel-labs/skills](https://github.com/vercel-labs/skills))。那个 CLI 本来就把 pi 当一等公民(`--agent pi`),全局写 `~/.pi/agent/skills`、项目写 `<root>/.pi/skills` —— 正是扫描器已经在读的那两个目录,所以装完重扫一次就落进现有的全局/项目分组,没有新的第三种状态
  - **一个输入框,两条路进去**。打名字,skills.sh 目录边打边答;贴一个地方 —— `owner/repo`、git 或下载链接、本地路径 —— 旁边长出「列出」按钮去枚举它。走哪条按文本里有没有分隔符(`/ \ : . ~`)判定:裸词不可能是来源,而一个名字不该触发二十秒的 clone
  - 报一个技能名是常见情况,而且它**真的有歧义**:`ui-ux-pro-max` 存在于九个互不相关的仓库里,所以答案必须是一个可选的列表,不能是一次猜测。结果按"名字精确匹配优先、再按安装量"排 —— 不这么排的话,某一个仓库里安装量更高的兄弟技能(`ckm:design-system`,32K)会盖住另外八个真正在发你打的那个名字的仓库
  - **哪一行算已装,按来源判定而不是按名字**。磁盘上的东西不记来源(`SKILL.md` 只有 name 和 description),但 CLI 的 lock 文件记(`~/.agents/.skill-lock.json`,项目是 `<root>/skills-lock.json`),所以 `parseLock` 现在报每条的 `source` —— 和目录接口返回的是同一个 `owner/repo` 身份,旧条目只有 `sourceUrl` 时归约成它。只有来源也对上才打「已安装」徽章
  - 另外八行不是简单的"未安装":同名只能存在一份,装它们中任何一个都会替换掉现在那份。那些行保留安装按钮,并加一个「会替换」徽章把后果说出来
  - **卸载 / 更新 / 在全局与项目之间搬移**,都在展开的技能行里。搬移是"从 lock 记录的来源重装、再删掉旧的那份" —— `skills update` 内部就是这两步。直接拷目录会让目标 scope 的 lock 是空的,从而悄悄把这个技能排除在未来的更新之外,所以这个动作只在存在 lock 条目时提供
  - 安装传 `--copy`。CLI 默认是往一个规范的 `~/.agents/skills` 建符号链接,而 Windows junction 没法跟着项目的 `.pi/skills/` 一起提交 —— 上游本来就打算让那个目录进版本库
- **终端能复制粘贴了,有右键菜单,`clear` 也真的清屏** —— 此前终端抽屉**完全没有复制**。xterm 故意不带剪贴板绑定(`Ctrl-C` 是 shell 的中断,修饰键还意味着什么由嵌入方决定),而没有任何东西绑过它们,于是唯一的出路是块视图里每块自己的复制按钮。右键也顶不上:`AppShell` 为了让自定义菜单存在而全局取消了 `contextmenu`,这连带把 WebView2 自己的复制/粘贴项也拿掉了,而终端从来没拿到替代品
  - **复制**:`Ctrl/Cmd+Shift+C` 总是复制选区;裸 `Ctrl-C` 只在有选区时复制,否则照常作为 SIGINT 抵达 shell —— Windows Terminal 就是这么拆同一个键的。复制后清掉选区:留着会让**下一次** `Ctrl-C` 又去复制而不是中断,于是一个过期的选区能让正在跑的命令杀不掉。macOS 上 `mod` 是 Cmd,所以那边 `Ctrl-C` 始终是中断
  - **粘贴,原生优先**。裸 `Ctrl/Cmd+V` 故意**不** `preventDefault`。webview 自己的 paste 事件不要任何授权,而 `navigator.clipboard.readText()` 会弹窗 —— 且一次"阻止"会被永久记住,所以为了读剪贴板而取消原生事件,等于把一个永久性的失败放在一次误点之外。`armPasteFallback` 等 150ms,只在原生事件没来时才去读剪贴板;事件会取消定时器,所以两条路加起来恰好粘贴一次。`Ctrl/Cmd+Shift+V` 和菜单项是显式路径,那里读剪贴板是唯一选择、弹窗也是预期的
  - **粘贴不是一次按键**,这是此前它半坏的根源:xterm 把整段粘贴作为**一个**多字符字符串交给 `onData`,换行已经折成 CR,而两个视图都只按单次击键处理它。经典模式的 `switch` 拿整个 payload 去和 `"\r"` 比,于是两行粘贴永远匹配不到回车、连着内嵌的 CR 一起掉进可打印分支被原样回显,显示自己覆盖自己;以换行开头的粘贴过不了 `data >= " "` 直接消失;命令正在跑时到达的粘贴被丢掉。块模式则让 `<input type="text">` 干它对换行一贯干的事 —— 剥掉,于是 `cd foo` + `echo bar` 静默变成 `cd fooecho bar`
  - `splitPastedLines`([src/lib/terminal-paste.ts](src/lib/terminal-paste.ts))现在为两个视图共同持有多行规则:以换行结尾的行是命令,最后一个换行之后的尾巴留在行编辑器里可改 —— 所以没有结尾换行的粘贴是落进输入行而不是盲跑。经典模式把余下的行按 typeahead 存着、每条命令跑完再回放一条,和真实终端排队粘贴行的方式一样;`Ctrl-C` 丢弃队列,因为"按了中断、然后看着一段被放弃的粘贴继续跑"和这个键的用途正好相反
  - **右键菜单** —— 复制 / 粘贴 / 全选 / 清屏。经 portal 渲染:抽屉用 `overflow: hidden` 动画自己的高度,而 Motion 的 transform 让它成为 containing block,所以就地渲染的 fixed 定位菜单会被它所属的那个抽屉裁掉
  - **`clear` 此前不可能生效**,三个独立的原因:每条命令是一次单独的 `bash` RPC,输出是被**捕获**的而不是写进活的 PTY,所以转义序列是作为响应体里的文本到达、对面没有终端;pi 的 shell 没有设 `TERM`,而 `clear` 要读 terminfo 才知道该吐什么,于是它在打印任何东西之前就失败了;块模式经 `ansi_up` 渲染,那个库实现 SGR、忽略其他所有 CSI 码 —— 擦除和光标指令都在内 —— 所以即使收到了也做不了。现在 `clear`(以及 `cls`,Windows 用户会打、且同样不会更好)和 `Ctrl-L` 都在前端应答:块模式清空块列表,经典模式发 `\x1b[3J\x1b[2J\x1b[H`。`3J` 是关键 —— 没有它"清掉"的回滚缓冲一个滚轮就回来了。同时调 `termBus.reset()` 丢掉 backlog,因为总线会把它回放给迟到的订阅者,清屏之后才挂载的终端否则会把清掉的东西恢复出来

### Fixed
- **符号链接安装的技能在页面上全部不可见** —— `fs_list_dir` 用 `DirEntry::file_type()` 判断 `isDir`,而它描述的是链接本身而不是链接的目标,于是一个指向目录的 Windows junction 或 Unix 符号链接被报成既不是文件也不是目录。而符号链接正是 Skills CLI 的**默认**安装方式,所以用户此前从终端装的每一个技能在这个页面上都是隐形的。现在跟随链接判断,文件树顺带白拿同一个修复
- **"已思考"行下方约 24px 的空白** —— pi 常规地用一个裸 `"\n\n"` 文本块给纯思考消息收尾,于是 `m.text` 是 truthy 而 Streamdown 从它渲染出一个空容器。那一行不是免费的:它还放着 `⋮` 菜单 —— 一个 hover 前 opacity 为 0 的 24px 按钮,行高由它决定。新增 `hasText()`,所有"这条消息有没有文本"的判断统一走它。只有判断用 trim 后的值,渲染和复制仍用原始文本 —— trim 会把开头的四空格缩进(一个缩进代码块)变成普通段落
- **通知预览显示成空白** —— 同一个裸 `"\n\n"`:会话标题预览此前直接截前 60 字符,现在先 trim 再截

### Internal
- 新增两个 Tauri 命令。`skills_cli`([src-tauri/src/skills_cli.rs](src-tauri/src/skills_cli.rs))对齐 `pi_cli`:子命令白名单(`add` / `remove` / `update` / `list`)、stdin 置空、Windows 上不弹控制台窗口。它优先用全局安装的 `skills` 可执行文件,否则回落到 `npx -y skills@latest`,两者都经 `pi_command::resolve_executable` 解析以便找到 npm 的 `.cmd` shim。因为首次 npx 下载加一次来源 clone 会跑到几十秒,它是 `async` 配 `spawn_blocking` 而不是同步命令
- `skills_search` 走 Rust 而不是渲染进程。`https://skills.sh/api/search`(CLI 自己的 `find` 用的匿名端点;文档化的 `/api/v1/*` 要 Vercel OIDC bearer token,直接 401)**一个 `Access-Control-Allow-Origin` 都不发,**所以从 webview 发 `fetch` 会在读到响应之前被 CORS 拦掉、只冒出一个 `TypeError: Failed to fetch` —— 那看起来和网络不通一模一样,也正是为什么商店页 fetch `registry.npmjs.org` 没事而这个不行(npm 发 `ACAO: *`)。原生客户端没有同源规则,能拿到真实错误和超时,并且会读用户的代理(`HTTP(S)_PROXY`,Windows 上还有 Internet Settings 注册表键)
- **CLI 的失败原因此前被 npm 的警告顶掉**。Skills CLI 经 clack 打日志,写的是 **stdout** —— 失败原因也在那里;stderr 通常只有 npm 关于用户 `.npmrc` 里某个配置键的警告。报 `stderr || stdout` 于是显示噪音、藏起原因。`cliError` 现在两个流都读,滤掉 npm 闲话、clack 的边框字符、spinner 帧,以及只重复"失败了"的收尾行,保留最后几行有信息量的;子进程上的 `npm_config_loglevel=error` 从源头掐掉那条警告
- 桌面适配器命令清单:67 个唯一命令(此前 65)
- 后端套件 121 pass。3 个先前就存在的失败依旧 —— browser-mock 扩展 UI、session-pin resumePath、mcp-import OAuth fixture;这些测试和它们 import 的源码自 0.9.0 起没有改动过

## [0.9.2] — 2026-08-28

### Added
- **文件检查器 —— 点 transcript 里的文件行，文件就停靠在对话旁边**（`Read` / `Edit` 行整行可点）。此前一个 turn 改了四个文件，你唯一的去处是编辑器，而编辑器会被 agent 拖着走
  - 它显示的是那次编辑的 **diff**，不是编辑之后的文件。"刚才那下改了什么"此前答不上来：bridge 为了在编辑器里高亮改动行，本来就会在编辑工具跑之前快照文件、跑完再读一遍，但那份快照在工具结束的那一刻就被丢掉了 —— 于是一行可以报出 `+12 −3`，却没有任何办法说出是哪十二行。现在同一对 pre/post 变成 unified diff 的 hunk，存到一个"几秒甚至几分钟后才打开的面板"仍读得到的地方
  - **可以钉住**。`follow` 是这个 store 存在的理由：不钉的话 agent 会把视图拽到它那一瞬间正在写的文件上（这正是 bridge 一直以来的行为），于是"一边读 A 文件的第 200 行、一边看着一个 turn 改另外四个文件"是不可能的。跟随仍是默认 —— 你在看工作发生时那才是对的 —— 但你一旦自己打开了什么，它就钉住、开始数错过了几次、并给一条回去的路（`N 个新改动` / `回到最新`）
  - 点一个**正在跑**的编辑行不会让面板自我矛盾：如果 agent 写的就是你屏幕上这个文件，改动落进你正在看的那个 tab，而不是被计成"你错过的"。视图也不动 —— 你为了读上下文切到了源码视图，这个选择不该被一次写入抹掉
  - tab 上限 6 个、LRU 淘汰。无上限的 tab 条就是一次重构变成四十个没人看的标签；关掉当前 tab 时回落到**最近**的邻居而不是第一个（条是按最旧在前排的，index 0 是最陈的那个）
  - 面板关着的时候 agent 的编辑只记下目标、不往里塞 tab。把没人要求看的文件填进 tab 条，是 tab 条不再表示"我打开过什么"的开始
  - `Read` 行渲染的是文件**现在**在磁盘上的样子，不一定是 agent 当时读到的内容 —— 面板会直说这件事（`inspector.staleRead`）
  - hunk 之间的未改动行折叠成 `⋯ 展开 14 行 ⋯`，gap 数在建 hunk 时就算好了，展开不重算任何东西
  - **故意不做语法高亮**。在 400px 宽的列里，语法色叠在 diff 底色上是两套配色系统在打架 —— 底色和行号槽才是回答"改了什么"的东西，而那是这个面板存在的唯一理由。要认真读的时候编辑器只有一次点击的距离
  - 单次编辑保留 400 行 diff、总共留 200 条。stat 可以永久留着（三个整数），hunk 列表不行，所以这边会淘汰；面板找不到 diff 时回落到显示文件当前内容，这是诚实的降级
- **编辑行的行数徽章 `▪▪▪▫▫ +12 −3`**，在写入落地的那一刻从 0 弹上来
  - 数字来自**真正的 Myers diff**（新依赖 `fast-myers-diff`）。只做前后缀裁剪对**单处**连续编辑是精确的，但对散开的编辑会疯狂高报 —— 400 行文件里散落的三行改动会读成 ±400。错的数字比没有数字更糟
  - 三个来源，按优先级：工具自己报的指标（`pi-hashline-edit-pro` 这类扩展编辑器本来就返回精确值，最权威）→ 磁盘前后快照对比 → 工具参数解析
  - 2000 行以内精确。Myers 是 O(ND)，全量重写在这个行数上要花约 55ms UI 线程时间、6k 行要约 500ms；超过就整块上报并渲染成 `~` 而不是假装精确 —— 而能把你带到那儿的整文件重写，本来也就是一整块。这个阈值 diff-stat 和 file-diffs 共用，否则会出现"徽章写着 `~`、旁边面板却渲染出一份自信的逐行 diff"这种一个问题两个答案
  - 到达动画只在写入后 1500ms 内算"正在到达"。transcript 行是虚拟化的，徽章每次滚回视野都会重挂载 —— 没有这个时间窗，一次性的点缀会变成每次扫过都重播的抽动
- **HTML 预览** —— 编辑/写入工具的目标是 `.html` 时，写入落地后那一行长出「在浏览器中打开」。新增 `open_html_preview` 后端命令；判定放在 `html-preview.ts` 而不是组件里，好让 transcript 恢复路径（历史里有 args 但没有活的 bridge）和测试共用同一份"什么算可预览"的定义
- **对话为空时的欢迎界面** —— 居中的 `PiMark` 加一行标题，取代此前那句空状态文案。撤场用 spring 下落过渡，`useReducedMotion` 打开时换成瞬时版本

### Changed
- **工具类型图标换成 `@appica/icons-react`** —— 9 种工具（read / write / bash / search / web / task / agent / mcp / other）不再走 lucide。注意导入形状：图标是 package root 上的具名导出，**没有 per-icon 子路径**，跟 `@appica/ui-react` 正好相反 —— AGENTS.md 里那条 subpath 规则不适用于图标包，写成 `@appica/icons-react/file-text` 解析不到任何东西
  - 这套字形是按 1.5 笔画画的，但在这一行用的 13px 下等效只有约 0.8 设备像素，抗锯齿之后淡到读不出来。行内统一渲染成 1.75，同排 trailing 槽里的 lucide 图标（`ExternalLink` / `AlertTriangle` / `Check`）也钉到同一个值 —— 否则同一行里会出现 1.5 和 2.0 两种笔画
- **字体栈按平台重排** —— Apple 字面打头（这是个 iOS 风格的外壳，在 Mac 上就该长这样），Windows 补上 `Segoe UI Variable`（Win11 自己的 UI 字面，且是真正的可变字体）并保留 `Segoe UI` 作为 Win10 回退。CJK 是单独一跳：没有任何 Segoe 字面带汉字glyph，而 PingFang 只在 Mac 上有。Emoji 放在泛型字体**之后** —— 逐字符回退会保证它照样生效，放前面则会让它抢走本该由 UI 字面渲染的字符
- **工作模式的阅读宽度限制挪到行上**（`.sd-measure`）而不是面板上。限制面板本身会连带压掉它的背景和分隔线
- **有停靠列时左边框保留为面板间的分隔线**，而不是当作窗口边缘线抹掉

### Fixed
- **后端测试套件从来没跑过** —— `tsc` 先失败，于是 `test:backend` 在 `node --test` 之前就退出了，85 个测试**零个**执行。三个互不相关的原因藏在同一堵报错墙后面
  - `tests/backend/tsconfig.json` 用经典 `Node` 解析，读不了 package.json 的 `exports`。`@pi/remote-control-contracts` 是 workspace 符号链接，类型只能那样触达，于是 `src/lib/backend` 下五个文件解析不到它。这份配置需要的 CommonJS 输出又排除了 `node16`/`bundler`，所以改为把 `paths` 指向源码 —— 每个 importer 都是 `import type`，什么都不会进到 emit
  - `composition` 和 `runtime-store` 手搓了完整的 `BackendPorts`，缺 `remoteControl` / `remoteConversations`。补的是一个"不可达端口"stub，而不是 `as unknown as BackendPorts`：那个 cast 会关掉正是让这些 fake 值得一写的检查，而一个看起来合理的 stub（`list: async () => []`）会让未来的测试对着一个什么都证明不了的 fake 通过
  - `assertNextRemoteEventSequence` 被 import 但根本不存在。补在 `events.ts` 里紧挨 `EventSequence`，跟着这个包的 `assert*` / `can*` 分工。它比 `reduceRemoteConversationState` **故意更严格** —— 后者会丢掉 `lastSequence` 及以下的事件，因为投递是 at-least-once
  - 修完上面这些又露出一个被 tsc 报错一直挡着的 bug：`rewriteAliases` 每层递归都从 `dir` 重算 `srcRoot`，深一点就变成 `<dir>/src`，于是在 `src/lib/pi/` 里面 `@/lib/workspace` 被重写成 `./src/lib/workspace`。emit 此前从未被执行过，所以它从未显形
- **"锁定"类测试全部过期** —— 这些测试把源码当文本读、对顺序做断言，所以它们描述的代码一被重构就失效了；而套件本身编译不过，没有任何东西提示这件事。五处失败，**没有一个是回归**，下面每个标记在 0.9.0 就已经不存在了
  - Esc 不是 capture 阶段，也不是正向测试。0.8.0 去掉了全局 `capture: true`，因为 Esc 属于当前聚焦的输入框；handler 除非有 subagent 被聚焦否则直接早退
  - `useChat.getState().init()` 已经不在启动链里
  - 有一处 shell 级的 `connect({ cwd, resumePath })` 假设只有一个 pi 进程。现在每个对话各起一个、带自己保存的 `--session` 路径，所以恢复归 `sessions.init()` 管，根目录是就地读的而不是被提到外面
  - 宠物自启在 idle 回调之前就把 `petId` 从 prefs 里解构出来了，所以调用读的是 `petId`；配置更新发生在显形之前
  - close 监听器挪到了 `closeBehavior` 判断后面、进了自己的 effect，所以它有了自己的测试:quit 模式下**不能有任何** JS 监听器 —— 渲染进程卡死时它会在 Rust 看到 `ExitRequested` 之前把原生关闭挡下来
  - `command-inventory`:`pet_window_prewarm` 从宠物功能落地起就一直被调用，却从没进过期望列表，所以真实的唯一命令数早就是 63 而不是断言里的 62。加上 `app_quit` 之后是 64
  - `check-backend-boundaries`:`typeof window` 只有在它代替"我是不是在 Tauri 里"这个问题时才算平台猜测 —— 而那个问题属于 ports。跟 `"undefined"` 比较时它问的是"DOM 存在了吗"，那是核心 store **必须**处理的：这个应用是静态导出，它们会在 prerender 期间于 Node 里求值。把这个写法整体禁掉会让规则对 SSR-safe 的代码不可满足，留下的是一条常驻违规而不是一个信号,所以只匹配裸形式。已验证它对真正的探测仍然会触发（`typeof window.__TAURI_INTERNALS__` 同时踩中两个标记）
- **`app_quit` 改走 `desktopInvoke`** —— quit 端口此前直接调 `@tauri-apps/api/core` 的 `invoke`，是 `src/lib/backend/desktop` 里唯一的裸 invoke。别的命令都走 `desktopInvoke`，它会把失败归一化成带分类 kind 的 `DesktopInvokeError` —— 所以一次被 capability 列表拒绝、或撞上命令不存在的 quit，此前是以一个裸 Tauri 字符串的形式冒出来的。它也让这个命令对 `check-backend-boundaries.mjs` 不可见（那个脚本数的是 `desktopInvoke` 调用点）:`app_quit` 在应用里是活的，却不在清单上
- **HTML 预览被 URL 打开器的安全检查挡住** —— `openExternal` 的 http(s) 白名单同时也拦掉了 `file://`。安全检查移到调用方：`openHtmlFile` 走自己的端口，桌面端拒绝非 HTML 目标，因此失败时**没有** web 回退（从 dev 网页打开的 `file://` URL 本来就被浏览器拦着）。拒绝会被记进日志而不是丢掉 —— 这个按钮的全部失败模式就是"看起来坏了"：文件没了、或者命令拒绝了这个路径，而一个被吞掉的错误留下的是一次什么都没发生也什么都不说的点击
- **扩展状态文本里的 ANSI 转义序列显示成原始字符** —— 为终端写的扩展会带 TTY 转义，未处理的 `setStatus` 会把它们当字面 glyph 打出来。选择剥掉而不是渲染:终端界面用的 `ansi_up` 在那里是对的，但状态文本不是终端。也没有引入 `strip-ansi` 包 —— 它不在依赖树里，而且它也覆盖不了这里要处理的全部序列。正则用 `\x` 转义写成，因为字面的 ESC / BEL 字节在编辑器里是看不见的

### Internal
- **shiki 精简到 34 种语言** —— `@streamdown/code`（唯一的 importer）在模块作用域用 `Object.keys()` 读 `bundledLanguages` 和 `bundledLanguagesInfo`，所以 shiki 的 barrel 抗 tree-shaking，会把 332 个语言条目加 65 个主题拖进依赖图并真的产出 chunk。`next.config.ts` 里用 `shiki$` 别名指向 `src/lib/shiki-slim.ts`；`$` 把别名锚定在精确请求上，`shiki/engine/javascript`、`shiki/wasm` 这些子路径必须继续解析到真包。**这是 chunk 数量和体积的收益，不是内存收益**
- `@appica/icons-react` 进了 `experimental.optimizePackageImports` —— 4997 个图标全是单个 root barrel 上的具名导出，没有子路径可以绕，不加这条 dev 构建每次改动都要解析整个 barrel。lucide-react 已经在 Next 内置的列表里，这个包不在。生产 tree-shaking 本身没问题（`sideEffects: false`、纯 re-export barrel、没有顶层求值 —— 跟上面 shiki 的情况不同）
- 新依赖:`fast-myers-diff`（行数统计与 hunk 构建）、`@appica/icons-react`
- 已知遗留:后端套件里有 3 个先前就存在的失败 —— `mock-pi-process` broken pipe、`session-pin` resumePath undefined、`mcp-import` OAuth fixture。这些测试和它们 import 的源码自 0.9.0 起都没有改动过，需要各自单独排查

## [0.9.1] — 2026-08-27

### Added
- **可选的启动布局，含一个没有编辑器的纯对话模式**（设置 › 常规 › 布局）— 此前进入对话列只能每次启动后按一次 ⌘/，这个选择从不持久化。把 Pi 当 Agent 客户端而不是编辑器用的人，每次开机都要重新进一次自己要的布局
  - 三种布局存为**一个** `layoutMode` 枚举（`default` / `work` / `work-only`），不是"启动偏好 + 一个独立的启用 IDE 开关"。那两个不正交 —— 关掉编辑器**就是**永久对话模式 —— 作为两个独立持久化的值会允许一个用户能选中但毫无意义的状态：编辑器关闭 + 启动界面选"编辑器"
  - 但一个三段控件也表达不了它们。`work` 与 `work-only` 的差别不是对话的纯度，是**能不能离开** —— 而"对话"紧挨着"纯对话"读起来像是在说对话列本身的区别，并不是。所以设置页是**一个存储值、两个控件**：`启动界面 [编辑器│对话]`，加一个 `移除编辑器` 开关；开关打开时上面那个 Segmented 置灰。一个控件一个问题（*我开机想看到哪个* / *我压根要不要它*），那个死组合是可见地禁用而不是可选但无效
  - 关掉开关时回到 `work` 而不是 `default`：你本来就在对话列里，拿回编辑器不该顺手把你踢出对话
  - 选中即生效，不是只等下次启动 —— 一个看起来什么都没做的设置控件会被当成坏了
  - 面板改为等存储读回来（`layoutReady`）才挂载，所以以对话布局启动时不会先建一遍编辑器再拆掉。开机屏刚好遮住这一帧：它在 mount 后两个 rAF 才揭开，而布局是在第一个 rAF 之内同步读回的
  - `work-only` 下编辑器不加载，且切回它的每一个入口都隐藏（顶栏按钮、⌘/、命令面板条目）。Agent 仍可正常读取、修改和执行项目里的一切 —— 这个开关只关掉手动编辑那一面
  - 需要说明的是：**"不挂载 CodeMirror"此前就已成立**。`EditorCanvas` 一直是 `ssr: false` 懒加载（~490KB，不阻塞首屏），而对话模式下 `showEditor` 一直是 `false`。所以这个开关省不下 bundle 或挂载开销，它买到的是更简单的窗口和不会误触回 IDE
  - 由 [#1](https://github.com/MarshallEriksen-Neura/pi-agent-desktop/issues/1) 提出，[#2](https://github.com/MarshallEriksen-Neura/pi-agent-desktop/pull/2) 首次实现（感谢 @Luxciax）

### Fixed
- **关闭窗口会挂住，而后端清理又可能被中途掐断** — 清理跑在事件循环线程上，也就是那个还要把窗口画成关闭状态的线程；清理包含远程控制的等待和子进程 join，所以窗口可能一直停在屏幕上不响应。现在清理跑在自己的线程上、外面套 `prevent_exit`，并由 8 秒看门狗兜底
  - `closeBehavior: "quit"` 时**完全不注册** WebView close 监听器。只有 ask / minimize 需要它（那两种要做决定）。注册了 JS 监听器就等于把渲染进程放到关闭路径上，渲染进程卡死时会在 Rust 看到 `ExitRequested` 之前就把原生关闭挡下来
  - 前端 `quit()` 改走新的 `app_quit` 命令，不再用 `@tauri-apps/plugin-process` 的 `exit()` —— 后者会直接终止，上面这些一个都不跑
  - 只 hold 住**第一个**退出请求是不够的：`AppHandle::exit` 会无视 `prevent_exit`，所以清理在飞时任何走到 `exit` 的请求（托盘退出、第二次 Alt+F4）都会带着还活着的 pi 子进程把进程杀掉。`BackendLifecycle` 新增 `cleanup_settled`，每一个退出请求都 hold 到清理结束或看门狗放弃，重复的退出动作直接丢弃而不是转发（竞态由 CodeRabbit 在 #2 上发现）
- **聊天栏的 History 按钮在半数布局里是个死键** — 它 toggle `sidebarOpen`，而对话与 zen 布局根本渲染不出侧栏，于是它翻转了一个没人读的标志位。改成就地列出会话的菜单，并且只在侧栏真的能出现的布局里才提供"在侧栏中查看全部"
- **顶栏的侧栏按钮同理** — 此前无条件显示，现在跟侧栏本身同一条判断
- **`work-only` 下文件树会伪装成成功** — 它的主操作 `openFile` 读盘、把整份内容塞进 `docs` 缓存、`setActiveFile`，而这两个状态的唯一消费者是 `EditorCanvas`，那个布局下不挂载。点一个文件 = 花掉一次读盘、那一行高亮成"已选中"、屏幕上什么都没有 —— 比按了没反应更糟。整节隐藏，而不是裁剪到"新建/重命名/删除"这些不依赖编辑器的操作上：那恰好是这个布局存在的意义所要交给 Agent 的手工活。`work-only` 的侧栏因此就是会话列表，这也正是它在那个布局下仍然可见的理由
- **`work-only` 下顶栏会给窗口贴一个虚构的文件名** — 那个布局里从没有东西打开过文件，`activeFile` 仍是硬编码的占位默认值，于是顶栏永久显示 `agent.ts`：一个用户碰不到、也可能不在自己项目里的文件。普通对话模式保留这个标签，那里它指的是 ⌘/ 切回去后开着的那个文件
- **命令面板的搜索框画了一道多余的聚焦描边** — 面板本身就是弹层，内嵌的 outline 是框里又一个框

### Changed
- `Segmented` 新增 `disabled`：整个控件降透明度，而不是逐个标签降 —— 滑块自己有对比度，半淡的滑块看着像渲染 bug

### Internal
- 开项目不依赖编辑器，`work-only` 下照旧：`ProjectSwitcher` 在顶栏，⌘K 也带文件夹选择器与最近项目
- `isLayoutMode` 守住从存储读回的值：任何无法识别的内容（旧版本写的键、手改的）回落到 `default`，而不是把应用置于没有分支处理的布局
- 记下一件后续工作 —— 点文件树在输入框插入文件引用而不是打开到编辑器（[#3](https://github.com/MarshallEriksen-Neura/pi-agent-desktop/issues/3)）。做了之后 `work-only` 里的文件树就有正当理由回来。主要障碍是草稿目前是 `AgentPanel` 的局部 `useState` 而不是 store，Sidebar 够不着

## [0.9.0] — 2026-08-27

### Added
- **对话框里的思考等级选择器** — 输入框底栏在模型 chip 旁多了一个思考等级 chip，切换等级不必再去设置页。走的是 pi 的 `set_thinking_level`（当场生效），而不是 settings.json 的 `defaultThinkingLevel` —— 后者会置 `dirtyRestart`、弹出"重启 pi"横幅，而 RPC 已经改好了根本不需要重启
  - **选择会被记住**：写入 localStorage，一个值全局共享。pi 进程本身不记这件事，每个进程都从 settings.json 的默认值起步，所以此前重启应用会掉回默认，新建对话也会（每个对话自带一个 pi 进程）
  - 每个进程连上后**只补一次** RPC 把记住的等级推回去。只补一次是关键：`/thinking` 用的是 pi 自己的 `cycle_thinking_level`，每次 refresh 都推会让切换立刻被弹回。第一次之后改为反向同步 —— pi 说什么就记什么，两边不脱节
  - 优先级是**最后一次明确操作生效**：设置页改默认值时清掉记住的值，否则那个控件会看起来完全失效
  - `high` / `xhigh` / `max` 时 chip 的脑图标转 accent 色，`off` 时整个 chip 转 tertiary —— 不额外加 badge 也能一眼看出加了推理
- **内置工具选择**（设置 › 运行时）— 精确指定 pi 启动时启用哪些内置工具（`defaultTools`）。三种状态是有区别的且都保留：键缺失 = pi 自己的默认，`[]` = 不启用任何内置工具（扩展/SDK 工具不受影响），非空 = 恰好这些。开关管"缺失 vs 存在"，chip 只编辑已存在的列表；打开开关时用**当前生效的**工具集播种，所以打开这个开关本身不会改变行为
- **PowerShell 工具支持** — `powershell` / `pwsh` 归入 shell 家族。这不是图标问题：agent-bridge 只对 `kind === "bash"` 把工具输出送进终端，漏掉的话整个终端输出被静默丢弃。命令提示符按工具区分（`PS>` / `$`），与 pi 自己 TUI 的渲染一致

### Fixed
- **扩展界面全都是死的，阻塞式调用会永久挂住那个 turn** — ext-ui 在启动时用不带 task id 的 `getPiClient()` 订阅。启动时还没有 task id 可绑，而真实 task id 都是 UUID，于是它静默绑到了 `"default"` —— 一个没有任何对话使用的进程。`extension_ui_request` 从未抵达：`setStatus` / `setWidget` 什么都不渲染，而 `select` / `editor` 会让 pi 一直等一个永远不会来的回答。改为模块级的**跨任务事件总线**，订阅者不会漏掉在它之后创建的 client
- **已回答的对话框在屏幕上多留 15 秒，然后报一次失败** — `extension_ui_response` 被 pi 的 stdin 分发器截获：它解析完就唤醒扩展的 promise 并返回，从不走到 `handleCommand`，因此**永远不会**发出 `response`。此前在等这个 ack，于是每一个已被 pi 接受、pi 早已继续跑下去的回答，都要卡满整个请求超时再报错。新增 `write()`：只报告写入本身是否成功，不做响应关联
- **`select` 的自由文本把用户的答案变成了「放弃」** — 那个输入框违反契约：`select` 只能用 `options` 中的一项回答。调用方用 `choices.indexOf(answer)` 回映射，打字的答案落到 `-1`，整个提问被当作 **cancelled** 丢弃 —— 一个认真写下的回答被读成「用户放弃了」。输入框已移除；需要自由文本的扩展本来就有正确做法：提供一个「其它」选项，被选中时再发一个 `editor` 请求（那正是此前选项下方那个输入框的来源 —— 它是第二个请求，不是这一个的一部分）
- **点一下对话框外面等于取消** — 模态请求持有扩展的 turn，而「关闭」能发出的唯一回答是 `cancelled`；对 Plan 模式的提问来说，这意味着 agent 在一个用户从未做出的假设下继续跑。太具破坏性，不该挂在一次落在 transcript 上的误点上：指针关闭已关掉，`Escape` 与显式的 Cancel 按钮保留为深思熟虑的出口
- **管道断掉时，用户的出口反而没有出口** — Cancel 走的是同一条写入路径，写失败时若仍留着 sheet 就把它永久卡死。现在取消类回答即便写入失败也照样关闭；一个**答案**保持原行为（sheet 留下以便重试，而不是静默丢失）
- **下一个提示会继承上一个的草稿** — 队列推进时 sheet 保持挂载，于是新提示带着前一个的文本并忽略自己的 `prefill`。按请求 id 加 key
- **等待用户的琥珀色状态永不消失** — 清除它的监听器订阅的是 `extension_ui_response`，而那个类型属于 `PiCommand`（**我们**写给 stdin 的东西），不是 pi 发出的事件，所以那个回调永远不可能触发，琥珀色只在 turn 结束时才碰巧消失。现在由 sheet 队列派生：条目在 pi 被回答的那一刻移除。宠物窗口的 "waiting" 同理
- **两个并行对话跑同一个扩展会互相覆盖界面** — `setStatus` / `setWidget` 此前按 key 全局存放，共用 `statusKey` 的两个对话互相踩。现在按 taskId 分桶，只渲染聚焦对话的那一份。反过来 `setTitle` 与 `set_editor_text` 只允许聚焦对话驱动 —— 它们的目标是唯一的窗口标题和唯一的输入框，后台对话改窗口标题、或往你正在打字的输入框里粘东西，会是回归
- **进程已消失的对话框一直挂着，挡住后面的提问** — client 被销毁后（切项目、删会话）没人能回答它。销毁时一并清掉该任务的队列条目与界面
- **跨任务排队的提示看不出是谁在问** — 队列现在跨所有对话，屏幕上那个可能属于用户没在看的对话。sheet 标出来源会话名，并提示还有几个在等
- **transcript 里成组出现的莫名空白** — pi 每个 `message_start` 都新开一条 assistant 消息，其中若干条什么都不渲染（工具结果的载体、provider 的 no-op start/end 对）。它们仍各自占一个 Virtuoso 行和自己的垂直 margin，几条连在一起就是两组工具行之间无法解释的死白。新增 `hasRenderableContent` 谓词过滤，同时让入场动画指向最后一条**可见**消息而不是一条看不见的
- **一次回复被 pi 拆开的地方多出一道 16px 接缝** — 一个 turn 会到达成好几条 assistant 消息（先文字、再一批工具调用、再文字）。现在只有第一条付出前导 margin，一串工具行保持单一节奏
- **送出消息后视图不回到底部** — `followOutput` 覆盖不了这件事：它只跟随一个**已经**在底部的视图，而打字恰恰是把视图带离底部的动作 —— 输入框随草稿换行从 2 行长到 12 行，每一行都在压缩上方的滚动区而它的 `scrollTop` 原地不动，几行字就足以把最后一条消息推到折叠线以下；提交后回复被追加进那个缺口并留在那里。现在按最后一条 **user** 消息的 id 显式置底，覆盖所有把 prompt 交给 pi 的路径（输入框、命令面板、zen 模式、steer、follow-up），而回复中途抵达的普通 token 不会把已主动上滑的读者重新拽回去
  - 连续三帧各跳一次，不是跳一次：本次提交只添加气泡，真实行高要等 Virtuoso 量完才落定，而输入框塌回 2 行（它自己的 effect，在草稿被清空后）又会把滚动区撑高 —— 两者都发生在我们本该抵达底部之后
  - `atBottomThreshold` 从默认 4px 抬到 48px：气泡用 margin 撑开自己，而行测量会把它抹掉，于是滚动区可以停在离自己末端几像素的位置、看着停在底部却报 `atBottom: false` —— 一旦如此，上面那条跟随会在本次会话余下时间里静默失效
  - 跟随不再以 `streaming` 为条件：消息也会在一次运行之外抵达（连接错误、排队 follow-up 的回显、切会话时恢复的 transcript），此前它们被追加到折叠线以下且没有任何东西把它们带进视野
- **运行中的命令被画了两遍** — 聊天栏顶部的活动条与 transcript 内的工具行镜像同一条 `tool_execution_*` 流，同一个命令同时出现在滚动区顶部和它本来的位置
- **结构化参数的工具显示 `[object Object]`** — `String()` 会把对象或数组变成那串字符，`plan_mode_question` 于是显示 `questions: [object Object]`，关于问题本身一个字都没有。对象改走 JSON 以便预览带上真实内容；原始类型保持原样（字符串不加引号）
- **第一条消息上方的死带** — 有了 transcript 之后 Virtuoso 的 Header 不再渲染任何东西，但一个空包装仍会把自己的 padding 当作 header 高度交出去

### Changed
- **移除演示用的任务条** — 每个工具调用本就是它所属 assistant 消息里的一行，顶部不需要一块常驻区域重复同一批信息。随之从 store 移除 `AgentTask` / `IDLE_TASKS` / `upsertAgentTask` / `patchAgentTask` / `setTaskStatus`，agent-bridge 不再维护卡片，编辑器演示不再上报任务状态
- 工具行上下 padding 收紧 1px，一列工具调用读起来更紧凑

### Internal
- `client.ts`：`PiClient` 现在带 `taskId`，每个事件都能在总线上被归因到它的任务；新增 `onAnyTaskEvent` / `onPiClientDisposed` / `peekPiClient`（取已存在的 client 而**不**创建 —— 为一个没人在等的回复新起一个 pi 进程，比丢掉这个回复更糟）。`resetPiClientForTests` 刻意不清跨任务订阅：那是注册方自己的所有权，清掉会静默摘掉一个活着的消费者
- `ext-ui.ts`：新增 `useActiveExtStatuses` / `useActiveExtWidgets`，用稳定的空引用兜底 —— 每次渲染返回一个新 `{}` 会让选择器在 store 任何变化时都重渲染这些界面
- `settings-ui.tsx`：新增 `ChipMultiSelect`。刻意**不**像 `StringListEditor` 那样把空选择折叠成 `undefined`：对 `defaultTools` 而言 `[]` 是有意义的值，与「键缺失」不同
- 新增 3 个后端测试覆盖跨任务总线、`peekPiClient` 与销毁通知、`write` 的无 ack 语义；mock 进程的「扩展响应失败」场景强制为 `send` 模式，因为另外两种 ack 失败对这个命令不存在

## [0.8.0] — 2026-08-24

### Added
- **子智能体检查面板** — AI 派遣 subagent 后，可以点开看它此刻在做什么。入口是对话里 subagent 那一行工具调用本身：运行时该行在自己的 detail 槽显示 worker **当前**在跑的工具与已耗时，面板打开时该行带一道 accent 左边框，因此始终能看出面板属于哪一行；再点一次收起
  - 面板是**停靠的一列**，不是浮层。聊天栏本来就是最右一列，浮层会盖住派生这个 subagent 的那段对话，backdrop 还会挡住你回复。它现在是侧栏与聊天栏的同级：同一条 `springPanel`、同一层 `material`、可拖宽且宽度持久化，开合是重排工作区而非遮住它；位置在聊天栏**左侧**，所以对话始终可见可回复
  - 阅读顺序按提问顺序排：**当前动作**（卡顿提示就贴在这个动作旁边，不塞进页脚）→ 任务 → 各步骤（workflow / chain 多 worker 时可点选切换）→ 工具流 → 结果 → 产出文件 → token/费用/轮次放最后。跑完后同一块面板就地显示结果，不需要重新打开任何东西；切换兄弟 step 时只换内容、框架不动
  - 产出文件（`context.md`、child transcript 等）可点击直接在编辑器打开 —— 走 `workspaceFs.readFile`，仓外路径同样能开
  - 前台与后台两种 run 走**同一套渲染**，因为两者的实时字段形状恰好一致（见下）；本地 `agents` 演示也复用这块面板

### Changed
- **移除聊天栏顶部的 subagent 卡片区** — 每个 subagent 由它自己在对话流里的那一行承载，不再需要一块常驻区域重复同一批信息
- **`Esc` 不再全局抢占** — 面板是停靠列而非模态，可能开着好几分钟。原实现是 `capture: true` + `stopPropagation()`，于是在输入框里按 `Esc` 想关 slash 菜单会先把面板关掉。现在光标在输入类元素中时 `Esc` 归输入方

### Fixed
- **会话上下文丢失，以及 transcript 被截断的风险** — `sessionPath` 的钉定（pin）此前每个任务只做一次（`session` 监听被 `if (!sessionPathSynced.has(taskId))` 挡住）。但 pi 在**不带 `--session` 启动**时会转到一个新的 session 文件，`fork` / `clone` 同样如此，因此 SQLite 里那行会一直指向 pi 已经不再写入的文件，下次启动就恢复到这个陈旧文件 —— 即用户看到的「AI 忘了前面聊的」。更严重的是：pi 的 `--session <path>` 在目标文件缺失或为空时会**在该路径新建 session**，也就是把它截断，所以一个陈旧的 pin 还可能毁掉一份 transcript。现在每次 pi 宣告 session 都重新钉定
  - 同时修掉三处相关问题：`connect` 与 `session` 事件会同时触发同步，而重试之间要睡数秒，于是会叠出并发的重试循环（加 `sessionPathSyncing` 互斥）；路径未变是常态（普通 resume 复用同一文件），此前每次宣告都往 SQLite 写一遍；警告 toast 的判据改为「从未成功钉定过」，成功过的任务不再因一次瞬时失败而弹窗
- **后台任务重连会串到别的对话的 session 文件** — 每个对话拥有各自的 pi 进程与各自的 session 文件，而 `getChatRecoveryTarget()` 取的是**当前聚焦**的对话，于是后台任务断线重连会拿到别人的 resume 路径，两个进程指向同一个文件。现在按 `taskId` 解析
- **就地重启 pi 会丢掉当前对话的上下文** — 「设置已应用」「CLI 已更新」这类调用方只传 `cwd`，不传 resume 路径，于是 pi 空载启动并新开一个 session 文件，屏幕上的对话在进行中就静默失去了上下文。现在回退到该任务自己钉定的 session
- **subagent 卡片从来不出现，那一行也点不动** — 桥接监听的是错误的 pi 进程。每个对话跑各自的 `pi --mode rpc` 进程、按 task id 索引，而 store 调的是不带参数的 `getPiClient()`，落到 `DEFAULT_TASK_ID` —— 一个没有任何对话在用的进程。因此 `tool_execution_start` 从未到达，卡片从未创建。现在按 `agent-bridge` 既有写法绑定活动 task 并在切换时补绑，且保留旧绑定（后台对话里派的 subagent 要继续被跟踪）；卡片按 `toolCallId` 索引，共用 store 不会串对话
- **后台 subagent 在 worker 还在跑时就显示「已完成」** — 装的是 `pi-subagents`，不是 pi 参考实现。它的后台模式 fork 完 worker 立刻返回 `details: { asyncDir, runId, results: [] }`，`results` 是**空数组**，于是解析落进降级分支；紧接着 `tool_execution_end` 立即触发（run 本来就是 detached 的），卡片被判 `done`，下一次 `agent_start` 再被清掉 —— 实测一个跑了 369 秒的 `scout`，卡片在几秒内就"成功"了。现在带 `asyncDir` 且 `results` 为空的 payload 被识别为 detached：改为轮询生产方自己的 `<asyncDir>/status.json`（它每几秒重写一次，扩展文档也正是指引 companion UI 读这些产物），且收尾事件不再结算这类卡片
- **前台 run 的内容整体在结束后才出现** — 生产方一直在流式推送（`fireUpdate()` 有 13 个调用点），漏掉的是**读哪个字段**。原本只读 `results[].toolCalls`，那是 `boundStreamedToolCalls()` 的产物：已完成调用的、预渲染成字符串的、截断到最后 N 条的尾巴，不表达"现在在跑什么"。真正为此设计的是 `details.progress[]`（其 `AgentProgress`）——带 `currentTool` / `currentToolArgs` / `currentToolStartedAt`、`recentTools`、`recentOutput`、`toolCount` / `turnCount`、token 拆分与耗时
  - 关键点：`recentTools` 只记录**已返回**的调用（每条带 `endMs`），所以慢调用进行中时它的最后一条是**上一个**工具。现在各处优先取 `currentTool` 并显示这一个调用自己的计时 —— 「刚读完一个文件」与「已经 grep 了 40 秒」得以区分
  - 生产方强加的一处不对称：收尾 result 会丢掉 `progress`（除非调用方要了 `includeProgress`），否则最后一份快照会永远停在 `running`。现在由 tool call 结束定性，并把收尾 payload 合进来取产物路径 —— 那是唯一带 `savedOutputPath` / `transcriptPath` 的一份
- **同步 run 的时间线与结果为空** — 卡片映射读的是 `result.messages`，那是**参考实现**的字段，`pi-subagents` 没有。它给的是 `toolCalls: [{ text, expandedText }]` 与 `finalOutput`。两种形状现在都做特性检测
- **`action: "list" / "status" / "stop"` 产生幽灵 subagent** — `subagent` 一个工具干两件事，管理调用返回 `details: { mode: "management", results: [] }`，被降级分支做成了一张名为 "subagent"、任务为空的卡片。问一句「有哪些 agent」就会在对话里留下一个空 subagent。这类调用现在直接忽略

### Internal
- 新增 `src/lib/pi/async-runs.ts`：`status.json` 的防御式解析与轮询，外加把前台 `progress[]` 映射到同一模型的 `readSyncProgress()`。所有字段特性检测，未知字段忽略（生产方是用户可改的扩展，其文档明确要求前向兼容）；读到半截 JSON 或读不到时返回 `null`，保留上一份好快照而不是清空视图。轮询在窗口隐藏时降频、终态停表、对 15 分钟不再推进的 run 放弃继续问 —— 但**不**据此判定失败，生产方文档明确警告不可从产物缺失推断进程退出
- `ActivityLine` 新增可选 `onClick` / `active` / `trailing` / `ariaLabel`：拥有检查面板的工具调用让整行成为控件（渲染为可聚焦的 role=button），未传 `onClick` 的调用点行为与几何完全不变
- `useUI` 新增 `subagentPanelWidth` 及其 set/persist/reset/init，沿用聊天栏宽度既有约定；面板宽度对聊天栏让步（以聊天栏**下限常量**而非其实时宽度计算，避免两列互相追逐）

---

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

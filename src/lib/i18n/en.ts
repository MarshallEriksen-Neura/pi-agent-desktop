/** English UI strings — the source of truth for message keys. */
export const en = {
  // common
  "common.cancel": "Cancel",
  "common.confirm": "Confirm",
  "common.done": "Done",
  "common.close": "Close",
  "common.loading": "Loading…",

  // nav rail
  "nav.workspace": "Workspace",
  "nav.models": "Models",
  "nav.plugins": "Plugins",
  "nav.skills": "Skills",
  "nav.store": "Store",
  "nav.settings": "Settings",
  "nav.piStatus": "pi: {status}",

  // status words (pi connection + subagent lifecycle)
  "status.ready": "ready",
  "status.running": "running",
  "status.connecting": "connecting",
  "status.disconnected": "disconnected",
  "status.queued": "queued",
  "status.done": "done",
  "status.error": "error",

  // top bar
  "topbar.toggleSidebar": "Toggle sidebar",
  "topbar.updateAvailable": "Update available",
  "topbar.updateAvailableVersion": "Update {version} available",
  "topbar.dismissUpdate": "Not now",
  "topbar.askAnything": "Ask Pi anything…",
  "topbar.toggleTerminal": "Toggle terminal",
  "topbar.toggleTheme": "Toggle theme",
  "topbar.zenMode": "Zen mode",
  "topbar.toggleAgentPanel": "Toggle agent panel",
  "topbar.minimize": "Minimize",
  "topbar.maximize": "Maximize",
  "topbar.restore": "Restore",
  "topbar.close": "Close",

  // zen mode floating input
  "zen.busy": "Pi is working…",
  "zen.idle": "Zen mode · ask Pi to code…",
  "zen.exit": "exit",

  // project switcher
  "project.none": "No project",
  "project.recent": "Recent projects",
  "project.noRecents": "No recent projects yet",
  "project.open": "Open project folder…",
  "project.remove": "Remove from list",
  "project.switching": "Switching…",
  "project.welcomeTitle": "Open a project",
  "project.welcomeBody":
    "Choose a folder — its files show up in the explorer and Pi works inside it.",

  // sidebar
  "sidebar.sessions": "Sessions",
  "sidebar.explorer": "Explorer",
  "sidebar.newSession": "New session",
  "session.untitled": "New chat",
  "session.delete": "Delete session",
  "agent.history": "Session history",
  "agent.newSession": "New session",
  "palette.newSession": "New chat session",

  // agent panel
  "agent.working": "Pi is working",
  "agent.statusLine": "Pi is {status}",
  "agent.emptyAsk": "Ask Pi to code. Type ",
  "agent.emptyOr": " for the streaming-edit showcase, or ",
  "agent.emptyAfter": " for parallel subagents.",
  "agent.composerBusy": "Pi is working… (⏎ to queue)",
  "agent.composerIdle": "Ask Pi to code… ⏎",
  "agent.stop": "Stop",
  "agent.send": "Send",
  "agent.pastedImage": "Pasted image",
  "agent.removeImage": "Remove image",
  "agent.thought": "Thought",
  "agent.thinking": "Thinking…",

  // retry transparency
  "retry.inProgress": "Retrying… (attempt {attempt}/{max})",
  "retry.success": "Retry succeeded after {attempt} attempts",
  "retry.failed": "Retry failed: {reason}",

  // queue
  "queue.badge": "{count} queued",
  "queue.cancel": "Cancel queue",

  // message operations
  "message.copy": "Copy",
  "message.fork": "Fork",

  // composer slash commands
  "slash.builtin": "built-in",
  "cmd.new": "Start a new session",
  "cmd.compact": "Compact the conversation context",
  "cmd.model": "Cycle to the next model",
  "cmd.thinking": "Cycle the thinking level",
  "cmd.demo": "Run the streaming-edit showcase",
  "cmd.agents": "Run the parallel subagents showcase",

  // demo task strip
  "demoTask.read": "Read src/lib/agent.ts",
  "demoTask.reason": "Reason over context",
  "demoTask.edit": "Edit runAgentLoop()",
  "demoTask.test": "Run test suite",

  // subagents
  "subagents.title": "Subagents",
  "subagents.running": "{n} running",
  "subagents.working": "working…",

  // command palette
  "palette.ask": "Ask Pi to implement…",
  "palette.zen": "Toggle Zen mode",
  "palette.theme": "Toggle theme",
  "palette.terminal": "Toggle terminal",
  "palette.cycleModel": "Cycle model",
  "palette.refresh": "Refresh pi state",
  "palette.language": "Switch language (中/EN)",
  "palette.placeholder": "Ask Pi anything, or type a command…",
  "palette.empty": "No matching commands",

  // model picker
  "modelPicker.select": "Select model",
  "modelPicker.choose": "Choose model",
  "modelPicker.none": "No models configured yet.",
  "modelPicker.manage": "Manage models…",

  // editor canvas
  "editor.piEditing": "Pi is editing…",
  "editor.imageLoading": "Loading image…",
  "editor.imageError": "Cannot display this image",
  "editor.imageMockHint": "Image preview is available in the desktop app",

  // terminal drawer
  "terminal.title": "Terminal",
  "terminal.close": "Close terminal",

  // diff review card
  "review.edited": "Pi edited {file}",
  "review.applied": "Applied",
  "review.reverted": "Reverted",
  "review.reject": "Reject",
  "review.accept": "Accept",

  // extension sheet
  "ext.request": "Extension request",

  // settings page
  "settings.title": "Settings",
  "settings.subtitleMock": "Browser preview — edits are in-memory only.",
  "settings.subtitleLive":
    "Edits write straight to pi's settings.json · restart pi to apply",
  "settings.saved": "Settings saved. Restart pi for changes to take effect.",
  "settings.restarting": "Restarting…",
  "settings.restartPi": "Restart pi",
  "settings.language": "Language",
  "settings.languageFooter":
    "Interface language for this app — stored locally, does not affect pi.",
  "settings.scope": "Scope",
  "settings.scopeGlobalFooter": "Global — applies to every project. File: {path}",
  "settings.scopeProjectFooter":
    "Project — overrides global for this workspace (deep-merged). Dimmed rows are inherited from global. File: {path}",
  "settings.problem": "Problem",
  "settings.invalidJson": "settings.json has invalid JSON",
  "settings.modelDefaults": "Model defaults",
  "settings.modelDefaultsFooter":
    "defaultProvider / defaultModel are what pi starts with. Pick a model on the Models page, then set it as default here.",
  "settings.defaultModel": "Default model",
  "settings.defaultModelUnset": "Not set — pi picks the first authenticated provider",
  "settings.useCurrent": "Use current",
  "settings.defaultThinkingLevel": "Default thinking level",
  "settings.appearance": "Appearance & startup",
  "settings.theme": "Theme",
  "settings.quietStartup": "Quiet startup",
  "settings.quietStartupDetail": "Hide pi's startup header",
  "settings.hideThinking": "Hide thinking blocks",
  "settings.hideThinkingDetail": "Don't render model thinking in output",
  "settings.agentBehavior": "Agent behavior",
  "settings.agentBehaviorFooter":
    "Auto-compaction summarizes old context when the window fills. Retry re-attempts transient provider errors.",
  "settings.autoCompaction": "Auto-compaction",
  "settings.autoRetry": "Auto-retry",
  "settings.projectTrust": "Project trust",
  "settings.projectTrustFooter":
    "What pi does with untrusted project-local settings and extensions in non-interactive modes: ask/never ignores them, always loads them. Global setting only.",
  "settings.advanced": "Advanced",
  "settings.advancedFooter":
    "Everything here writes plain JSON — the same file the pi CLI reads. Any keys this UI doesn't cover are preserved untouched.",
  "settings.cacheMissNotices": "Cache-miss notices",
  "settings.cacheMissNoticesDetail":
    "Show transcript notices for significant prompt-cache misses",
  "settings.thinkingBudgets": "Thinking budgets",
  "settings.thinkingBudgetsFooter":
    "Custom token budget per thinking level. Empty = pi's built-in default (shown as placeholder).",
  "settings.customTheme": "Custom theme name",
  "settings.customThemeDetail":
    "A theme from an installed package (e.g. pi-curated-themes). Unknown names fall back to dark.",
  "settings.externalEditor": "External editor",
  "settings.externalEditorDetail":
    "Command for Ctrl+G external editor — include --wait for VS Code. Empty = $VISUAL / $EDITOR.",
  "settings.reserveTokens": "Reserve tokens",
  "settings.reserveTokensDetail": "Tokens reserved for the LLM response",
  "settings.keepRecentTokens": "Keep recent tokens",
  "settings.keepRecentTokensDetail": "Recent tokens kept out of summarization",
  "settings.maxRetries": "Max retries",
  "settings.baseDelayMs": "Base delay (ms)",
  "settings.baseDelayMsDetail": "Exponential backoff base: 2s, 4s, 8s…",
  "settings.providerRetry": "Provider retry (advanced)",
  "settings.providerRetryFooter":
    "SDK-level retry — keep provider max retries at 0 unless explicitly needed; higher values can let the SDK swallow quota errors before pi sees them.",
  "settings.providerTimeoutMs": "Request timeout (ms)",
  "settings.providerTimeoutMsDetail": "Provider/SDK request timeout",
  "settings.providerMaxRetries": "Provider max retries",
  "settings.providerMaxRetriesDetail": "SDK retry attempts — 0 recommended",
  "settings.providerMaxRetryDelayMs": "Max retry delay (ms)",
  "settings.providerMaxRetryDelayMsDetail":
    "Fail fast when a provider requests a longer wait. 0 disables the cap.",
  "settings.sdkDefault": "SDK default",
  "settings.messageDelivery": "Message delivery",
  "settings.messageDeliveryFooter":
    "How queued steering / follow-up messages reach the agent, and the preferred streaming transport.",
  "settings.steeringMode": "Steering messages",
  "settings.followUpMode": "Follow-up messages",
  "settings.transport": "Transport",
  "settings.httpIdleTimeoutMs": "HTTP idle timeout (ms)",
  "settings.websocketConnectTimeoutMs": "WebSocket connect timeout (ms)",
  "settings.zeroDisables": "0 disables",
  "settings.network": "Network",
  "settings.networkFooter":
    "Applied as HTTP_PROXY / HTTPS_PROXY for all pi network traffic. Global setting only.",
  "settings.httpProxy": "HTTP proxy",
  "settings.httpProxyDetail": "Proxy URL, e.g. http://127.0.0.1:7890",
  "settings.images": "Images",
  "settings.imagesFooter": "Controls images pi sends to the LLM.",
  "settings.imagesAutoResize": "Auto-resize images",
  "settings.imagesAutoResizeDetail": "Downscale to 2000×2000 max before sending",
  "settings.imagesBlock": "Block images",
  "settings.imagesBlockDetail": "Never send images to the LLM",
  "settings.branchSummary": "Branch summary",
  "settings.branchSummaryFooter":
    "Summarization when navigating session branches via /tree.",
  "settings.branchSkipPrompt": "Skip summary prompt",
  "settings.branchSkipPromptDetail":
    "Don't ask “Summarize branch?” on /tree navigation (defaults to no summary)",
  "settings.branchReserveTokens": "Reserve tokens",
  "settings.shellSessions": "Shell & sessions",
  "settings.shellSessionsFooter":
    "npm command is stored as an argv array — input is split on whitespace, so paths with spaces need direct JSON editing. Session dir precedence: --session-dir > PI_CODING_AGENT_SESSION_DIR > this setting.",
  "settings.shellPath": "Shell path",
  "settings.shellPathDetail": "Custom shell (e.g. Cygwin on Windows). ~ is supported.",
  "settings.shellCommandPrefix": "Shell command prefix",
  "settings.shellCommandPrefixDetail":
    "Prepended to every bash command, e.g. shopt -s expand_aliases",
  "settings.npmCommand": "npm command",
  "settings.npmCommandDetail":
    "Command used for package installs, e.g. mise exec node@20 -- npm",
  "settings.sessionDir": "Session directory",
  "settings.sessionDirDetail": "Where session files are stored. Absolute, relative, or ~.",
  "settings.privacy": "Privacy & updates",
  "settings.privacyFooter":
    "The install ping only reports version installs/updates — update checks stay on regardless (disable via PI_OFFLINE=1).",
  "settings.installTelemetry": "Install telemetry",
  "settings.installTelemetryDetail":
    "Anonymous version ping to pi.dev after installs/updates",
  "settings.collapseChangelog": "Collapse changelog",
  "settings.collapseChangelogDetail": "Show a condensed changelog after updates",
  "settings.anthropicExtraUsage": "Anthropic extra-usage warning",
  "settings.anthropicExtraUsageDetail":
    "Warn when subscription auth may bill paid extra usage",
  "settings.settingsFile": "Settings file",
  "settings.fileWillBeCreated": "{path} (will be created on first edit)",
  "settings.customUi": "Interface customization",
  "settings.customUiFooter":
    "Personalize this app — saved locally, applies in both light and dark themes, does not affect pi.",
  "settings.accentColor": "Accent color",
  "settings.bgColor": "Background color",
  "settings.textColor": "Text color",
  "settings.fontSize": "Text size",
  "settings.fontSizeDetail": "scales all interface text",
  "settings.defaultOption": "Default",
  "settings.customColor": "Custom color",
  "settings.bgImage": "Background image",
  "settings.bgImageDetail": "use a picture as the app background (large images are scaled down)",
  "settings.chooseImage": "Choose image…",
  "settings.replaceImage": "Replace image…",
  "settings.removeImage": "Remove",
  "settings.surfaceOpacity": "Surface opacity",
  "settings.imageBlur": "Image blur",
  "settings.customCss": "Custom CSS",
  "settings.customCssFooter":
    "Paste any CSS — it applies instantly and is saved locally across restarts. Add !important to override inline styles; clear the box to remove it.",
  "settings.customCssPlaceholder": "/* paste your CSS here — applies live */",
  "settings.resetAppearance": "Reset appearance",
  "settings.resetAppearanceDetail":
    "Clear custom colors, background image, CSS and text size",
  "settings.notifications": "Desktop Notifications",
  "settings.notificationsDetail": "Show OS notifications when messages complete while window is hidden",

  // models page
  "models.title": "Models",
  "models.subtitleMock":
    "Browser preview — showing mock models. Run inside Tauri with pi installed for live data.",
  "models.subtitleLive": "Connected to pi · {status}",
  "models.activeModel": "Active model",
  "models.activeBadge": "Active",
  "models.noModel": "No model selected",
  "models.pickBelow": "Pick one below",
  "models.thinkingLevel": "Thinking level",
  "models.thinkingFooter":
    "Higher levels reason longer before answering. Maps to pi's set_thinking_level.",
  "models.reasoning": "reasoning",
  "models.cycling": "Model cycling",
  "models.cyclingFooter":
    "enabledModels patterns for Ctrl+P cycling — written to global settings.json. Same format as the --models CLI flag.",
  "models.cyclingPlaceholder": "e.g. claude-* or gpt-4o",
  "models.custom": "Custom models",
  "models.customFooter":
    "Defined in ~/.pi/agent/models.json for OpenAI-compatible or custom endpoints. Restart pi after changes for them to appear in the model list.",
  "models.customParseError": "models.json has invalid JSON — fix it manually first: {error}",
  "models.customEmpty": "No custom models yet",
  "models.addModel": "Add model",
  "models.removeModel": "Remove model",
  "models.providerId": "Provider ID",
  "models.apiType": "API type",
  "models.baseUrl": "Base URL",
  "models.apiKey": "API key",
  "models.modelId": "Model ID",
  "models.modelName": "Display name",
  "models.contextWindow": "Context window",
  "models.maxTokens": "Max tokens",
  "models.reasoningToggle": "Reasoning model",
  "models.addConfirm": "Add",
  "models.cancel": "Cancel",

  // plugins page
  "plugins.title": "Plugins",
  "plugins.subtitleMock": "Browser preview — showing mock data.",
  "plugins.subtitleLive":
    "Packages from settings.json · commands from the running pi process.",
  "plugins.globalHeader": "Installed packages — global",
  "plugins.globalFooter":
    "From ~/.pi/agent/settings.json → packages. npm packages install under ~/.pi/agent/npm/, git clones under ~/.pi/agent/git/. Remove runs `pi remove` and restarts are needed to unload.",
  "plugins.noPackages": "No packages installed",
  "plugins.browseStore": "Browse the Store to add some",
  "plugins.projectHeader": "Installed packages — project",
  "plugins.projectFooter":
    "From .pi/settings.json — shared with your team; pi auto-installs missing ones on startup once the project is trusted.",
  "plugins.liveCommands": "Live extension commands",
  "plugins.liveCommandsFooter":
    "Slash commands the running pi process registered from extensions (local files and packages).",
  "plugins.noExtCommands": "No extension commands",
  "plugins.extLoadPath":
    "Extensions load from ~/.pi/agent/extensions and installed packages",
  "plugins.builtins": "Built-in commands",
  "plugins.actions": "Actions",
  "plugins.refresh": "Refresh",
  "plugins.refreshDetail": "Re-read settings.json and re-query pi's commands",
  "plugins.restartTitle": "Restart pi to apply changes",
  "plugins.restartDetail": "Package changes take effect on next pi start",
  "plugins.remove": "Remove",
  "plugins.removing": "Removing…",
  "plugins.removeFailed": "pi remove failed (exit {code}): {err}",
  "plugins.pinned": "pinned @{version}",
  "plugins.filteredResources": "filtered resources",
  "plugins.localResources": "Local resources",
  "plugins.localResourcesFooter":
    "Extra load paths in settings.json. Global paths resolve relative to ~/.pi/agent, project paths relative to .pi. Globs, ! excludes, and ~ are supported.",
  "plugins.res.skills": "Skills",
  "plugins.res.extensions": "Extensions",
  "plugins.res.prompts": "Prompt templates",
  "plugins.res.themes": "Themes",
  "plugins.addPath": "Add a path or glob…",
  "plugins.skillCommands": "Skill commands",
  "plugins.skillCommandsDetail": "Register skills as /skill:name commands",

  // skills page
  "skills.title": "Skills",
  "skills.subtitleMock": "Browser preview — showing mock data.",
  "skills.subtitleLive":
    "Scanned from the directories the running pi loads skills from.",
  "skills.origin.global": "Global",
  "skills.origin.project": "Project",
  "skills.origin.path": "Configured paths",
  "skills.search": "Search skills…",
  "skills.scanning": "Scanning skill directories…",
  "skills.none": "No skills yet",
  "skills.noneDetail":
    "Drop a folder with a SKILL.md into ~/.pi/agent/skills, or install a package from the Store.",
  "skills.noMatch": "No skills match “{query}”",
  "skills.copy": "Copy",
  "skills.copied": "Copied",
  "skills.viewSource": "View SKILL.md",
  "skills.hideSource": "Hide SKILL.md",
  "skills.sourceLoading": "Loading…",
  "skills.sourceError": "Cannot read SKILL.md: {err}",
  "skills.groupFooter.global":
    "From ~/.pi/agent/skills — available in every project.",
  "skills.groupFooter.project":
    "From .pi/skills in this project — shared with your team.",
  "skills.groupFooter.path": "From extra paths in settings.json → skills.",
  "skills.unscannable":
    "Glob entries aren't scanned here, so this list may be partial: {globs}",
  "skills.loadHeader": "Loading",
  "skills.loadFooter":
    "Extra skill directories in settings.json. Global paths resolve relative to ~/.pi/agent, project paths relative to .pi. Changes apply after restarting pi.",
  "skills.rescan": "Rescan",
  "skills.rescanDetail": "Re-read settings.json and scan skill directories again",

  // store page
  "store.title": "Store",
  "store.subtitleMock":
    "Browser preview — mock results. The real store queries the npm registry.",
  "store.subtitleLive":
    "npm packages tagged pi-package — the same set as pi.dev/packages.",
  "store.search": "Search",
  "store.searchFooterGlobal":
    "Installs run `pi install npm:<name>` → written to ~/.pi/agent/settings.json, downloaded to ~/.pi/agent/npm/.",
  "store.searchFooterProject":
    "Installs run `pi install -l` → written to .pi/settings.json so your team gets it too (auto-installed on trusted startup).",
  "store.filterPlaceholder": "Filter packages…",
  "store.installedLog": "Installed {name} — restart pi to load it.",
  "store.installFailed": "pi install failed (exit {code}): {err}",
  "store.packagesCount": "{n} packages",
  "store.packages": "Packages",
  "store.packagesFooter":
    "Packages run with full system access — extensions execute arbitrary code. Review the source before installing anything third-party.",
  "store.registryError": "Could not reach the npm registry",
  "store.loadingDetail": "Querying registry.npmjs.org",
  "store.noMatches": "No matches",
  "store.tryDifferent": "Try a different search",
  "store.installedBadge": "Installed",
  "store.install": "Install",
  "store.installing": "Installing…",

  // state pages (404 / error)
  "state.notFound.title": "Page not found",
  "state.notFound.body":
    "This address doesn't match any view in the app. Head back to the workspace to keep going.",
  "state.notFound.home": "Back to workspace",
  "state.error.title": "This view crashed",
  "state.error.body":
    "Pi hit an unexpected error while rendering. Try again — if it keeps happening, copy the details and report them.",
  "state.error.retry": "Try again",
  "state.error.copy": "Copy details",
  "state.error.copied": "Copied",

  // software update
  "update.title": "Software Update",
  "update.subtitle":
    "Updates arrive as version tags on the release repository.",
  "update.check": "Check for Updates",
  "update.checking": "Checking…",
  "update.upToDate": "Pi is up to date",
  "update.availableStatus": "{version} is available",
  "update.availableTitle": "Update available",
  "update.latestTag": "Latest release tag",
  "update.install": "Download & Install",
  "update.installing": "Updating…",
  "update.installFooter":
    "Pi downloads the tagged release and restarts automatically when it's done.",
  "update.mockApply":
    "Browser preview — installing works in the desktop app only.",
  "update.currentVersion": "This install",
  "update.version": "Version",
  "update.channel": "Channel",
  "update.channelStable": "Stable · git tags",
  "update.source": "Update source",
  "update.sourceRepo": "Release repository",
  "update.sourceFooter":
    "Checks read the repository's tags over `git ls-remote` — nothing is downloaded until you install.",
  "update.notConfigured": "Not configured yet",
  "update.notConfiguredStatus": "Update source not configured",
  "update.notConfiguredFooter":
    "This build doesn't ship with a release repository yet. Once it's published, checking and one-tap updating light up here automatically.",
  "update.checkFailed": "Couldn't reach the release repository",
  "update.problem": "Problem",
  "update.lastChecked": "Last checked at {time}",
  "cliUpdate.title": "pi CLI update available.",
  "cliUpdate.message": "{latest} is out — you have {installed}.",
  "cliUpdate.updateNow": "Update",
  "cliUpdate.later": "Later",
  "cliUpdate.skip": "Skip version",
  "cliUpdate.retry": "Retry",
  "cliUpdate.updating": "Updating pi…",
  "cliUpdate.updated": "pi updated — restart pi to use the new version.",
  "cliUpdate.restartPi": "Restart pi",
  "cliUpdate.updateFailed": "pi update failed: {reason}",
  "cliUpdate.sectionTitle": "pi CLI",
  "cliUpdate.sectionFooter":
    "The desktop app runs on the pi CLI. Updates run `pi update`; versions come from release tags on badlogic/pi-mono.",
  "cliUpdate.installed": "Installed",
  "cliUpdate.latest": "Latest",
  "cliUpdate.notFound": "pi was not found on PATH",
  "cliUpdate.upToDate": "pi is up to date",
  "settings.softwareUpdate": "Software Update",
  "settings.softwareUpdateDetail": "Version {version}",
} as const;

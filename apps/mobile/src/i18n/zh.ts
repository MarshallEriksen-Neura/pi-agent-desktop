export const zh: Record<string, string> = {
  // App
  "app.name": "Pi Remote",

  // Onboarding
  "onboarding.title": "Pi Remote",
  "onboarding.subtitle": "安全连接你的桌面",
  "onboarding.description": "在局域网内安全查看授权项目、创建任务、响应交互——所有数据通过 TLS 证书锁定加密传输。",
  "onboarding.start": "开始配对",
  "onboarding.hasConnection": "自动连接中…",

  // Pairing — states
  "pairing.idle": "准备扫码",
  "pairing.scanning": "将摄像头对准桌面端二维码",
  "pairing.validating": "正在验证配对凭证…",
  "pairing.connecting": "正在建立安全连接…",
  "pairing.success": "配对成功",
  "pairing.successDetail": "已建立安全连接，正在跳转…",
  "pairing.expired": "二维码已过期",
  "pairing.expiredDetail": "请在桌面端重新生成二维码后再次扫码。",
  "pairing.unsupported": "不支持的二维码",
  "pairing.unsupportedDetail": "这不是 Pi Remote 的配对二维码。",
  "pairing.unreachable": "无法连接桌面",
  "pairing.unreachableDetail": "请确认手机和电脑在同一 Wi-Fi，且桌面端已启用远程控制。",
  "pairing.pinMismatch": "证书验证失败",
  "pairing.pinMismatchDetail": "桌面身份可能与配对时不一致，可能存在安全风险。请重新配对。",
  "pairing.rateLimited": "配对过于频繁",
  "pairing.rateLimitedDetail": "请稍等片刻后再试。",
  "pairing.failed": "配对失败",
  "pairing.failedDetail": "发生未知错误，请重试。",
  "pairing.retry": "重新扫码",
  "pairing.manualEntry": "手动输入配对信息",
  "pairing.manualEntryHint": "开发预览：粘贴 PairingQrPayload JSON",

  // Connection
  "connection.online": "已连接",
  "connection.reconnecting": "重连中…",
  "connection.offline": "未连接",
  "connection.identityFailed": "身份已变更",
  "connection.reconnect": "重新连接",
  "connection.forget": "忘记此桌面",
  "connection.forgetConfirm": "忘记桌面？",
  "connection.forgetConfirmDetail": "本地将清除连接信息。如需重新连接，请在桌面端重新配对。",

  // Home
  "home.title": "Pi Remote",
  "home.desktop": "桌面",
  "home.projects": "项目",
  "home.tasks": "任务",
  "home.settings": "设置",
  "home.noTasks": "暂无任务",
  "home.noTasksDetail": "选择一个项目开始创建任务",
  "home.quickActions": "快捷操作",

  // Tab bar
  "tab.home": "首页",
  "tab.projects": "项目",
  "tab.tasks": "任务",
  "tab.settings": "设置",

  // Common
  "common.cancel": "取消",
  "common.confirm": "确认",
  "common.close": "关闭",
  "common.retry": "重试",
  "common.loading": "加载中…",
  "common.error": "出错了",
  "common.back": "返回",

  // Settings
  "settings.connection": "连接",
  "settings.connectionDetail": "管理桌面连接",
  "settings.security": "安全",
  "settings.securityDetail": "证书锁定状态",
  "settings.about": "关于",
  "settings.aboutDetail": "版本与协议",
  "settings.forgetDevice": "忘记此桌面",
  "settings.forgetDeviceDetail": "清除本地连接信息",
  "settings.certPin": "证书锁定",
  "settings.certPinActive": "已启用",
  "settings.certPinInactive": "未启用（浏览器模式）",

  // Errors
  "error.offline": "网络不可用",
  "error.offlineDetail": "请检查 Wi-Fi 或局域网连接。",
  "error.unreachable": "无法连接桌面",
  "error.unreachableDetail": "请确认桌面端已启用远程控制，且两台设备在同一局域网。",
  "error.authFailed": "设备未授权",
  "error.authFailedDetail": "请在桌面端撤销此设备后重新配对。",
  "error.identityRotated": "桌面身份已重置",
  "error.identityRotatedDetail": "当前设备令牌已失效，请重新配对。",
  "error.rateLimited": "操作过于频繁",
  "error.rateLimitedDetail": "请稍后重试。",
  "error.serverError": "桌面服务暂时不可用",
  "error.serverErrorDetail": "请稍后重试。",
  "error.unknown": "未知错误",
  "error.unknownDetail": "请重试，如问题持续请重新配对。",
};

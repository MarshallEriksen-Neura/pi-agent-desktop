export const en: Record<string, string> = {
  // App
  "app.name": "Pi Remote",

  // Onboarding
  "onboarding.title": "Pi Remote",
  "onboarding.subtitle": "Securely connect to your desktop",
  "onboarding.description":
    "Browse authorized projects, create tasks, and respond to interactions over your LAN — all encrypted with TLS certificate pinning.",
  "onboarding.start": "Start pairing",
  "onboarding.hasConnection": "Connecting automatically…",

  // Pairing — states
  "pairing.idle": "Ready to scan",
  "pairing.scanning": "Point your camera at the desktop QR code",
  "pairing.validating": "Validating pairing ticket…",
  "pairing.connecting": "Establishing secure connection…",
  "pairing.success": "Paired successfully",
  "pairing.successDetail": "Secure connection established, redirecting…",
  "pairing.expired": "QR code expired",
  "pairing.expiredDetail": "Please regenerate the QR on the desktop and scan again.",
  "pairing.unsupported": "Unsupported QR code",
  "pairing.unsupportedDetail": "This is not a Pi Remote pairing QR.",
  "pairing.unreachable": "Cannot reach desktop",
  "pairing.unreachableDetail": "Make sure your phone and computer are on the same Wi-Fi and remote control is enabled.",
  "pairing.pinMismatch": "Certificate verification failed",
  "pairing.pinMismatchDetail": "The desktop identity may have changed — possible security risk. Please re-pair.",
  "pairing.rateLimited": "Pairing too frequently",
  "pairing.rateLimitedDetail": "Please wait a moment and try again.",
  "pairing.failed": "Pairing failed",
  "pairing.failedDetail": "An unknown error occurred. Please retry.",
  "pairing.retry": "Scan again",
  "pairing.manualEntry": "Enter pairing info manually",
  "pairing.manualEntryHint": "Dev preview: paste PairingQrPayload JSON",

  // Connection
  "connection.online": "Connected",
  "connection.reconnecting": "Reconnecting…",
  "connection.offline": "Disconnected",
  "connection.identityFailed": "Identity changed",
  "connection.reconnect": "Reconnect",
  "connection.forget": "Forget this desktop",
  "connection.forgetConfirm": "Forget desktop?",
  "connection.forgetConfirmDetail": "This clears the local connection. You'll need to re-pair on the desktop to reconnect.",

  // Home
  "home.title": "Pi Remote",
  "home.desktop": "Desktop",
  "home.projects": "Projects",
  "home.tasks": "Tasks",
  "home.settings": "Settings",
  "home.noTasks": "No tasks",
  "home.noTasksDetail": "Select a project to create a task",
  "home.quickActions": "Quick actions",

  // Tab bar
  "tab.home": "Home",
  "tab.projects": "Projects",
  "tab.tasks": "Tasks",
  "tab.settings": "Settings",

  // Common
  "common.cancel": "Cancel",
  "common.confirm": "Confirm",
  "common.close": "Close",
  "common.retry": "Retry",
  "common.loading": "Loading…",
  "common.error": "Something went wrong",
  "common.back": "Back",

  // Settings
  "settings.connection": "Connection",
  "settings.connectionDetail": "Manage desktop connection",
  "settings.security": "Security",
  "settings.securityDetail": "Certificate pinning status",
  "settings.about": "About",
  "settings.aboutDetail": "Version & protocol",
  "settings.forgetDevice": "Forget this desktop",
  "settings.forgetDeviceDetail": "Clear local connection data",
  "settings.certPin": "Certificate pinning",
  "settings.certPinActive": "Active",
  "settings.certPinInactive": "Inactive (browser mode)",

  // Errors
  "error.offline": "Network unavailable",
  "error.offlineDetail": "Please check your Wi-Fi or LAN connection.",
  "error.unreachable": "Cannot reach desktop",
  "error.unreachableDetail": "Make sure remote control is enabled and both devices are on the same LAN.",
  "error.authFailed": "Device not authorized",
  "error.authFailedDetail": "Please revoke this device on the desktop and re-pair.",
  "error.identityRotated": "Desktop identity reset",
  "error.identityRotatedDetail": "Your device token is no longer valid. Please re-pair.",
  "error.rateLimited": "Too many requests",
  "error.rateLimitedDetail": "Please wait and try again.",
  "error.serverError": "Desktop service unavailable",
  "error.serverErrorDetail": "Please try again later.",
  "error.unknown": "Unknown error",
  "error.unknownDetail": "Please retry. If the problem persists, re-pair.",
};

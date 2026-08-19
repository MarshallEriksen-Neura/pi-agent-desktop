import { desktopInvoke } from "./invoke";
import { listen } from "@tauri-apps/api/event";
import type {
  AgentBrowserInstallResultDto,
  AgentBrowserStatusDto,
  ApprovalInfoDto,
  BrowserPort,
  BrowserStatusDto,
  NavigateResultDto,
} from "../ports/browser";

export const desktopBrowserPort: BrowserPort = {
  start: () => desktopInvoke<BrowserStatusDto>("browser_start"),
  stop: () => desktopInvoke<void>("browser_stop"),
  status: () => desktopInvoke<BrowserStatusDto>("browser_status"),
  navigate: (url) => desktopInvoke<NavigateResultDto>("browser_navigate", { url }),
  approveOrigin: (id, allow) => desktopInvoke<NavigateResultDto>("browser_approve_origin", { id, allow }),
  screenshot: () => desktopInvoke<string>("browser_screenshot"),
  click: (x, y) => desktopInvoke<void>("browser_click", { x, y }),
  typeText: (text) => desktopInvoke<void>("browser_type", { text }),
  pressKey: (key) => desktopInvoke<void>("browser_press_key", { key }),
  back: () => desktopInvoke<void>("browser_back"),
  forward: () => desktopInvoke<void>("browser_forward"),
  reload: () => desktopInvoke<void>("browser_reload"),
  eval: (expression) => desktopInvoke<unknown>("browser_eval", { expression }),
  allowlist: () => desktopInvoke<string[]>("browser_allowlist"),
  removeOrigin: (origin) => desktopInvoke<void>("browser_remove_origin", { origin }),
  checkAgentBrowser: () => desktopInvoke<AgentBrowserStatusDto>("agent_browser_check"),
  installAgentBrowser: () => desktopInvoke<AgentBrowserInstallResultDto>("agent_browser_install"),
  onState: (handler) =>
    listen<BrowserStatusDto>("browser://state", (event) => handler(event.payload)),
  onApproval: (handler) =>
    listen<ApprovalInfoDto>("browser://approval", (event) => handler(event.payload)),
  onConsole: (handler) =>
    listen<string>("browser://console", (event) => handler(event.payload)),
};

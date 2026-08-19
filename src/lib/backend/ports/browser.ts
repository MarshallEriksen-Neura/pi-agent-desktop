import type { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface BrowserStatusDto {
  running: boolean;
  url?: string | null;
  title?: string | null;
  loading: boolean;
  port?: number | null;
  browser?: string | null;
  pendingApproval?: ApprovalInfoDto | null;
  mcpEndpoint?: string | null;
}

export interface ApprovalInfoDto {
  id: number;
  origin: string;
  url: string;
}

export interface NavigateResultDto {
  needsApproval: boolean;
  approval?: ApprovalInfoDto | null;
  ok: boolean;
  error?: string | null;
}

export interface BrowserPort {
  start(): Promise<BrowserStatusDto>;
  stop(): Promise<void>;
  status(): Promise<BrowserStatusDto>;
  navigate(url: string): Promise<NavigateResultDto>;
  approveOrigin(id: number, allow: boolean): Promise<NavigateResultDto>;
  screenshot(): Promise<string>;
  click(x: number, y: number): Promise<void>;
  typeText(text: string): Promise<void>;
  pressKey(key: string): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  eval(expression: string): Promise<unknown>;
  allowlist(): Promise<string[]>;
  removeOrigin(origin: string): Promise<void>;
  onState(handler: (status: BrowserStatusDto) => void): Promise<() => void>;
  onApproval(handler: (info: ApprovalInfoDto) => void): Promise<() => void>;
  onConsole(handler: (text: string) => void): Promise<() => void>;
}

export function createTauriBrowserPort(invokeFn: typeof invoke): BrowserPort {
  return {
    start: () => invokeFn<BrowserStatusDto>("browser_start"),
    stop: () => invokeFn<void>("browser_stop"),
    status: () => invokeFn<BrowserStatusDto>("browser_status"),
    navigate: (url) => invokeFn<NavigateResultDto>("browser_navigate", { url }),
    approveOrigin: (id, allow) => invokeFn<NavigateResultDto>("browser_approve_origin", { id, allow }),
    screenshot: () => invokeFn<string>("browser_screenshot"),
    click: (x, y) => invokeFn<void>("browser_click", { x, y }),
    typeText: (text) => invokeFn<void>("browser_type", { text }),
    pressKey: (key) => invokeFn<void>("browser_press_key", { key }),
    back: () => invokeFn<void>("browser_back"),
    forward: () => invokeFn<void>("browser_forward"),
    reload: () => invokeFn<void>("browser_reload"),
    eval: (expression) => invokeFn<unknown>("browser_eval", { expression }),
    allowlist: () => invokeFn<string[]>("browser_allowlist"),
    removeOrigin: (origin) => invokeFn<void>("browser_remove_origin", { origin }),
    onState: (handler) =>
      listen<BrowserStatusDto>("browser://state", (event) => handler(event.payload)),
    onApproval: (handler) =>
      listen<ApprovalInfoDto>("browser://approval", (event) => handler(event.payload)),
    onConsole: (handler) =>
      listen<string>("browser://console", (event) => handler(event.payload)),
  };
}

export interface MockBrowserPort extends BrowserPort {}

export function createMockBrowserPort(): BrowserPort {
  const status: BrowserStatusDto = { running: false, loading: false };
  return {
    start: async () => {
      status.running = true;
      status.url = "https://example.com";
      status.browser = "mock-chromium";
      return { ...status };
    },
    stop: async () => {
      status.running = false;
      status.url = undefined;
      return;
    },
    status: async () => ({ ...status }),
    navigate: async (url) => {
      if (status.running) {
        status.url = url;
        return { needsApproval: false, ok: true };
      }
      return { needsApproval: false, ok: false, error: "browser not running" };
    },
    approveOrigin: async () => ({ needsApproval: false, ok: true }),
    screenshot: async () => "",
    click: async () => {},
    typeText: async () => {},
    pressKey: async () => {},
    back: async () => {},
    forward: async () => {},
    reload: async () => {},
    eval: async () => null,
    allowlist: async () => [],
    removeOrigin: async () => {},
    onState: async () => () => {},
    onApproval: async () => () => {},
    onConsole: async () => () => {},
  };
}

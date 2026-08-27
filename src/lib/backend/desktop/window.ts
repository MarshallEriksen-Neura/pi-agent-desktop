import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm } from "@tauri-apps/plugin-dialog";
import type { WindowPort } from "../ports/window";
import { desktopInvoke } from "./invoke";

export const desktopWindowPort = {
  close: () => getCurrentWindow().close(),
  quit: (exitCode = 0) => desktopInvoke<void>("app_quit", { exitCode }),
  focus: () => getCurrentWindow().setFocus(),
  setFocus: () => getCurrentWindow().setFocus(),
  show: () => getCurrentWindow().show(),
  hide: () => getCurrentWindow().hide(),
  minimize: () => getCurrentWindow().minimize(),
  unminimize: () => getCurrentWindow().unminimize(),
  toggleMaximize: () => getCurrentWindow().toggleMaximize(),
  isMaximized: () => getCurrentWindow().isMaximized(),
  isVisible: () => getCurrentWindow().isVisible(),
  isMinimized: () => getCurrentWindow().isMinimized(),
  startDragging: () => getCurrentWindow().startDragging(),
  setTitle: (title) => getCurrentWindow().setTitle(title),
  confirm: (message) => confirm(message),
  onCloseRequested: (handler) => getCurrentWindow().onCloseRequested(handler),
  onEvent: async (event, handler) =>
    getCurrentWindow().listen(event, (payload) => handler(payload.payload as never)),
  emit: (event, payload) => emit(event, payload),
} satisfies WindowPort;

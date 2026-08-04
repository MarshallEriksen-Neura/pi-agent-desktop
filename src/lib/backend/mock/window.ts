import type { WindowPort } from "../ports/window";

const noop = async () => undefined;

export const mockWindowPort = {
  close: async () => {
    window.close();
  },
  quit: async () => {
    window.close();
  },
  focus: noop,
  setFocus: noop,
  show: noop,
  hide: noop,
  minimize: noop,
  unminimize: noop,
  toggleMaximize: noop,
  isMaximized: async () => false,
  isVisible: async () =>
    typeof document === "undefined" || document.visibilityState !== "hidden",
  isMinimized: async () => false,
  startDragging: noop,
  setTitle: async (title) => {
    if (typeof document !== "undefined") document.title = title;
  },
  confirm: async (message) => window.confirm(message),
  onCloseRequested: async () => () => undefined,
  onEvent: async () => () => undefined,
  emit: noop,
} satisfies WindowPort;

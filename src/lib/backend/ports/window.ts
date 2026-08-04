export type WindowEventName =
  | "close-requested"
  | "focus"
  | "blur"
  | "resized"
  | "moved"
  | string;

export interface WindowCloseRequest {
  preventDefault(): void;
}

export interface WindowPort {
  close(): Promise<void>;
  quit(exitCode?: number): Promise<void>;
  focus(): Promise<void>;
  setFocus(): Promise<void>;
  show(): Promise<void>;
  hide(): Promise<void>;
  minimize(): Promise<void>;
  unminimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  isMaximized(): Promise<boolean>;
  isVisible(): Promise<boolean>;
  isMinimized(): Promise<boolean>;
  startDragging(): Promise<void>;
  setTitle(title: string): Promise<void>;
  confirm(message: string): Promise<boolean>;
  onCloseRequested(handler: (event: WindowCloseRequest) => void): Promise<() => void>;
  onEvent<T = unknown>(event: WindowEventName, handler: (payload: T) => void): Promise<() => void>;
  emit<T = unknown>(event: WindowEventName, payload?: T): Promise<void>;
}

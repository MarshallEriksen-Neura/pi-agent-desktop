import { listen } from "@tauri-apps/api/event";
import type {
  PiProcessExit,
  PiProcessPort,
  PiProcessStartOptions,
} from "../ports/pi-process";
import { desktopInvoke } from "./invoke";
import type { PiCommand } from "../../pi/protocol";

type Unlisten = () => void;

export class DesktopPiProcessPort implements PiProcessPort {
  private readonly lineHandlers = new Set<(line: string) => void>();
  private readonly stderrHandlers = new Set<(line: string) => void>();
  private readonly exitHandlers = new Set<(exit: PiProcessExit) => void>();
  private unlistenLine: Unlisten | null = null;
  private unlistenStderr: Unlisten | null = null;
  private unlistenExit: Unlisten | null = null;

  async start(options: PiProcessStartOptions = {}): Promise<void> {
    await this.ensureListeners();
    await desktopInvoke("pi_start", {
      cwd: options.cwd ?? null,
      binary: null,
      resumePath: options.resumePath ?? null,
    });
  }

  async send(command: PiCommand): Promise<void> {
    await desktopInvoke("pi_send", { line: JSON.stringify(command) });
  }

  async stop(): Promise<void> {
    await desktopInvoke("pi_stop");
    this.cleanupListeners();
  }

  onLine(handler: (line: string) => void): () => void {
    this.lineHandlers.add(handler);
    return once(() => {
      this.lineHandlers.delete(handler);
    });
  }

  onStderr(handler: (line: string) => void): () => void {
    this.stderrHandlers.add(handler);
    return once(() => {
      this.stderrHandlers.delete(handler);
    });
  }

  onExit(handler: (exit: PiProcessExit) => void): () => void {
    this.exitHandlers.add(handler);
    return once(() => {
      this.exitHandlers.delete(handler);
    });
  }

  private async ensureListeners(): Promise<void> {
    if (!this.unlistenLine) {
      this.unlistenLine = await listen<string>("pi://line", (event) => {
        this.lineHandlers.forEach((handler) => handler(event.payload));
      });
    }
    if (!this.unlistenStderr) {
      this.unlistenStderr = await listen<string>("pi://stderr", (event) => {
        this.stderrHandlers.forEach((handler) => handler(event.payload));
      });
    }
    if (!this.unlistenExit) {
      this.unlistenExit = await listen<number | null>("pi://exit", (event) => {
        this.cleanupListeners();
        this.exitHandlers.forEach((handler) => handler({ code: event.payload ?? null }));
      });
    }
  }

  private cleanupListeners(): void {
    this.unlistenLine?.();
    this.unlistenStderr?.();
    this.unlistenExit?.();
    this.unlistenLine = null;
    this.unlistenStderr = null;
    this.unlistenExit = null;
  }
}

export function createDesktopPiProcessPort(): PiProcessPort {
  return new DesktopPiProcessPort();
}

function once(cleanup: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    cleanup();
  };
}

import type { RemoteConversationEvent } from "@pi/remote-control-contracts";
import type { EventStreamHandle, SecureNetPort } from "./port";

export type ConversationEventStreamPhase = "connecting" | "open" | "reconnecting" | "closed";

export interface ConversationEventStreamCallbacks {
  onEvent: (event: RemoteConversationEvent) => void;
  onSnapshotRequired: () => void;
  onPhaseChange?: (phase: ConversationEventStreamPhase) => void;
  onTerminalError?: (message: string) => void;
}

const DEDUP_MAX = 500;
const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 16000];

/** Durable v2 event stream. Its cursor is independent from the v1 event lane. */
export class ConversationEventStreamClient {
  private handle: EventStreamHandle | null = null;
  private lastSequence = 0;
  private seenIds = new Map<string, true>();
  private backoffIndex = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private phase: ConversationEventStreamPhase = "closed";

  constructor(
    private readonly transport: SecureNetPort,
    private readonly buildUrl: (after?: number) => string,
    private readonly headers: () => Record<string, string>,
    private readonly callbacks: ConversationEventStreamCallbacks,
  ) {}

  async connect(after?: number): Promise<void> {
    this.stopped = false;
    if (after != null) this.lastSequence = after;
    await this.cleanupHandle();
    this.setPhase("connecting");
    await this.doConnect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.cleanupHandle();
    this.setPhase("closed");
  }

  get currentSequence(): number {
    return this.lastSequence;
  }

  private async doConnect(): Promise<void> {
    if (this.stopped) return;
    try {
      this.handle = await this.transport.openStream({
        url: this.buildUrl(this.lastSequence > 0 ? this.lastSequence : undefined),
        headers: this.headers(),
      });
      this.handle.onMessage((data) => this.handleMessage(data));
      this.handle.onClose(() => {
        this.handle = null;
        if (!this.stopped) this.scheduleReconnect();
        else this.setPhase("closed");
      });
      this.handle.onError((message) => {
        if (message === "pin_mismatch" || message.includes("identity")) {
          this.stopped = true;
          this.callbacks.onTerminalError?.(message);
          this.setPhase("closed");
        }
      });
      this.backoffIndex = 0;
      this.setPhase("open");
    } catch {
      if (!this.stopped) this.scheduleReconnect();
    }
  }

  private handleMessage(data: string): void {
    let event: RemoteConversationEvent;
    try {
      event = JSON.parse(data) as RemoteConversationEvent;
    } catch {
      return;
    }
    if (!event.eventId || this.seenIds.has(event.eventId)) return;
    this.seenIds.set(event.eventId, true);
    if (this.seenIds.size > DEDUP_MAX) {
      const oldest = this.seenIds.keys().next().value;
      if (oldest) this.seenIds.delete(oldest);
    }
    if (event.sequence > this.lastSequence) this.lastSequence = event.sequence;
    if (event.kind === "snapshot_required") this.callbacks.onSnapshotRequired();
    else this.callbacks.onEvent(event);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = BACKOFF_STEPS[Math.min(this.backoffIndex, BACKOFF_STEPS.length - 1)];
    this.backoffIndex += 1;
    this.setPhase("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.doConnect();
    }, delay);
  }

  private async cleanupHandle(): Promise<void> {
    if (!this.handle) return;
    try {
      await this.handle.close();
    } catch {
      // The native stream may already have closed.
    }
    this.handle = null;
  }

  private setPhase(phase: ConversationEventStreamPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.callbacks.onPhaseChange?.(phase);
  }
}

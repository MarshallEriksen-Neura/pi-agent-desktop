import type { SecureNetPort, EventStreamHandle } from "./port";
import type { RemoteEvent } from "@pi/remote-control-contracts";

/**
 * EventStreamClient — manages the WSS event stream with:
 *
 *  - **Sequence recovery**: reconnects with `?after=<lastSeq>` to replay
 *    missed events (at-least-once delivery, AC9).
 *  - **Dedup**: tracks seen `eventId`s (LRU 500) to drop duplicates across
 *    reconnects.
 *  - **Exponential backoff**: 1s → 2s → 4s → 8s → 16s (cap), resets on clean
 *    message receipt.
 *  - **snapshot_required**: emits a dedicated callback so the store can
 *    re-fetch GET /tasks.
 *  - **Terminal errors**: `pin_mismatch` and `identity_rotated` stop the
 *    client — no reconnect — and surface to the UI's identity-failed state.
 *
 * The client is single-connection: calling `connect()` while already
 * connected first drains the previous stream.
 */

export type EventStreamPhase = "connecting" | "open" | "reconnecting" | "closed";

export interface EventStreamCallbacks {
  onEvent: (event: RemoteEvent) => void;
  onSnapshotRequired: () => void;
  onPhaseChange: (phase: EventStreamPhase) => void;
  onTerminalError: (message: string) => void;
}

const DEDUP_MAX = 500;
const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 16000];

export class EventStreamClient {
  private handle: EventStreamHandle | null = null;
  private lastSequence = 0;
  private seenIds = new Map<string, true>(); // LRU via size cap
  private backoffIndex = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private phase: EventStreamPhase = "closed";

  constructor(
    private readonly transport: SecureNetPort,
    private readonly buildUrl: (after?: number) => string,
    private readonly headers: () => Record<string, string>,
    private readonly callbacks: EventStreamCallbacks,
  ) {}

  get currentSequence(): number {
    return this.lastSequence;
  }

  get currentPhase(): EventStreamPhase {
    return this.phase;
  }

  /** Open the stream. If already open, the previous handle is closed first. */
  async connect(after?: number): Promise<void> {
    this.stopped = false;
    if (after != null) this.lastSequence = after;
    await this.cleanupHandle();
    this.setPhase("connecting");
    await this.doConnect();
  }

  /** Permanently stop the client. No reconnect will be attempted. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.cleanupHandle();
    this.setPhase("closed");
  }

  // ----------------------------------------------------------------
  // Internal
  // ----------------------------------------------------------------

  private async doConnect(): Promise<void> {
    if (this.stopped) return;
    try {
      this.handle = await this.transport.openStream({
        url: this.buildUrl(this.lastSequence > 0 ? this.lastSequence : undefined),
        headers: this.headers(),
      });

      this.handle.onMessage((data) => {
        this.handleMessage(data);
      });

      this.handle.onClose((_code, _reason) => {
        this.handle = null;
        if (this.stopped) {
          this.setPhase("closed");
          return;
        }
        // Clean close (1000) or abnormal — both trigger reconnect unless stopped.
        this.scheduleReconnect();
      });

      this.handle.onError((message) => {
        // Pin mismatch / identity rotation are terminal — stop reconnecting.
        if (message === "pin_mismatch" || message.includes("identity")) {
          this.stopped = true;
          this.handle = null;
          this.setPhase("closed");
          this.callbacks.onTerminalError(message);
          return;
        }
        // Transient errors — the close handler will trigger reconnect.
      });

      this.setPhase("open");
      this.backoffIndex = 0; // reset on successful open
    } catch (e) {
      if (this.stopped) return;
      this.scheduleReconnect();
    }
  }

  private handleMessage(data: string): void {
    let event: RemoteEvent;
    try {
      event = JSON.parse(data) as RemoteEvent;
    } catch {
      return; // malformed frame — drop silently
    }

    // Dedup by eventId
    if (this.seenIds.has(event.eventId)) return;
    this.seenIds.set(event.eventId, true);
    if (this.seenIds.size > DEDUP_MAX) {
      // Evict oldest (Map preserves insertion order)
      const oldest = this.seenIds.keys().next().value;
      if (oldest) this.seenIds.delete(oldest);
    }

    // Advance sequence
    if (event.sequence > this.lastSequence) {
      this.lastSequence = event.sequence;
    }

    // Route special events
    if (event.kind === "snapshot_required") {
      this.callbacks.onSnapshotRequired();
      return;
    }

    // Emit to consumer
    this.callbacks.onEvent(event);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = BACKOFF_STEPS[Math.min(this.backoffIndex, BACKOFF_STEPS.length - 1)];
    this.backoffIndex++;
    this.setPhase("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.doConnect();
    }, delay);
  }

  private async cleanupHandle(): Promise<void> {
    if (this.handle) {
      try {
        await this.handle.close();
      } catch {
        // ignore — already closed
      }
      this.handle = null;
    }
  }

  private setPhase(phase: EventStreamPhase): void {
    if (this.phase !== phase) {
      this.phase = phase;
      this.callbacks.onPhaseChange(phase);
    }
  }
}

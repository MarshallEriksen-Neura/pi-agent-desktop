import type { SecureNetPort } from "./port";
import { NetError, classifyError } from "./errors";
import type {
  PairingRequest,
  PairingResponse,
  RemoteProjectSummary,
  RemoteTreePage,
  RemoteTaskSnapshot,
  RemoteTaskCreateRequest,
  RemoteInteractionSnapshot,
  RemoteInteractionResponse,
  RemoteConversationCapabilities,
  RemoteConversationCreateRequest,
  RemoteConversationCreateResponse,
  RemoteConversationListResponse,
  RemoteConversationSnapshot,
  RemoteConversationEvent,
  RemoteMessagePageResponse,
  RemoteTurnAppendRequest,
  RemoteTurnAppendResponse,
  RemoteTurnCancelResponse,
} from "@pi/remote-control-contracts";

/**
 * RemoteControlClient — typed wrapper over the 14 REST/WSS endpoints exposed
 * by the desktop gateway. Every call goes through {@link SecureNetPort} so
 * cert pinning is enforced on native; the browser fallback skips it.
 *
 * Auth headers (`x-pi-device-id` + `Authorization: Bearer`) are injected
 * centrally so no endpoint can forget them. The `/pair` endpoint is the only
 * one that skips auth — it trades a QR ticket for a token.
 */
export class RemoteControlClient {
  constructor(
    private readonly transport: SecureNetPort,
    private readonly baseUrl: string,
    private readonly getAuth: () => { deviceId: string; token: string } | null,
  ) {}

  // ----------------------------------------------------------------
  // Pairing (no auth)
  // ----------------------------------------------------------------

  async pair(req: PairingRequest): Promise<PairingResponse> {
    return this.sendJson<PairingResponse>("POST", "/pair", req, { skipAuth: true });
  }

  // ----------------------------------------------------------------
  // Connection lifecycle (auth)
  // ----------------------------------------------------------------

  async getMe(): Promise<{ deviceId: string; identityEpoch: number; scopes: string[] }> {
    return this.sendJson("GET", "/api/v1/me");
  }

  async getServer(): Promise<{
    status: string;
    protocolVersion: number;
    serverVersion: string;
    identityEpoch: number;
    certificatePin: { algorithm: string; value: string };
  }> {
    return this.sendJson("GET", "/api/v1/server");
  }

  async getCapabilities(): Promise<{
    protocolVersion: number;
    maxRequestBodyBytes: number;
    maxQueueSize: number;
    maxActiveTasks: number;
    supportedInteractions: string[];
    project: {
      maxTreeEntriesPerPage: number;
      maxContextFiles: number;
      maxRelativePathBytes: number;
      fileBodyAvailable: boolean;
    };
  }> {
    return this.sendJson("GET", "/api/v1/capabilities");
  }

  // ----------------------------------------------------------------
  // Projects (auth)
  // ----------------------------------------------------------------

  async getProjects(): Promise<RemoteProjectSummary[]> {
    return this.sendJson("GET", "/api/v1/projects");
  }

  async getProjectTree(
    projectId: string,
    dir?: string,
    cursor?: string,
  ): Promise<RemoteTreePage> {
    const params = new URLSearchParams();
    if (dir) params.set("dir", dir);
    if (cursor) params.set("cursor", cursor);
    const qs = params.toString();
    return this.sendJson("GET", `/api/v1/projects/${encodeURIComponent(projectId)}/tree${qs ? `?${qs}` : ""}`);
  }

  // ----------------------------------------------------------------
  // Tasks (auth)
  // ----------------------------------------------------------------

  async getTasks(): Promise<RemoteTaskSnapshot[]> {
    return this.sendJson("GET", "/api/v1/tasks");
  }

  async createTask(req: RemoteTaskCreateRequest): Promise<RemoteTaskSnapshot> {
    return this.sendJson("POST", "/api/v1/tasks", req);
  }

  async getTask(taskId: string): Promise<RemoteTaskSnapshot> {
    return this.sendJson("GET", `/api/v1/tasks/${encodeURIComponent(taskId)}`);
  }

  async cancelTask(taskId: string): Promise<RemoteTaskSnapshot> {
    return this.sendJson("POST", `/api/v1/tasks/${encodeURIComponent(taskId)}/cancel`);
  }

  // ----------------------------------------------------------------
  // Interactions (auth)
  // ----------------------------------------------------------------

  async getInteractions(): Promise<RemoteInteractionSnapshot[]> {
    return this.sendJson("GET", "/api/v1/interactions");
  }

  async getInteraction(interactionId: string): Promise<RemoteInteractionSnapshot> {
    return this.sendJson("GET", `/api/v1/interactions/${encodeURIComponent(interactionId)}`);
  }

  async respondInteraction(
    interactionId: string,
    response: RemoteInteractionResponse,
  ): Promise<RemoteInteractionSnapshot> {
    return this.sendJson("POST", `/api/v1/interactions/${encodeURIComponent(interactionId)}/response`, response);
  }

  // ----------------------------------------------------------------
  // Event stream (WSS)
  // ----------------------------------------------------------------

  /** Build the WSS URL for the event stream. `after` is the last seen seq. */
  getEventStreamUrl(after?: number): string {
    const wsBase = this.baseUrl.replace(/^https/, "wss").replace(/^http/, "ws");
    return after != null ? `${wsBase}/api/v1/events?after=${after}` : `${wsBase}/api/v1/events`;
  }

  getConversationEventStreamUrl(after?: number): string {
    const wsBase = this.baseUrl.replace(/^https/, "wss").replace(/^http/, "ws");
    const query = after != null ? `?after=${after}` : "";
    return `${wsBase}/api/v2/events/stream${query}`;
  }

  // ----------------------------------------------------------------
  // Conversations v2 (auth) — server-authoritative durable transcripts.
  // The gateway answers 503 on every v2 route until schema v3 storage and
  // the probe-proven Pi session runtime are both healthy.
  // ----------------------------------------------------------------

  async getConversationCapabilities(): Promise<RemoteConversationCapabilities> {
    return this.sendJson("GET", "/api/v2/capabilities");
  }

  async listConversations(): Promise<RemoteConversationListResponse> {
    return this.sendJson("GET", "/api/v2/conversations");
  }

  async createConversation(req: RemoteConversationCreateRequest): Promise<RemoteConversationCreateResponse> {
    return this.sendJson("POST", "/api/v2/conversations", req);
  }

  async getConversation(conversationId: string): Promise<RemoteConversationSnapshot> {
    return this.sendJson("GET", `/api/v2/conversations/${encodeURIComponent(conversationId)}`);
  }

  async getConversationMessages(
    conversationId: string,
    after?: number,
    limit?: number,
  ): Promise<RemoteMessagePageResponse> {
    const params = new URLSearchParams();
    if (after != null) params.set("after", String(after));
    if (limit != null) params.set("limit", String(limit));
    const qs = params.toString();
    return this.sendJson(
      "GET",
      `/api/v2/conversations/${encodeURIComponent(conversationId)}/messages${qs ? `?${qs}` : ""}`,
    );
  }

  async appendTurn(conversationId: string, req: RemoteTurnAppendRequest): Promise<RemoteTurnAppendResponse> {
    return this.sendJson("POST", `/api/v2/conversations/${encodeURIComponent(conversationId)}/turns`, req);
  }

  async cancelTurn(turnId: string, requestId: string): Promise<RemoteTurnCancelResponse> {
    return this.sendJson("POST", `/api/v2/turns/${encodeURIComponent(turnId)}/cancel`, { requestId });
  }

  async archiveConversation(
    conversationId: string,
    requestId: string,
  ): Promise<{ conversation: RemoteConversationSnapshot; duplicate: boolean }> {
    return this.sendJson(
      "POST",
      `/api/v2/conversations/${encodeURIComponent(conversationId)}/archive`,
      { requestId },
    );
  }

  /**
   * REST replay of v2 semantic events (owner-scoped). `snapshotRequired`
   * means the cursor is no longer covered by the retained sequence space —
   * the caller must refetch authoritative snapshots instead of trusting the
   * partial tail.
   */
  async getConversationEvents(after?: number): Promise<ConversationEventsReplay> {
    const qs = after != null ? `?after=${after}` : "";
    return this.sendJson("GET", `/api/v2/events${qs}`);
  }

  // ----------------------------------------------------------------
  // Core request helper
  // ----------------------------------------------------------------

  private async sendJson<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    opts?: { skipAuth?: boolean },
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    if (!opts?.skipAuth) {
      const auth = this.getAuth();
      if (!auth) {
        throw new NetError("auth_failed", "No device token — pairing has not been completed.");
      }
      headers["x-pi-device-id"] = auth.deviceId;
      headers["Authorization"] = `Bearer ${auth.token}`;
    }

    let res;
    try {
      res = await this.transport.request({
        url,
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        timeoutMs: 15000,
      });
    } catch (error) {
      // Native SecureNet rejects with `{ status, kind, message }`, while
      // browser transports normally reject with an Error. Normalize both
      // here so callers never lose pin/network/timeout classification.
      if (error instanceof NetError) throw error;
      const nativeError = error as {
        kind?: unknown;
        status?: unknown;
        message?: unknown;
      };
      const status =
        typeof nativeError.status === "string"
          ? nativeError.status
          : typeof nativeError.kind === "string"
            ? nativeError.kind
            : "unknown";
      const message =
        typeof nativeError.message === "string"
          ? nativeError.message
          : error instanceof Error
            ? error.message
            : undefined;
      throw classifyError(status, message);
    }

    if (res.status >= 200 && res.status < 300) {
      return res.body ? (JSON.parse(res.body) as T) : (undefined as T);
    }

    // Non-2xx → classify into NetError
    let rawMessage: string | undefined;
    try {
      const errBody = JSON.parse(res.body);
      rawMessage = errBody.error ?? errBody.message;
    } catch {
      rawMessage = res.body || undefined;
    }
    throw classifyError(res.status, rawMessage);
  }
}

/** Wire shape of `GET /api/v2/events` (see gateway conversation_routes). */
export interface ConversationEventsReplay {
  readonly events: readonly RemoteConversationEvent[];
  readonly snapshotRequired: boolean;
  readonly nextCursor?: string;
}

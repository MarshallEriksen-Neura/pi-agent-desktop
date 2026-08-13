/**
 * Network error taxonomy — a single discriminated union that the UI maps to
 * user-facing states. Every error carries enough context for the error
 * screen to explain "what happened" and "what to do next" (design §3).
 */

export type NetErrorKind =
  | "offline"
  | "unreachable"
  | "auth_failed"
  | "identity_rotated"
  | "pin_mismatch"
  | "pin_not_registered"
  | "rate_limited"
  | "not_found"
  | "timeout"
  | "server_error"
  | "queue_full"
  | "project_unavailable"
  | "project_revoked"
  | "invalid_context"
  | "prompt_too_long"
  | "unknown";

export class NetError extends Error {
  constructor(
    readonly kind: NetErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "NetError";
  }
}

/**
 * Map an HTTP status code (or a native plugin error code) to a NetErrorKind.
 * The native plugin rejects with code strings like "pin_mismatch",
 * "unreachable", "timeout" — those are passed through directly.
 */
export function classifyError(status: number | string, rawMessage?: string): NetError {
  const message = rawMessage ?? `request failed (${status})`;

  // Domain-specific error codes returned by the gateway in the response body
  // (e.g. `{ "error": "queue_full" }`). These take precedence over the generic
  // HTTP status mapping because they carry the precise failure reason.
  const domainCode = mapDomainErrorCode(rawMessage);
  if (domainCode) {
    return new NetError(domainCode, domainMessage(domainCode), typeof status === "number" ? status : undefined);
  }

  // Native plugin error codes (string)
  if (typeof status === "string") {
    switch (status) {
      case "pin_mismatch":
        return new NetError("pin_mismatch", "证书指纹不匹配，可能存在中间人攻击或桌面身份已变更。请重新配对。", undefined);
      case "pin_not_registered":
        return new NetError("pin_not_registered", "证书锁定尚未建立，请重新扫描桌面端二维码。", undefined);
      case "unreachable":
        return new NetError("unreachable", "无法连接到桌面端，请确认两台设备在同一局域网且桌面端已启用远程控制。");
      case "timeout":
        return new NetError("timeout", "连接超时，请检查网络后重试。");
      case "invalid_endpoint":
      case "invalid_url":
        return new NetError("unknown", "桌面端连接地址无效，请重新生成二维码并配对。");
      default:
        return new NetError("unknown", message);
    }
  }

  // HTTP status codes
  switch (status) {
    case 0:
      return new NetError("offline", "网络不可用，请检查 Wi-Fi 或局域网连接。");
    case 401:
      // 401 can be auth_failed (bad token) or identity_rotated (epoch mismatch).
      // The /me endpoint returns identityEpoch; a mismatch is identity_rotated.
      return new NetError(
        rawMessage?.includes("identity") || rawMessage?.includes("epoch")
          ? "identity_rotated"
          : "auth_failed",
        rawMessage?.includes("identity")
          ? "桌面端身份已重置，当前设备令牌已失效。请重新配对。"
          : "设备令牌无效或已过期。请在桌面端撤销此设备后重新配对。",
        401,
      );
    case 403:
      return new NetError("auth_failed", "当前设备无权访问此资源。请检查桌面端授权设置。", 403);
    case 404:
      return new NetError("not_found", "请求的资源不存在。可能已被移除或路径已变更。", 404);
    case 429:
      return new NetError("rate_limited", "操作过于频繁，请稍后重试。", 429);
    case 500:
    case 502:
    case 503:
      return new NetError("server_error", "桌面端服务暂时不可用，请稍后重试。", status);
    default:
      return new NetError("unknown", message, status);
  }
}

// ----------------------------------------------------------------
// Domain error code helpers
// ----------------------------------------------------------------

const DOMAIN_ERROR_CODES: ReadonlySet<string> = new Set([
  "queue_full",
  "project_unavailable",
  "project_revoked",
  "invalid_context",
  "prompt_too_long",
]);

/**
 * If the raw message is a known domain error code (returned by the gateway in
 * the JSON error body), return it as a NetErrorKind. Otherwise return null.
 */
function mapDomainErrorCode(rawMessage?: string): NetErrorKind | null {
  if (!rawMessage) return null;
  if (DOMAIN_ERROR_CODES.has(rawMessage)) return rawMessage as NetErrorKind;
  return null;
}

function domainMessage(kind: NetErrorKind): string {
  switch (kind) {
    case "queue_full":
      return "任务队列已满，请等待现有任务完成后再试。";
    case "project_unavailable":
      return "项目暂不可用，可能已被移除。";
    case "project_revoked":
      return "项目授权已被撤销，无法继续操作。";
    case "invalid_context":
      return "部分上下文文件无效或不存在。";
    case "prompt_too_long":
      return "任务提示过长，超出服务器限制。";
    default:
      return "操作失败。";
  }
}

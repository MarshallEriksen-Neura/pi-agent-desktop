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

  // Native plugin error codes (string)
  if (typeof status === "string") {
    switch (status) {
      case "pin_mismatch":
        return new NetError("pin_mismatch", "证书指纹不匹配，可能存在中间人攻击或桌面身份已变更。请重新配对。", undefined);
      case "unreachable":
        return new NetError("unreachable", "无法连接到桌面端，请确认两台设备在同一局域网且桌面端已启用远程控制。");
      case "timeout":
        return new NetError("timeout", "连接超时，请检查网络后重试。");
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

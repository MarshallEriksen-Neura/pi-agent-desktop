import { useCallback, useState } from "react";
import type { PairingQrPayload } from "@pi/remote-control-contracts";
import { useConnectionStore } from "@/stores/connection.store";

/**
 * usePairing — drives the 8-state pairing flow:
 *
 *  idle → scanning → validating → connecting → success
 *                                    ↓
 *                        expired | unsupported | unreachable
 *                        pinMismatch | rateLimited | failed
 *
 * The hook is deliberately decoupled from the QR capture mechanism —
 * `scanResult` is set by the caller (camera scanner or manual entry),
 * then `pair()` kicks off the network flow.
 */

export type PairingState =
  | "idle"
  | "scanning"
  | "validating"
  | "connecting"
  | "success"
  | "expired"
  | "unsupported"
  | "unreachable"
  | "pinMismatch"
  | "rateLimited"
  | "failed";

/**
 * pinMismatch 时的取证材料:上次配对记下的指纹 vs 这次收到的指纹。
 *
 * 这两个值是用户判断「桌面端重装了 pi」还是「有人在中间冒充」的唯一依据。
 * 不把它们摆出来,`信任新证书` 就是一次盲选。
 */
export interface PinConflict {
  readonly expected: string;
  readonly actual: string;
  /** 触发冲突的 payload,用于用户确认信任后重放配对。 */
  readonly payload: PairingQrPayload;
}

export function usePairing() {
  const [state, setState] = useState<PairingState>("idle");
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [pinConflict, setPinConflict] = useState<PinConflict | null>(null);
  const pairAction = useConnectionStore((s) => s.pair);
  const connectAction = useConnectionStore((s) => s.connect);
  const forgetAction = useConnectionStore((s) => s.forget);

  const pair = useCallback(
    async (payload: PairingQrPayload) => {
      // Validate the QR payload structure first
      if (!payload || payload.protocol !== "pi.remote-control" || !payload.pairingId || !payload.secret) {
        setState("unsupported");
        return;
      }

      // Check expiry
      if (payload.expiresAt && new Date(payload.expiresAt).getTime() < Date.now()) {
        setState("expired");
        return;
      }

      setState("validating");

      const deviceName = "Mobile Device";
      const platform = typeof navigator !== "undefined" && /android/i.test(navigator.userAgent)
        ? "android"
        : "ios";

      const ok = await pairAction(payload, deviceName, platform);

      if (ok) {
        setState("success");
        // Auto-connect after a brief success display
        setTimeout(() => void connectAction(), 800);
      } else {
        // Map store errors to pairing states
        const store = useConnectionStore.getState();
        const err = store.lastErrorKind ?? store.lastError ?? "failed";
        const stateMap: Record<string, PairingState> = {
          invalid_ticket: "expired",
          rate_limited: "rateLimited",
          identity_unavailable: "unreachable",
          pin_mismatch: "pinMismatch",
          pin_not_registered: "pinMismatch",
          unreachable: "unreachable",
          offline: "unreachable",
          timeout: "unreachable",
          server_error: "failed",
          auth_failed: "expired",
        };
        const next = stateMap[err] ?? "failed";
        setState(next);
        setErrorDetail(store.lastError ?? err);

        // 指纹冲突:留下两侧指纹供 UI 逐段比对。旧指纹来自上次配对的
        // StoredConnection;没有 stored 说明是首次配对就被拒(pin 未注册),
        // 此时无从对比,UI 会退回纯文案警告。
        if (next === "pinMismatch") {
          const expected = store.stored?.certificatePin.value;
          const actual = payload.certificatePin?.value;
          setPinConflict(
            expected && actual ? { expected, actual, payload } : null,
          );
        }
      }
    },
    [pairAction, connectAction],
  );

  /**
   * 用户看过指纹差异后确认「确实是我重装了 pi」。
   *
   * 先 forget 清掉旧 pin(否则原生层会继续用旧 pin 拒绝握手),再用同一个
   * payload 重放配对。这条路径只应由长按确认触发 —— 单击不可达。
   */
  const trustNewCertificate = useCallback(async () => {
    const conflict = pinConflict;
    if (!conflict) return;
    setPinConflict(null);
    setErrorDetail(null);
    await forgetAction();
    await pair(conflict.payload);
  }, [pinConflict, forgetAction, pair]);

  const reset = useCallback(() => {
    setState("idle");
    setErrorDetail(null);
    setPinConflict(null);
  }, []);

  return {
    state,
    errorDetail,
    pinConflict,
    pair,
    reset,
    setState,
    trustNewCertificate,
  };
}

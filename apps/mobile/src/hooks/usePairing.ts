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

export function usePairing() {
  const [state, setState] = useState<PairingState>("idle");
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const pairAction = useConnectionStore((s) => s.pair);
  const connectAction = useConnectionStore((s) => s.connect);

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
        setState(stateMap[err] ?? "failed");
        setErrorDetail(store.lastError ?? err);
      }
    },
    [pairAction, connectAction],
  );

  const reset = useCallback(() => {
    setState("idle");
    setErrorDetail(null);
  }, []);

  return { state, errorDetail, pair, reset, setState };
}

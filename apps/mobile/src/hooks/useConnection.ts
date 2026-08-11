import { useEffect, useMemo } from "react";
import { useConnectionStore, type ConnectionPhase } from "@/stores/connection.store";

/**
 * useConnection — subscribes to the connection store and exposes a memoized
 * phase + actions. Also triggers an auto-connect on mount when a stored
 * connection exists (so the user returns to a live session).
 */
export function useConnection() {
  const stored = useConnectionStore((s) => s.stored);
  const phase = useConnectionStore((s) => s.phase);
  const lastError = useConnectionStore((s) => s.lastError);
  const connect = useConnectionStore((s) => s.connect);
  const disconnect = useConnectionStore((s) => s.disconnect);
  const wake = useConnectionStore((s) => s.wake);
  const forget = useConnectionStore((s) => s.forget);
  const loadStored = useConnectionStore((s) => s.loadStored);

  // On mount: load stored connection, auto-connect if present.
  useEffect(() => {
    void (async () => {
      const has = await loadStored();
      if (has) {
        await connect();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isOnline = phase === "online";
  const isReconnecting = phase === "reconnecting";
  const isWaking = phase === "waking";
  const isIdentityFailed = phase === "identity_failed";

  return useMemo(
    () => ({
      stored,
      phase,
      lastError,
      isOnline,
      isReconnecting,
      isWaking,
      isIdentityFailed,
      connect: () => void connect(),
      wake: () => void wake(),
      disconnect,
      forget: () => void forget(),
    }),
    [stored, phase, lastError, isOnline, isReconnecting, isWaking, isIdentityFailed, connect, wake, disconnect, forget],
  );
}

export type { ConnectionPhase };

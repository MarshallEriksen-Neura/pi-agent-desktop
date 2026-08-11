import type { PairingState } from "@/hooks/usePairing";

/**
 * The camera runs only in the initial scan state. Pairing errors must remain
 * visible until the user explicitly asks to retry; otherwise the scanner
 * immediately covers the error screen again.
 */
export function shouldEnablePairingScanner(state: PairingState): boolean {
  return state === "idle";
}

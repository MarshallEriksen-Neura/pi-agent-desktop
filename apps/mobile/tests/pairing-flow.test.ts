import { describe, expect, it } from "vitest";
import type { PairingState } from "@/hooks/usePairing";
import { shouldEnablePairingScanner } from "@/security/pairing-flow";

describe("pairing scanner lifecycle", () => {
  it("runs only while waiting for a fresh QR scan", () => {
    expect(shouldEnablePairingScanner("idle")).toBe(true);

    const nonScanningStates: PairingState[] = [
      "scanning",
      "validating",
      "connecting",
      "success",
      "expired",
      "unsupported",
      "unreachable",
      "pinMismatch",
      "rateLimited",
      "failed",
    ];

    for (const state of nonScanningStates) {
      expect(shouldEnablePairingScanner(state)).toBe(false);
    }
  });
});

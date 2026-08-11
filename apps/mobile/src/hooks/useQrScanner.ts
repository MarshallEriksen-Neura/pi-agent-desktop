import { useCallback, useEffect, useRef, useState } from "react";
import {
  BarcodeScanner,
  BarcodeFormat,
  type CameraPermissionState,
} from "@capacitor-mlkit/barcode-scanning";
import type { PluginListenerHandle } from "@capacitor/core";
import { setScannerPresentationActive } from "@/security/scanner-presentation";

/**
 * useQrScanner — native QR camera scanner backed by ML Kit Barcode Scanning.
 *
 * Lifecycle (P0-secured):
 *  - On mount (native only, when `enabled`), checks camera permission:
 *      `granted` → start scan immediately
 *      `prompt`  → request permission; granted → scan, denied → permanently_denied
 *      `denied`  → permanently_denied (user must open system settings)
 *  - On the first valid `barcodesScanned` event, **stops the camera immediately**
 *    and forwards `rawValue` to the `onResult` callback. Stopping on first hit
 *    is the primary dedupe — the scanner cannot fire again after stop.
 *  - A 3s cooldown on the same rawValue is a belt-and-suspenders guard in case
 *    a stop is racing an in-flight event.
 *  - On `visibilitychange` to hidden (app backgrounded), the camera is released;
 *    on visible while still in `scanning` phase, it restarts.
 *  - On unmount, the listener is removed and `stopScan()` is called. This is
 *    the contract for "page leaves, component unmounts" — no leaked camera.
 *
 * Browser dev mode: the hook reports `phase: "unsupported"` and no-ops, so the
 * PairingPage falls through to the dev-only manual JSON entry. The production
 * network stack is the native APK — the browser is never shipped.
 */
export type ScannerPhase =
  | "idle"
  | "requesting_permission"
  | "scanning"
  | "denied"
  | "permanently_denied"
  | "unsupported";

export interface UseQrScannerOptions {
  /** Called with the raw QR string on a successful, deduped scan. */
  onResult: (rawValue: string) => void;
  /** When false, the hook stays idle (no camera). Default true. */
  enabled?: boolean;
}

const isNative =
  typeof window !== "undefined" && "Capacitor" in window;

/** Cooldown window for same-value dedupe (ms). */
const DEDUPE_WINDOW_MS = 3_000;

export function useQrScanner(opts: UseQrScannerOptions) {
  const { onResult, enabled = true } = opts;
  const [phase, setPhase] = useState<ScannerPhase>(
    isNative ? "idle" : "unsupported",
  );

  const listenerRef = useRef<PluginListenerHandle | null>(null);
  const lastScanRef = useRef<{ value: string; time: number } | null>(null);
  const scanningRef = useRef(false);
  const onResultRef = useRef(onResult);

  // Keep the callback ref current without re-triggering the scan effect.
  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  const stop = useCallback(async () => {
    scanningRef.current = false;
    setScannerPresentationActive(false);
    if (listenerRef.current) {
      try {
        await listenerRef.current.remove();
      } catch {
        // listener may already be removed
      }
      listenerRef.current = null;
    }
    try {
      await BarcodeScanner.stopScan();
    } catch {
      // stopScan rejects if no scan is active — safe to swallow.
    }
  }, []);

  const startScan = useCallback(async () => {
    if (!isNative || scanningRef.current) return;
    scanningRef.current = true;
    // The native PreviewView sits behind Capacitor's WebView. Make the DOM
    // canvas transparent before starting CameraX so the preview is visible.
    setScannerPresentationActive(true);
    setPhase("scanning");

    try {
      // Register the barcodesScanned listener BEFORE startScan so no event
      // is lost between start and addListener.
      listenerRef.current = await BarcodeScanner.addListener(
        "barcodesScanned",
        (event) => {
          const barcodes = event.barcodes ?? [];
          for (const b of barcodes) {
            const raw = b.rawValue ?? b.displayValue;
            if (!raw) continue;

            // Dedupe: ignore the same value within the cooldown window.
            const now = Date.now();
            const last = lastScanRef.current;
            if (
              last &&
              last.value === raw &&
              now - last.time < DEDUPE_WINDOW_MS
            ) {
              continue;
            }
            lastScanRef.current = { value: raw, time: now };

            // Stop the camera on the first accepted result — the scanner
            // cannot fire again after this, which is the primary dedupe.
            void stop();

            onResultRef.current(raw);
            return;
          }
        },
      );

      await BarcodeScanner.startScan({
        formats: [BarcodeFormat.QrCode],
      });
    } catch {
      scanningRef.current = false;
      setScannerPresentationActive(false);
      setPhase("idle");
    }
  }, [stop]);

  const requestPermission = useCallback(async () => {
    if (!isNative) {
      setPhase("unsupported");
      return;
    }
    setPhase("requesting_permission");

    try {
      const status = await BarcodeScanner.checkPermissions();
      const current = status.camera as CameraPermissionState;

      if (current === "granted" || current === "limited") {
        await startScan();
        return;
      }

      // "prompt" means we haven't asked yet; "denied" means permanently denied
      // (Android: user selected "Don't ask again" or denied twice).
      if (current === "denied") {
        setPhase("permanently_denied");
        return;
      }

      // current === "prompt" — ask now.
      const after = await BarcodeScanner.requestPermissions();
      const next = after.camera as CameraPermissionState;
      if (next === "granted" || next === "limited") {
        await startScan();
      } else {
        // User denied the prompt — on Android this may become permanent
        // on the second denial, but we show the denied state either way;
        // the UI offers "open settings" for the permanently-denied path.
        setPhase("denied");
      }
    } catch {
      setPhase("idle");
    }
  }, [startScan]);

  const openSettings = useCallback(async () => {
    if (!isNative) return;
    try {
      await BarcodeScanner.openSettings();
    } catch {
      // openSettings can reject if the plugin isn't ready; non-fatal.
    }
  }, []);

  // Lifecycle: start on mount (native + enabled), stop on unmount.
  useEffect(() => {
    if (!enabled || !isNative) return;
    void requestPermission();
    return () => {
      void stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Visibility: release camera on background, restart on foreground.
  useEffect(() => {
    if (!isNative) return;
    const onVisibility = () => {
      if (document.hidden) {
        void stop();
      } else if (enabled && !scanningRef.current && phase === "scanning") {
        void startScan();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, phase, startScan, stop]);

  return {
    phase,
    isNative,
    startScan,
    stop,
    requestPermission,
    openSettings,
  };
}

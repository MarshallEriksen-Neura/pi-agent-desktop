"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "@/lib/i18n";
import { useRemoteControl } from "./store";
import { derivePhase } from "./status";
import { detectPrivateAddresses } from "./network-probe";
import { qrRemainingSeconds } from "./qr";
import { QR_COUNTDOWN_TICK_MS } from "./constants";
import type { RemoteControlPhase } from "./types";

/**
 * Coarse gateway phase for the overview badge. Combines the persisted status
 * with the in-flight `enabling` flag (`starting`) — see {@link derivePhase}.
 */
export function useRemoteControlPhase(): RemoteControlPhase {
  const status = useRemoteControl((s) => s.status);
  const enabling = useRemoteControl((s) => s.enabling);
  return useMemo(() => (enabling ? "starting" : derivePhase(status)), [
    status,
    enabling,
  ]);
}

/** Enable/disable toggle backed by the shared network-config draft. */
export function useRemoteControlToggle() {
  const t = useT();
  const enabled = useRemoteControl((s) => s.status?.enabled ?? false);
  const enabling = useRemoteControl((s) => s.enabling);
  const enable = useRemoteControl((s) => s.enable);
  const disable = useRemoteControl((s) => s.disable);
  const addresses = useRemoteControl((s) => s.draftAddresses);
  const port = useRemoteControl((s) => s.draftPort);
  const setAddresses = useRemoteControl((s) => s.setDraftAddresses);
  const reportError = useRemoteControl((s) => s.reportError);
  const [detecting, setDetecting] = useState(false);

  const toggle = useCallback(async () => {
    if (enabled) {
      await disable();
      return;
    }

    let selectedAddresses = addresses;
    if (selectedAddresses.length === 0) {
      setDetecting(true);
      try {
        const detected = await detectPrivateAddresses();
        // The network group may have completed its own probe while this one was
        // running. Prefer that newer selection before falling back to our result.
        const current = useRemoteControl.getState().draftAddresses;
        selectedAddresses = current.length > 0 ? current : detected;
        if (current.length === 0 && detected.length > 0) setAddresses(detected);
      } finally {
        setDetecting(false);
      }
    }

    if (selectedAddresses.length === 0) {
      reportError(t("settings.remoteControl.selectInterfaceFirst"));
      return;
    }

    await enable({ selectedAddresses, port });
  }, [
    enabled,
    enable,
    disable,
    addresses,
    port,
    reportError,
    setAddresses,
    t,
  ]);

  return { enabled, enabling: enabling || detecting, toggle };
}

/** Network-config draft + private-address auto-detection (design §13-1). */
export function useNetworkConfig() {
  const selected = useRemoteControl((s) => s.draftAddresses);
  const setSelected = useRemoteControl((s) => s.setDraftAddresses);
  const port = useRemoteControl((s) => s.draftPort);
  const setPort = useRemoteControl((s) => s.setDraftPort);
  const [detected, setDetected] = useState<string[]>([]);
  const [detecting, setDetecting] = useState(false);

  const detect = useCallback(async () => {
    setDetecting(true);
    try {
      const found = await detectPrivateAddresses();
      setDetected(found);
      // Auto-select all detected addresses on first run, when nothing is chosen yet.
      if (found.length > 0 && selected.length === 0) setSelected(found);
    } finally {
      setDetecting(false);
    }
  }, [selected.length, setSelected]);

  const toggle = useCallback(
    (addr: string) => {
      setSelected(
        selected.includes(addr)
          ? selected.filter((a) => a !== addr)
          : [...selected, addr],
      );
    },
    [selected, setSelected],
  );

  const addManual = useCallback(
    (addr: string) => {
      if (!selected.includes(addr)) setSelected([...selected, addr]);
    },
    [selected, setSelected],
  );

  return {
    detected,
    selected,
    port,
    setPort,
    detecting,
    detect,
    toggle,
    addManual,
  };
}

/** Paired-device list + per-row revoke tracking. */
export function usePairedDevices() {
  const devices = useRemoteControl((s) => s.status?.pairedDevices ?? EMPTY);
  const revoke = useRemoteControl((s) => s.revokeDevice);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const revokeDevice = useCallback(
    async (deviceId: string) => {
      setRevokingId(deviceId);
      try {
        return await revoke(deviceId);
      } finally {
        setRevokingId(null);
      }
    },
    [revoke],
  );

  return { devices, count: devices.length, revokeDevice, revokingId };
}

/** Authorized-project list + add/remove with a single busy guard. */
export function useAuthorizedProjects() {
  const projects = useRemoteControl((s) => s.status?.projects ?? EMPTY);
  const allow = useRemoteControl((s) => s.allowProject);
  const remove = useRemoteControl((s) => s.removeProject);
  const [busy, setBusy] = useState(false);

  const allowProject = useCallback(
    async (path: string, name?: string) => {
      setBusy(true);
      try {
        return await allow({ path, name });
      } finally {
        setBusy(false);
      }
    },
    [allow],
  );

  const removeProject = useCallback(
    async (projectId: string) => {
      setBusy(true);
      try {
        return await remove(projectId);
      } finally {
        setBusy(false);
      }
    },
    [remove],
  );

  return { projects, count: projects.length, allowProject, removeProject, busy };
}

/**
 * Pairing QR lifecycle: payload, countdown, auto-poll for success.
 * The countdown ticks every second from the payload's `expiresAt`.
 */
export function usePairingQr() {
  const payload = useRemoteControl((s) => s.qrPayload);
  const state = useRemoteControl((s) => s.qrState);
  const regenerate = useRemoteControl((s) => s.generateQr);
  const polling = useRemoteControl((s) => s.pairingPolling);
  const startPoll = useRemoteControl((s) => s.startPairingPoll);
  const stopPoll = useRemoteControl((s) => s.stopPairingPoll);
  const [countdown, setCountdown] = useState(0);

  // Per-second countdown while a live QR is showing.
  useEffect(() => {
    if (!payload || state !== "ready") return;
    const tick = () => setCountdown(qrRemainingSeconds(payload.expiresAt));
    tick();
    const id = window.setInterval(tick, QR_COUNTDOWN_TICK_MS);
    return () => window.clearInterval(id);
  }, [payload, state]);

  // Auto-poll for pairing success the moment a QR is ready (design §13-3).
  useEffect(() => {
    if (state === "ready" && !polling) startPoll();
  }, [state, polling, startPoll]);

  // Stop the poll on unmount so navigating away from the modal halts it.
  useEffect(() => stopPoll, [stopPoll]);

  return { payload, state, countdown, regenerate, polling };
}

/**
 * Generic one-shot action wrapper: busy + error + result, with guard against
 * duplicate submission while in flight.
 */
export function useRemoteControlAction<TArgs extends unknown[], TResult>(
  handler: (...args: TArgs) => Promise<TResult>,
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (...args: TArgs): Promise<TResult | null> => {
      setBusy(true);
      setError(null);
      try {
        return await handler(...args);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [handler],
  );

  const reset = useCallback(() => setError(null), []);
  return { run, busy, error, reset };
}

const EMPTY: readonly never[] = Object.freeze([]);

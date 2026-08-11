import { useEffect, useState } from "react";

/**
 * useExpiryCountdown — returns the remaining seconds until `expiresAt`,
 * ticking once per second. Returns `null` when the ISO timestamp is absent
 * or already past. Designed for interaction expiry UI: the value is purely
 * cosmetic (the server is authoritative for expiry), so a low-frequency tick
 * is sufficient.
 */
export function useExpiryCountdown(expiresAt?: string): number | null {
  const compute = (): number | null => {
    if (!expiresAt) return null;
    const ms = new Date(expiresAt).getTime() - Date.now();
    return ms > 0 ? Math.ceil(ms / 1000) : 0;
  };
  const [remaining, setRemaining] = useState<number | null>(compute);

  useEffect(() => {
    setRemaining(compute());
    if (!expiresAt) return;
    const id = setInterval(() => {
      const next = compute();
      setRemaining(next);
      if (next === 0) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt]);

  return remaining;
}

/** Format seconds as M:SS for display. */
export function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

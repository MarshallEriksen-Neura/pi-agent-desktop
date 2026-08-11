import type { WakeOnLanConfig, WakeOnLanTarget } from "@pi/remote-control-contracts";

const MAX_WAKE_TARGETS = 8;
const MAC_PATTERN = /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/;

export function isValidWakeOnLanConfig(value: unknown): value is WakeOnLanConfig {
  if (!value || typeof value !== "object") return false;
  const targets = (value as { targets?: unknown }).targets;
  return (
    Array.isArray(targets) &&
    targets.length > 0 &&
    targets.length <= MAX_WAKE_TARGETS &&
    targets.every(isValidWakeOnLanTarget)
  );
}

export function isValidWakeOnLanTarget(value: unknown): value is WakeOnLanTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Partial<WakeOnLanTarget>;
  return (
    typeof target.macAddress === "string" &&
    isUsableMacAddress(target.macAddress) &&
    typeof target.broadcastAddress === "string" &&
    isAllowedBroadcastAddress(target.broadcastAddress)
  );
}

export function isUsableMacAddress(value: string): boolean {
  if (!MAC_PATTERN.test(value)) return false;
  const bytes = value.split(":").map((part) => Number.parseInt(part, 16));
  return (
    (bytes[0] & 1) === 0 &&
    !bytes.every((byte) => byte === 0) &&
    !bytes.every((byte) => byte === 0xff)
  );
}

export function isAllowedBroadcastAddress(value: string): boolean {
  const octets = parseIpv4(value);
  if (!octets) return false;
  if (octets.every((octet) => octet === 255)) return true;
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN;
    return Number(part);
  });
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : null;
}

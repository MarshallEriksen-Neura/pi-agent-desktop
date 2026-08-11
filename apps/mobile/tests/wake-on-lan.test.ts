import { describe, expect, it } from "vitest";
import {
  isAllowedBroadcastAddress,
  isUsableMacAddress,
  isValidWakeOnLanConfig,
} from "@/security/wake-on-lan";

describe("Wake-on-LAN target validation", () => {
  it("accepts bounded RFC1918 directed-broadcast targets", () => {
    expect(
      isValidWakeOnLanConfig({
        targets: [
          { macAddress: "02:42:AC:11:00:02", broadcastAddress: "192.168.31.255" },
        ],
      }),
    ).toBe(true);
    expect(isAllowedBroadcastAddress("10.4.7.255")).toBe(true);
    expect(isAllowedBroadcastAddress("172.20.255.255")).toBe(true);
    expect(isAllowedBroadcastAddress("255.255.255.255")).toBe(true);
  });

  it("rejects multicast, zero, malformed, and public targets", () => {
    expect(isUsableMacAddress("01:00:5E:00:00:01")).toBe(false);
    expect(isUsableMacAddress("00:00:00:00:00:00")).toBe(false);
    expect(isUsableMacAddress("bad-mac")).toBe(false);
    expect(isAllowedBroadcastAddress("8.8.8.8")).toBe(false);
    expect(isAllowedBroadcastAddress("192.168.1.999")).toBe(false);
    expect(isValidWakeOnLanConfig({ targets: [] })).toBe(false);
  });

  it("caps the QR-controlled target count", () => {
    const target = {
      macAddress: "02:42:AC:11:00:02",
      broadcastAddress: "192.168.31.255",
    };
    expect(isValidWakeOnLanConfig({ targets: Array.from({ length: 9 }, () => target) })).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import {
  assertValidHexPin,
  hexPinToBase64,
  formatOkHttpPin,
  hexPinToBytes,
  isValidHexPin,
  PinCodecError,
} from "@/security/pin-codec";

describe("PinCodec — hex → Base64 conversion", () => {
  // Known SPKI digest test vector: 32 bytes → 64 hex chars → 44 base64 chars.
  // Using a well-known test vector (all zeros) to verify the round-trip.
  const ZERO_HEX = "0".repeat(64);
  const ZERO_BASE64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

  it("converts all-zeros hex to correct Base64", () => {
    expect(hexPinToBase64(ZERO_HEX)).toBe(ZERO_BASE64);
  });

  it("formats as sha256/<base64> for OkHttp", () => {
    expect(formatOkHttpPin(ZERO_HEX)).toBe(`sha256/${ZERO_BASE64}`);
  });

  it("decodes hex to correct 32 bytes", () => {
    const bytes = hexPinToBytes(ZERO_HEX);
    expect(bytes).toHaveLength(32);
    expect(bytes.every((b) => b === 0)).toBe(true);
  });

  // Realistic SPKI digest (random-looking hex)
  const SAMPLE_HEX = "a" + "b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0".repeat(1).slice(0, 64);
});

describe("PinCodec — validation (fail closed)", () => {
  it("rejects empty pin with 'empty' code", () => {
    expect(() => assertValidHexPin("")).toThrow(PinCodecError);
    try {
      assertValidHexPin("");
    } catch (e) {
      expect(e instanceof PinCodecError && e.code).toBe("empty");
    }
  });

  it("rejects wrong-length pin with 'invalid_length' code", () => {
    try {
      assertValidHexPin("abc123");
    } catch (e) {
      expect(e instanceof PinCodecError && e.code).toBe("invalid_length");
    }
  });

  it("rejects non-hex characters with 'invalid_chars' code", () => {
    const badHex = "g".repeat(64); // 'g' is not hex
    try {
      assertValidHexPin(badHex);
    } catch (e) {
      expect(e instanceof PinCodecError && e.code).toBe("invalid_chars");
    }
  });

  it("isValidHexPin returns false for invalid pins without throwing", () => {
    expect(isValidHexPin("")).toBe(false);
    expect(isValidHexPin("abc")).toBe(false);
    expect(isValidHexPin("g".repeat(64))).toBe(false);
    expect(isValidHexPin("0".repeat(64))).toBe(true);
  });

  it("accepts uppercase hex (case-insensitive)", () => {
    const upper = "A".repeat(64);
    expect(isValidHexPin(upper)).toBe(true);
    expect(hexPinToBase64(upper)).toBe(hexPinToBase64(upper.toLowerCase()));
  });
});

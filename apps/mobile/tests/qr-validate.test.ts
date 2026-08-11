import { describe, it, expect } from "vitest";
import { validatePairingPayload, parseAndValidateQr } from "@/security/qr-validate";
import type { PairingQrPayload } from "@pi/remote-control-contracts";

function makeValidPayload(overrides: Partial<PairingQrPayload> = {}): PairingQrPayload {
  return {
    protocol: "pi.remote-control",
    version: 1,
    desktop: { desktopId: "desk-1", displayName: "My Pi" },
    endpoints: [{ scheme: "https", host: "192.168.1.10", port: 8443 }],
    pairingId: "pair-abc",
    secret: "secret-xyz",
    certificatePin: { algorithm: "spki-sha256", value: "0".repeat(64) },
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    wakeOnLan: {
      targets: [
        { macAddress: "02:42:AC:11:00:02", broadcastAddress: "192.168.1.255" },
      ],
    },
    ...overrides,
  };
}

describe("QR payload validation", () => {
  it("accepts a valid payload", () => {
    const payload = makeValidPayload();
    const result = validatePairingPayload(payload);
    expect(result.code).toBe("ok");
    expect(result.payload).not.toBeNull();
  });

  it("rejects unsupported protocol", () => {
    const result = validatePairingPayload(makeValidPayload({ protocol: "other" as never }));
    expect(result.code).toBe("unsupported_protocol");
    expect(result.payload).toBeNull();
  });

  it("rejects missing pairingId", () => {
    const result = validatePairingPayload(makeValidPayload({ pairingId: "" }));
    expect(result.code).toBe("missing_pairingId");
  });

  it("rejects missing secret", () => {
    const result = validatePairingPayload(makeValidPayload({ secret: "" }));
    expect(result.code).toBe("missing_secret");
  });

  it("rejects missing certificatePin", () => {
    const result = validatePairingPayload(
      makeValidPayload({ certificatePin: { algorithm: "spki-sha256", value: "" } }),
    );
    expect(result.code).toBe("missing_certificatePin");
  });

  it("rejects missing endpoints", () => {
    const result = validatePairingPayload(makeValidPayload({ endpoints: [] }));
    expect(result.code).toBe("missing_endpoints");
  });

  it("rejects when no HTTPS endpoint is available (fail closed — no cleartext fallback)", () => {
    const result = validatePairingPayload(
      makeValidPayload({ endpoints: [{ scheme: "wss", host: "192.168.1.10", port: 8443 }] }),
    );
    expect(result.code).toBe("no_https_endpoint");
  });

  it("rejects expired QR payload", () => {
    const expired = makeValidPayload({
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const result = validatePairingPayload(expired);
    expect(result.code).toBe("expired");
  });

  it("rejects unsupported version", () => {
    const result = validatePairingPayload(makeValidPayload({ version: 99 as never }));
    expect(result.code).toBe("unsupported_version");
  });

  it("rejects malformed or public-network wake targets", () => {
    const malformed = validatePairingPayload(
      makeValidPayload({
        wakeOnLan: {
          targets: [
            { macAddress: "not-a-mac", broadcastAddress: "192.168.1.255" },
          ],
        },
      }),
    );
    expect(malformed.code).toBe("invalid_wake_on_lan");

    const publicTarget = validatePairingPayload(
      makeValidPayload({
        wakeOnLan: {
          targets: [
            { macAddress: "02:42:AC:11:00:02", broadcastAddress: "8.8.8.8" },
          ],
        },
      }),
    );
    expect(publicTarget.code).toBe("invalid_wake_on_lan");
  });

  it("keeps wake-on-LAN optional for older desktops", () => {
    expect(validatePairingPayload(makeValidPayload({ wakeOnLan: undefined })).code).toBe("ok");
  });
});

describe("QR envelope parsing (parseAndValidateQr)", () => {
  it("parses a valid pi.remote-control:v1:<base64url> envelope", () => {
    const payload = makeValidPayload();
    const json = JSON.stringify(payload);
    const b64url = Buffer.from(json).toString("base64url");
    const raw = `pi.remote-control:v1:${b64url}`;
    const result = parseAndValidateQr(raw);
    expect(result.code).toBe("ok");
    expect(result.payload?.pairingId).toBe("pair-abc");
  });

  it("rejects non-Pi QR strings", () => {
    expect(parseAndValidateQr("https://example.com").code).toBe("unsupported_protocol");
    expect(parseAndValidateQr("other:v1:abc").code).toBe("unsupported_protocol");
  });

  it("rejects malformed base64url", () => {
    expect(parseAndValidateQr("pi.remote-control:v1:!!!invalid").code).toBe("unsupported_protocol");
  });

  it("rejects valid base64url of invalid JSON", () => {
    const b64url = Buffer.from("not json").toString("base64url");
    expect(parseAndValidateQr(`pi.remote-control:v1:${b64url}`).code).toBe("unsupported_protocol");
  });
});

import { describe, expect, it } from "vitest";
import { scannerErrorMessage } from "@/hooks/useQrScanner";

describe("QR scanner error details", () => {
  it("keeps native plugin messages visible", () => {
    expect(scannerErrorMessage({ message: "CameraX failed to bind" })).toBe(
      "CameraX failed to bind",
    );
  });

  it("keeps thrown Error messages visible", () => {
    expect(scannerErrorMessage(new Error("camera unavailable"))).toBe(
      "camera unavailable",
    );
  });

  it("uses a stable fallback when the plugin gives no detail", () => {
    expect(scannerErrorMessage(undefined)).toBe("scan_error");
  });
});

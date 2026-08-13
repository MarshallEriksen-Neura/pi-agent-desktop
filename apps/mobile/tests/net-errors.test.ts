import { describe, expect, it } from "vitest";
import { classifyError, NetError } from "@/net/errors";

describe("native network error classification", () => {
  it.each([
    ["pin_mismatch", "pin_mismatch"],
    ["unreachable", "unreachable"],
    ["timeout", "timeout"],
    ["pin_not_registered", "pin_not_registered"],
  ] as const)("preserves the native %s code", (code, expectedKind) => {
    const error = classifyError(code, `native detail for ${code}`);
    expect(error).toBeInstanceOf(NetError);
    expect(error.kind).toBe(expectedKind);
  });

  it("keeps the native diagnostic for an otherwise unknown error", () => {
    const error = classifyError("unknown", "connect failed: network is down");
    expect(error.kind).toBe("unknown");
    expect(error.message).toBe("connect failed: network is down");
  });
});

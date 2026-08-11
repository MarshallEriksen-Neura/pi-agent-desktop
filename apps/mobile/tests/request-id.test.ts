import { describe, it, expect } from "vitest";
import { generateRequestId, isValidRequestId } from "@/utils/request-id";

describe("RequestId — idempotent generation", () => {
  it("generates a valid UUID v4", () => {
    const id = generateRequestId();
    expect(isValidRequestId(id)).toBe(true);
  });

  it("generates unique ids on successive calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateRequestId());
    }
    expect(ids.size).toBe(100);
  });

  it("accepts valid UUID v4 format", () => {
    expect(isValidRequestId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("rejects invalid request ids", () => {
    expect(isValidRequestId("")).toBe(false);
    expect(isValidRequestId("not-a-uuid")).toBe(false);
    expect(isValidRequestId("550e8400-e29b-31d4-a716-446655440000")).toBe(false); // v3
    expect(isValidRequestId("550e8400-e29b-51d4-a716-446655440000")).toBe(false); // v5
  });
});

/**
 * RequestId generation — produces a stable UUID v4 for task submission
 * idempotency. The id is generated once per composer session and held in
 * state; a retry reuses it so the server deduplicates (returns the original
 * task instead of creating a duplicate).
 *
 * Format: RFC 4122 variant UUID v4 (8-4-4-4-12 hex, version nibble = 4,
 * variant bits = 10xx).
 */
export function generateRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Manual fallback for environments without crypto.randomUUID
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Validate that a string is a well-formed UUID v4. Used to verify idempotency
 * keys before submission.
 */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidRequestId(id: string): boolean {
  return UUID_V4_RE.test(id);
}

import type { RemoteControlStatusDto } from "@/lib/backend/ports";
import type { RemoteControlPhase } from "./types";

/**
 * Derive the coarse UI phase from the backend status snapshot.
 *
 * `starting` is intentionally NOT derived here — it reflects an in-flight
 * `enable`/`disable` operation rather than persisted state, so components pair
 * this with the store's operation-level `enabling` flag (see `useRemoteControlToggle`).
 */
export function derivePhase(status: RemoteControlStatusDto | null): RemoteControlPhase {
  if (!status || !status.enabled) return "disabled";
  if (status.lastError) return "fault";
  if (status.degraded) return "degraded";
  return "normal";
}

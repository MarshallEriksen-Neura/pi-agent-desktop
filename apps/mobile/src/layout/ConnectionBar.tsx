import { memo } from "react";
import { useNavigate } from "react-router-dom";
import type { ConnectionPhase } from "@/stores/connection.store";
import { SecureTetherBadge } from "@/components/SecureTether";

/**
 * ConnectionBar — a slim top bar showing the Secure Tether badge and the
 * desktop name. Tapping it navigates to Settings → Connection.
 *
 * Hidden when the phase is `idle` (pre-pairing) — the Onboarding/Pairing
 * pages render their own full-screen status.
 */
export const ConnectionBar = memo(function ConnectionBar({
  phase,
}: {
  phase: ConnectionPhase;
}) {
  const navigate = useNavigate();
  if (phase === "idle") return null;

  return (
    <button
      onClick={() => navigate("/settings")}
      style={{
        display: "flex",
        alignItems: "center",
        width: "100%",
        padding: "6px 16px",
        border: "none",
        borderBottom: "1px solid var(--color-separator)",
        background: "transparent",
        cursor: "pointer",
        fontFamily: "var(--font-ui)",
      }}
    >
      <SecureTetherBadge phase={phase} />
    </button>
  );
});

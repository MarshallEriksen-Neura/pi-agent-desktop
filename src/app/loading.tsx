/**
 * Route loading fallback — three pulsing dots in the agent's "thinking"
 * purple, the same semantic Pi uses while working. Deliberately quiet:
 * this UI flashes for a moment during navigation, so no card, no text.
 */
export default function Loading() {
  return (
    <div
      role="status"
      aria-label="Loading"
      style={{ height: "100%", display: "grid", placeItems: "center" }}
    >
      <div style={{ display: "flex", gap: 6 }}>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="pi-status-dot"
            style={{ animationDelay: `${i * 0.18}s` }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Route-transition fallback.
 *
 * Paints its own opaque surface and holds the chrome's shape. Both matter:
 *
 * - It used to style only the dots, so the fallback painted nothing and the
 *   nearest painted ancestor was `<body>` (`--bg-base`). Every destination page
 *   paints its own surface instead — /settings/ and /skills/ sit on
 *   `--bg-elevated`, /models/ on a gradient, /mcp/ on ink paper — so navigating
 *   flashed the page's ground color (measured: dark `rgb(0,0,0)` → `rgb(28,28,30)`,
 *   light `rgb(255,255,255)` → `rgb(242,242,247)`).
 * - Depending on `<body>` is not even safe: with a background image set,
 *   appearance.ts stamps `body { background: transparent !important }`. In the
 *   Tauri window (`transparent: true` + mica/acrylic) a fallback with no surface
 *   of its own then shows the OS material straight through — light on a light
 *   Windows theme, regardless of the app's own dark theme.
 *
 * Mirrors BootScreen's geometry (56px rail, 48px top band) so the rail does not
 * blink out and back mid-navigation. Structure and numbers live in globals.css
 * next to the boot screen's, since the two are one visual language.
 */
export default function Loading() {
  return (
    <div className="pi-route-loading" role="status" aria-label="Loading">
      <div className="pi-route-loading-topbar" data-tauri-drag-region />
      <div className="pi-route-loading-stage">
        <div className="pi-route-loading-dots" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="pi-status-dot"
              style={{ animationDelay: `${i * 0.18}s` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

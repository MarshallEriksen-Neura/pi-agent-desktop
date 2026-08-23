import { PiMark } from "@/components/PiMark";

/** NavRail ships exactly this many tabs — matching the count keeps the rail
 *  silhouette from resizing when the real one takes over. */
const RAIL_TABS = 7;

/**
 * First-paint placeholder for the app window.
 *
 * The shell renders nothing until BackendProvider resolves its container in a
 * client effect, so the prerendered `<body>` is empty and the window stayed
 * blank for the whole bundle-parse + hydrate stretch. This is static markup
 * inside that prerendered HTML — it paints with the stylesheet, before any JS
 * runs — and it mirrors the chrome that replaces it: a 56px rail carrying the
 * brand mark at the exact offset NavRail uses, and the 48px TopBar band. The
 * mark is the real `PiMark` SVG, not a grey box, so it does not move when the
 * shell mounts.
 *
 * `MainShell` stamps `data-app-ready` on `<html>` once the real shell has
 * painted, which cross-fades this out (see globals.css). It is never rendered in
 * the pet window: that window shares this layout but is a 200x250 transparent
 * overlay, so the pre-paint script in layout.tsx marks its shell and the CSS
 * keeps the boot screen out of it entirely.
 */
export function BootScreen() {
  return (
    <div id="pi-boot" aria-hidden="true">
      <div className="pi-boot-rail" data-tauri-drag-region>
        <PiMark size={30} withBackground style={{ marginBottom: 8 }} />
        {Array.from({ length: RAIL_TABS }, (_, i) => (
          <span key={i} className="pi-boot-slot" />
        ))}
      </div>
      <div className="pi-boot-main">
        <div className="pi-boot-topbar" data-tauri-drag-region />
        <div className="pi-boot-stage">
          <span className="pi-boot-mark">
            <PiMark size={52} />
          </span>
          {/* Same three pulsing dots app/loading.tsx uses for route transitions,
              so booting and navigating speak one visual language. */}
          <div className="pi-boot-dots">
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
    </div>
  );
}

/**
 * The native barcode preview is inserted behind Capacitor's WebView. The
 * WebView itself is made transparent by the ML Kit plugin, but CSS backgrounds
 * on `html` and `body` can still hide the camera completely.
 */
export const SCANNER_ACTIVE_CLASS = "pi-barcode-scanner-active";

type ScannerDocument = Pick<Document, "documentElement" | "body">;

export function setScannerPresentationActive(
  active: boolean,
  target: ScannerDocument | undefined =
    typeof document === "undefined" ? undefined : document,
): void {
  if (!target) return;

  target.documentElement.classList.toggle(SCANNER_ACTIVE_CLASS, active);
  target.body.classList.toggle(SCANNER_ACTIVE_CLASS, active);
}

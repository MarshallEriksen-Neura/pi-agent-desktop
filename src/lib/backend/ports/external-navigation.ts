export interface ExternalNavigationPort {
  open(url: string): Promise<void>;
  /**
   * Open a local .html/.htm file in the system browser as a file:// URL —
   * the "preview the page the agent just wrote" path. Scoped to HTML so the
   * port is not a generic open-anything primitive.
   */
  openHtmlFile(path: string): Promise<void>;
}

/** Default terminal drawer height before the user resizes it. */
export const TERMINAL_HEIGHT_DEFAULT = 240;
/** Header plus a couple of rows — below this the shell stops being usable. */
export const TERMINAL_HEIGHT_MIN = 120;

export interface TerminalHeightBounds {
  min: number;
  max: number;
}

/**
 * Keep the user's preferred height independent of the current window size.
 * The rendered drawer is clamped to the live workspace height instead, so a
 * preference made on a large display returns when the window grows again.
 */
export function clampTerminalHeightPreference(px: number): number {
  if (!Number.isFinite(px)) return TERMINAL_HEIGHT_DEFAULT;
  return Math.round(Math.max(TERMINAL_HEIGHT_MIN, px));
}

/**
 * Turn the live space below the top bar into drag bounds. There is deliberately
 * no fixed maximum: the terminal may occupy the complete workspace when the
 * user drags its seam to the top.
 */
export function terminalHeightBounds(availableHeight: number): TerminalHeightBounds {
  const room = Number.isFinite(availableHeight) && availableHeight > 0
    ? Math.floor(availableHeight)
    : TERMINAL_HEIGHT_DEFAULT;
  return {
    min: TERMINAL_HEIGHT_MIN,
    max: Math.max(TERMINAL_HEIGHT_MIN, room),
  };
}

/** Measure the workspace from its top edge to the bottom of the app shell. */
export function availableTerminalHeight(containerBottom: number, workspaceTop: number): number {
  const height = containerBottom - workspaceTop;
  return Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
}

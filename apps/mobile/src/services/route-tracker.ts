/**
 * Route tracker — module-level mirror of the active pathname so the
 * notification service can decide "is the user already looking at this?"
 * without coupling stores to the router.
 */

let currentPath = "";

export function setCurrentRoute(path: string): void {
  currentPath = path;
}

export function getCurrentRoute(): string {
  return currentPath;
}

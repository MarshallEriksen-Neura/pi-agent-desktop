import { useCallback } from "react";
import { tokenVault, type StoredConnection } from "@/security/token-vault";

/**
 * useSecureStorage — thin React wrapper around {@link tokenVault}. Exposes
 * load/save/clear for the connection record. Most callers should use
 * {@link useConnection} instead — this hook is for the settings page's
 * "forget" action and diagnostics.
 */
export function useSecureStorage() {
  const load = useCallback(() => tokenVault.load(), []);
  const save = useCallback((conn: StoredConnection) => tokenVault.save(conn), []);
  const clear = useCallback(() => tokenVault.clear(), []);

  return { load, save, clear };
}

import { useEffect, useState } from "react";
import { useConnectionStore } from "@/stores/connection.store";
import { NetError } from "@/net/errors";

/**
 * useCapabilities — fetches and caches the server capabilities
 * (GET /api/v1/capabilities). Only fetches when a client is available
 * (i.e. after connecting). The result is cached for the session.
 */

interface Capabilities {
  protocolVersion: number;
  maxRequestBodyBytes: number;
  maxQueueSize: number;
  maxActiveTasks: number;
  supportedInteractions: string[];
  project: {
    maxTreeEntriesPerPage: number;
    maxContextFiles: number;
    maxRelativePathBytes: number;
    fileBodyAvailable: boolean;
  };
}

export function useCapabilities() {
  const client = useConnectionStore((s) => s.client);
  const phase = useConnectionStore((s) => s.phase);
  const [data, setData] = useState<Capabilities | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client || phase !== "online") return;
    let cancelled = false;
    setLoading(true);
    client
      .getCapabilities()
      .then((caps) => {
        if (!cancelled) {
          setData(caps as Capabilities);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof NetError ? e.message : "failed");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, phase]);

  return { data, loading, error };
}

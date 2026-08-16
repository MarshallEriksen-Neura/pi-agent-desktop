import { memo, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { motion } from "motion/react";
import { AlertCircle, Check, FilePlus2, CheckCircle2 } from "lucide-react";
import { t } from "@/i18n";
import { useConnection } from "@/hooks/useConnection";
import { useConnectionStore } from "@/stores/connection.store";
import { useCapabilities } from "@/hooks/useCapabilities";
import {
  useTreeSelectionStore,
  selectIsSelected,
} from "@/stores/tree-selection.store";
import { StateView } from "@/components/primitives";
import { BlockButton, DetailHeader, DetailMeta } from "@/components/visual";
import { DetailSkeleton } from "@/components/skeleton";
import { OfflineView } from "@/components/connection-trouble";
import { NetError } from "@/net/errors";
import type { RemoteFileBody } from "@pi/remote-control-contracts";

/**
 * FileViewerPage — read-only text preview for one project file
 * (GET /api/v1/projects/:id/file). The gateway enforces the §4 policy
 * (deny list, symlink rejection, root containment) and only ships UTF-8
 * text, capped at the preview limit with a `truncated` flag.
 *
 * The sticky bar toggles this file into the shared tree selection so the
 * pick survives navigation back to ProjectTreePage.
 */
export const FileViewerPage = memo(function FileViewerPage() {
  const { projectId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const path = searchParams.get("path") ?? "";
  const navigate = useNavigate();
  const { isOnline, stored, connect, wake } = useConnection();
  const client = useConnectionStore((s) => s.client);
  const { data: capabilities } = useCapabilities();

  const [body, setBody] = useState<RemoteFileBody | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; binary: boolean } | null>(null);
  const [capHit, setCapHit] = useState(false);

  const maxFiles = capabilities?.project.maxContextFiles ?? 32;
  const isSelected = useTreeSelectionStore(selectIsSelected(projectId, path));

  useEffect(() => {
    if (!client || !path) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    client
      .getFileBody(projectId, path)
      .then((result) => {
        if (!cancelled) setBody(result);
      })
      .catch((e) => {
        if (cancelled) return;
        // 400 from the file endpoint is almost always the gateway refusing
        // binary/non-UTF-8 content — say that instead of a generic failure.
        const binary = e instanceof NetError && e.status === 400;
        const message = e instanceof NetError ? e.message : "fetch_failed";
        setError({ message, binary });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, projectId, path]);

  const lines = useMemo(() => (body ? body.content.split("\n") : []), [body]);

  const handleToggle = () => {
    const outcome = useTreeSelectionStore
      .getState()
      .toggle(projectId, path, maxFiles);
    setCapHit(outcome === "capped");
  };

  if (!isOnline) {
    return (
      <OfflineView
        canWake={Boolean(stored?.wakeOnLan?.targets.length)}
        cachedTasks={[]}
        onReconnect={connect}
        onWake={wake}
      />
    );
  }

  const fileName = path.split("/").pop() || path;

  return (
    <div className="page-scroll" style={{ paddingBottom: 96 }}>
      <DetailHeader title={fileName} onBack={() => navigate(-1)} />

      {loading && <DetailSkeleton />}

      {!loading && error && (
        <StateView
          icon={<AlertCircle size={28} style={{ color: "var(--color-text-tertiary)" }} />}
          title={error.binary ? t("file.binary") : t("file.unavailable")}
          detail={error.message}
          action={
            <BlockButton variant="primary" onClick={() => navigate(-1)}>
              {t("common.back")}
            </BlockButton>
          }
        />
      )}

      {!loading && !error && body && (
        <>
          <DetailMeta
            items={[
              { label: t("file.metaPath"), value: body.relativePath },
              { label: t("file.metaSize"), value: formatBytes(body.sizeBytes) },
              { label: t("file.metaLines"), value: String(lines.length) },
            ]}
          />

          {body.truncated && <div className="fv-truncated">{t("file.truncated")}</div>}

          {/* 256 KB 上限 ≈ 数千行,逐行 DOM 足够快;真需要虚拟化时再引入。 */}
          <div className="fv">
            {lines.map((line, i) => (
              <div className="fv-line" key={i}>
                <span className="fv-ln">{i + 1}</span>
                <span className="fv-code">{line}</span>
              </div>
            ))}
          </div>

          <motion.div
            initial={{ y: 80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="sticky-bar"
          >
            {capHit ? (
              <div className="sel-counter cap" style={{ marginBottom: 8, textAlign: "center" }}>
                {t("tree.capReached", { max: maxFiles })}
              </div>
            ) : null}
            <BlockButton
              variant={isSelected ? "outline" : "primary"}
              onClick={handleToggle}
            >
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                }}
              >
                {isSelected ? <CheckCircle2 size={18} /> : <FilePlus2 size={18} />}
                {isSelected ? t("file.inContext") : t("file.addContext")}
                {isSelected && <Check size={16} />}
              </span>
            </BlockButton>
          </motion.div>
        </>
      )}
    </div>
  );
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

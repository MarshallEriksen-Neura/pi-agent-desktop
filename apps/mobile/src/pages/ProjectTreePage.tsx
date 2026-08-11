import { memo, useEffect, useState, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { motion } from "motion/react";
import {
  Folder,
  File as FileIcon,
  ChevronRight,
  Check,
  AlertCircle,
} from "lucide-react";
import { t } from "@/i18n";
import { useConnection } from "@/hooks/useConnection";
import { useConnectionStore } from "@/stores/connection.store";
import { StateView, FullScreenSpinner } from "@/components/primitives";
import {
  MobileCard,
  MobileRow,
  BlockButton,
} from "@/components/visual";
import { NetError } from "@/net/errors";
import type {
  RemoteTreeEntry,
  RemoteTreePage,
  RemoteProjectCapabilities,
} from "@pi/remote-control-contracts";

/**
 * ProjectTreePage — 受限只读文件选择器。浏览项目树(目录可导航,文件可选为
 * context),转发选择到 TaskComposerPage。
 *
 * 安全(设计 §4):只展示元数据,不获取文件正文;选择数受服务端
 * maxContextFiles 限制;只使用相对路径。
 */
export const ProjectTreePage = memo(function ProjectTreePage() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const { isOnline } = useConnection();
  const client = useConnectionStore((s) => s.client);

  const [dir, setDir] = useState<string>("");
  const [page, setPage] = useState<RemoteTreePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [capabilities, setCapabilities] =
    useState<RemoteProjectCapabilities | null>(null);

  useEffect(() => {
    if (!client) return;
    void (async () => {
      try {
        const caps = await client.getCapabilities();
        setCapabilities({
          maxTreeEntriesPerPage: caps.project.maxTreeEntriesPerPage,
          maxContextFiles: caps.project.maxContextFiles,
          maxRelativePathBytes: caps.project.maxRelativePathBytes,
          fileBodyAvailable: false,
        });
      } catch {
        // Capabilities are optional — fall back to a safe default.
      }
    })();
  }, [client]);

  const maxFiles = capabilities?.maxContextFiles ?? 32;

  const load = useCallback(
    async (targetDir: string, targetCursor?: string) => {
      if (!client) return;
      if (!targetCursor) setLoading(true);
      else setLoadingMore(true);
      setError(null);
      try {
        const result = await client.getProjectTree(
          projectId,
          targetDir || undefined,
          targetCursor,
        );
        setDir(result.directory);
        if (targetCursor && page) {
          setPage({
            ...result,
            entries: [...page.entries, ...result.entries],
          });
        } else {
          setPage(result);
        }
      } catch (e) {
        const message = e instanceof NetError ? e.message : "fetch_failed";
        setError(message);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [client, projectId, page],
  );

  useEffect(() => {
    void load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, projectId]);

  const toggleFile = useCallback(
    (relativePath: string) => {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(relativePath)) {
          next.delete(relativePath);
        } else {
          if (next.size >= maxFiles) return prev; // cap
          next.add(relativePath);
        }
        return next;
      });
    },
    [maxFiles],
  );

  const navigateDir = (entry: RemoteTreeEntry) => {
    if (entry.kind !== "directory") return;
    void load(entry.relativePath);
  };

  const handleCompose = () => {
    const files = Array.from(selected);
    navigate(`/projects/${encodeURIComponent(projectId)}/compose`, {
      state: { contextFiles: files },
    });
  };

  if (!isOnline) {
    return (
      <StateView
        icon={<AlertCircle size={28} style={{ color: "var(--color-text-tertiary)" }} />}
        title={t("error.offline")}
        detail={t("error.offlineDetail")}
      />
    );
  }

  if (loading) {
    return <FullScreenSpinner label={t("common.loading")} />;
  }

  if (error && !page) {
    return (
      <StateView
        icon={<AlertCircle size={28} style={{ color: "var(--color-text-tertiary)" }} />}
        title={t("error.unknown")}
        detail={error}
        action={
          <BlockButton variant="primary" onClick={() => load("")}>
            {t("common.retry")}
          </BlockButton>
        }
      />
    );
  }

  const entries = page?.entries ?? [];
  const hasMore = Boolean(page?.nextCursor);

  return (
    <div className="page-scroll" style={{ paddingBottom: 80 }}>
      {/* Breadcrumb */}
      <div className="breadcrumb">
        <BreadcrumbCrumb
          label={t("tree.root")}
          onClick={() => {
            void load("");
          }}
        />
        {dir &&
          dir.split("/").map((part, i, arr) => (
            <span
              key={i}
              style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
            >
              <ChevronRight
                size={14}
                style={{ color: "var(--color-text-tertiary)" }}
              />
              <BreadcrumbCrumb
                label={part}
                onClick={() => {
                  const target = arr.slice(0, i + 1).join("/");
                  void load(target);
                }}
              />
            </span>
          ))}
      </div>

      {/* Selection counter */}
      <div className="sel-counter">
        {t("tree.selected", { count: selected.size, max: maxFiles })}
      </div>

      {/* Entries */}
      <MobileCard>
        {entries.length === 0 ? (
          <div className="hint">{t("tree.empty")}</div>
        ) : (
          entries.map((entry) => {
            const isSelected = selected.has(entry.relativePath);
            return (
              <MobileRow
                key={entry.relativePath}
                icon={
                  entry.kind === "directory" ? (
                    <Folder size={16} />
                  ) : (
                    <FileIcon size={16} />
                  )
                }
                title={entry.name}
                detail={
                  entry.kind === "file" && entry.sizeBytes != null
                    ? formatBytes(entry.sizeBytes)
                    : entry.kind === "directory"
                      ? t("tree.folder")
                      : undefined
                }
                trailing={
                  entry.kind === "directory" ? (
                    <ChevronRight
                      size={18}
                      style={{ color: "var(--color-text-tertiary)" }}
                    />
                  ) : isSelected ? (
                    <span
                      style={{
                        display: "grid",
                        placeItems: "center",
                        width: 24,
                        height: 24,
                        borderRadius: "50%",
                        background: "var(--color-accent)",
                        color: "#fff",
                      }}
                    >
                      <Check size={14} />
                    </span>
                  ) : (
                    <span
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: "50%",
                        border: "1.5px solid var(--color-text-tertiary)",
                      }}
                    />
                  )
                }
                onClick={
                  entry.kind === "directory"
                    ? () => navigateDir(entry)
                    : () => toggleFile(entry.relativePath)
                }
              />
            );
          })
        )}
      </MobileCard>

      {/* Load more */}
      {hasMore && (
        <div style={{ textAlign: "center", marginTop: 16 }}>
          <BlockButton
            variant="outline"
            onClick={() => load(dir, page!.nextCursor)}
            disabled={loadingMore}
          >
            {loadingMore ? t("common.loading") : t("tree.loadMore")}
          </BlockButton>
        </div>
      )}

      {/* Sticky compose bar */}
      {selected.size > 0 && (
        <motion.div
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="sticky-bar"
        >
          <BlockButton variant="primary" onClick={handleCompose}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                justifyContent: "center",
              }}
            >
              {t("tree.composeWith", { count: selected.size })}
              <ChevronRight size={18} />
            </span>
          </BlockButton>
        </motion.div>
      )}
    </div>
  );
});

function BreadcrumbCrumb({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.96 }}
      onClick={onClick}
      style={{
        background: "transparent",
        border: "none",
        color: "var(--color-accent)",
        fontSize: 14,
        fontWeight: 500,
        cursor: "pointer",
        padding: 0,
        fontFamily: "var(--font-ui)",
      }}
    >
      {label}
    </motion.button>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

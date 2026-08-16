import { memo, useEffect, useState, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { motion } from "motion/react";
import {
  Folder,
  File as FileIcon,
  ChevronRight,
  Check,
  AlertCircle,
  FolderOpen,
} from "lucide-react";
import { t } from "@/i18n";
import { useConnection } from "@/hooks/useConnection";
import { useConnectionStore } from "@/stores/connection.store";
import { useCapabilities } from "@/hooks/useCapabilities";
import {
  useTreeSelectionStore,
  selectedFiles,
} from "@/stores/tree-selection.store";
import { StateView } from "@/components/primitives";
import {
  MobileCard,
  MobileRow,
  BlockButton,
  EmptyState,
} from "@/components/visual";
import { ListSkeleton } from "@/components/skeleton";
import { OfflineView } from "@/components/connection-trouble";
import { NetError } from "@/net/errors";
import type {
  RemoteTreeEntry,
  RemoteTreePage,
} from "@pi/remote-control-contracts";

/**
 * ProjectTreePage — 受限只读文件浏览器。目录可导航,文件可预览(FileViewerPage)
 * 或勾选为 context,转发选择到 TaskComposerPage。
 *
 * 安全(设计 §4):只展示元数据;选择数受服务端 maxContextFiles 限制;只使用
 * 相对路径。文件正文由预览页单独拉取,同样只走相对路径。
 */
export const ProjectTreePage = memo(function ProjectTreePage() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const { isOnline, stored, connect, wake } = useConnection();
  const client = useConnectionStore((s) => s.client);
  const { data: capabilities } = useCapabilities();

  const [dir, setDir] = useState<string>("");
  const [page, setPage] = useState<RemoteTreePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 选满上限后再点会被静默忽略 —— 必须给反馈,否则用户以为点击失灵了。
  const [capHit, setCapHit] = useState(false);

  const maxFiles = capabilities?.project.maxContextFiles ?? 32;
  const canPreview = capabilities?.project.fileBodyAvailable ?? false;
  // 订阅整份 selections(toggle 必然产生新对象),行内即可同步判断勾选态。
  const selections = useTreeSelectionStore((s) => s.selections);
  const selected = selections[projectId];

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
      const outcome = useTreeSelectionStore
        .getState()
        .toggle(projectId, relativePath, maxFiles);
      setCapHit(outcome === "capped");
    },
    [projectId, maxFiles],
  );

  const navigateDir = (entry: RemoteTreeEntry) => {
    if (entry.kind !== "directory") return;
    void load(entry.relativePath);
  };

  const openPreview = (entry: RemoteTreeEntry) => {
    navigate(
      `/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(entry.relativePath)}`,
    );
  };

  const handleCompose = () => {
    const files = selectedFiles(projectId);
    navigate(`/projects/${encodeURIComponent(projectId)}/compose`, {
      state: { contextFiles: files },
    });
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

  // 骨架而非转圈:文件树是等高行,骨架能预告落地后的形状。
  if (loading) {
    return (
      <div className="page-scroll">
        <div className="breadcrumb">
          <span style={{ color: "var(--color-text-tertiary)", fontSize: 14 }}>
            {t("tree.root")}
          </span>
        </div>
        <ListSkeleton count={6} />
      </div>
    );
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

      {/* Selection counter —— 选满上限时变成解释性提示,而不是一个不动的数字 */}
      <div className={`sel-counter${capHit ? " cap" : ""}`}>
        {capHit
          ? t("tree.capReached", { max: maxFiles })
          : t("tree.selected", { count: selected?.size ?? 0, max: maxFiles })}
      </div>

      {/* Entries */}
      {entries.length === 0 ? (
        <EmptyState icon={<FolderOpen size={26} />}>
          <div style={{ marginBottom: 8 }}>{t("tree.empty")}</div>
          {dir && (
            <BlockButton variant="outline" onClick={() => void load("")}>
              {t("tree.backToRoot")}
            </BlockButton>
          )}
        </EmptyState>
      ) : (
        <MobileCard>
          {entries.map((entry) => {
            const isSelected = selected?.has(entry.relativePath) ?? false;
            const atCap = !isSelected && (selected?.size ?? 0) >= maxFiles;
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
                  ) : (
                    // 点击行为已让给预览,勾选移到行尾独立触控区(padding 撑到
                    // 44px)。到达上限的未选项降低不透明度,让「点不动」有视觉
                    // 解释。span 而非 button:整行本身已是 button,嵌套按钮是
                    // 非法 HTML。
                    <span
                      role="checkbox"
                      aria-checked={isSelected}
                      aria-label={t("tree.selectFile", { name: entry.name })}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFile(entry.relativePath);
                      }}
                      style={{
                        display: "grid",
                        placeItems: "center",
                        width: 44,
                        height: 44,
                        flexShrink: 0,
                        marginRight: -10,
                        cursor: "pointer",
                        opacity: atCap ? 0.35 : 1,
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          display: "grid",
                          placeItems: "center",
                          width: 24,
                          height: 24,
                          borderRadius: "50%",
                          background: isSelected ? "var(--color-accent)" : "transparent",
                          border: isSelected
                            ? "none"
                            : "1.5px solid var(--color-text-tertiary)",
                          color: "#fff",
                        }}
                      >
                        {isSelected && <Check size={14} />}
                      </span>
                    </span>
                  )
                }
                onClick={
                  entry.kind === "directory"
                    ? () => navigateDir(entry)
                    : // 网关不支持正文时退回旧行为:整行点击即勾选。
                      canPreview
                      ? () => openPreview(entry)
                      : () => toggleFile(entry.relativePath)
                }
              />
            );
          })}
        </MobileCard>
      )}

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
      {(selected?.size ?? 0) > 0 && (
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
              {t("tree.composeWith", { count: selected!.size })}
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

"use client";

import { useState } from "react";
import { Folder, Plus, FolderPlus } from "lucide-react";
import { Button } from "@appica/ui-react/button";
import { InsetGroup, GroupRow } from "@/components/settings-ui";
import { useT } from "@/lib/i18n";
import { useAuthorizedProjects } from "@/lib/remote-control/hooks";

/** D-5 — authorized project list + add local project (Tauri folder picker, manual fallback). */
export function AuthorizedProjectsGroup() {
  const t = useT();
  const { projects, count, allowProject, removeProject, busy } =
    useAuthorizedProjects();
  const [manualOpen, setManualOpen] = useState(false);
  const [manualPath, setManualPath] = useState("");

  const pickFolder = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({ directory: true, multiple: false });
      if (typeof dir === "string" && dir) {
        await allowProject(dir);
      }
    } catch {
      // Browser mock or dialog unavailable — fall back to manual path entry.
      setManualOpen(true);
    }
  };

  const submitManual = async () => {
    const p = manualPath.trim();
    if (!p) return;
    setManualPath("");
    setManualOpen(false);
    await allowProject(p);
  };

  return (
    <InsetGroup
      header={t("settings.remoteControl.authorizedProjects")}
      footer={t("settings.remoteControl.authorizedProjectsFooter")}
    >
      {count === 0 ? (
        <GroupRow
          first
          icon={<Folder size={15} />}
          iconBg="var(--gray-1)"
          title={t("settings.remoteControl.emptyProjects")}
          detail={t("settings.remoteControl.emptyProjectsDetail")}
        />
      ) : (
        projects.map((p, i) => (
          <GroupRow
            key={p.projectId}
            first={i === 0}
            icon={<Folder size={15} />}
            iconBg="var(--gray-1)"
            title={p.name}
            detail={p.projectId.length > 16 ? `${p.projectId.slice(0, 8)}…${p.projectId.slice(-4)}` : p.projectId}
            trailing={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void removeProject(p.projectId)}
                disabled={busy}
                style={{ borderRadius: 7, color: "var(--danger)", padding: "2px 8px" }}
              >
                {t("settings.remoteControl.projectRemove")}
              </Button>
            }
          />
        ))
      )}

      <div style={{ padding: "11px 16px", borderTop: "1px solid var(--separator)" }}>
        {!manualOpen ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void pickFolder()}
            disabled={busy}
            style={{ borderRadius: 8, width: "100%" }}
          >
            <FolderPlus size={14} style={{ marginRight: 6 }} />
            {t("settings.remoteControl.addProject")}
          </Button>
        ) : (
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              value={manualPath}
              placeholder={t("settings.remoteControl.projectPathPlaceholder")}
              onChange={(e) => setManualPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitManual();
                if (e.key === "Escape") setManualOpen(false);
              }}
              autoFocus
              style={{
                flex: 1,
                padding: "6px 10px",
                fontSize: 12.5,
                fontFamily: "var(--font-mono, monospace)",
                color: "var(--text-primary)",
                background: "var(--bg-sunken)",
                border: "1px solid var(--separator)",
                borderRadius: 8,
                outline: "none",
              }}
            />
            <Button
              variant="primary"
              size="sm"
              onClick={() => void submitManual()}
              disabled={!manualPath.trim()}
              style={{ borderRadius: 8 }}
            >
              <Plus size={14} />
            </Button>
          </div>
        )}
      </div>
    </InsetGroup>
  );
}

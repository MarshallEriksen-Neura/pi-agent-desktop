"use client";

import { useEffect } from "react";
import { motion } from "motion/react";
import { Badge } from "@appica/ui-react/badge";
import { usePi, THINKING_LEVELS } from "@/lib/pi/store";
import { usePiSettings } from "@/lib/pi/settings";
import {
  SettingsPage,
  InsetGroup,
  GroupRow,
  Segmented,
  StringListEditor,
} from "@/components/settings-ui";
import { PROVIDER_META, fmtCtx } from "@/components/provider-meta";
import { useT } from "@/lib/i18n";
import { Settings, Check } from "lucide-react";

export default function ModelsPage() {
  const { models, currentModel, thinkingLevel, setModel, setThinking, mock, status } =
    usePi();
  const settings = usePiSettings();
  const t = useT();

  useEffect(() => {
    settings.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const providers = [...new Set(models.map((m) => m.provider))];

  return (
    <SettingsPage
      title={t("models.title")}
      subtitle={
        mock
          ? t("models.subtitleMock")
          : t("models.subtitleLive", { status: t(`status.${status}`) })
      }
    >
      {/* active model hero card */}
      <InsetGroup header={t("models.activeModel")}>
        {currentModel ? (
          <GroupRow
            first
            icon={PROVIDER_META[currentModel.provider]?.icon ?? <Settings size={16} />}
            iconBg={PROVIDER_META[currentModel.provider]?.bg}
            title={
              <span style={{ fontWeight: 600 }}>
                {currentModel.name ?? currentModel.id}
              </span>
            }
            detail={`${PROVIDER_META[currentModel.provider]?.label ?? currentModel.provider} · ${fmtCtx(currentModel.contextWindow)}${currentModel.reasoning ? ` · ${t("models.reasoning")}` : ""}`}
            trailing={
              <motion.span
                key={currentModel.id}
                initial={{ scale: 0.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: "spring", stiffness: 500, damping: 24 }}
              >
                <Badge variant="success" size="sm">
                  {t("models.activeBadge")}
                </Badge>
              </motion.span>
            }
          />
        ) : (
          <GroupRow first title={t("models.noModel")} detail={t("models.pickBelow")} />
        )}
      </InsetGroup>

      {/* thinking level */}
      <InsetGroup
        header={t("models.thinkingLevel")}
        footer={t("models.thinkingFooter")}
      >
        <div style={{ padding: "12px 14px" }}>
          <Segmented
            options={THINKING_LEVELS}
            value={thinkingLevel}
            onChange={setThinking}
          />
        </div>
      </InsetGroup>

      {/* model cycling — enabledModels patterns in global settings.json */}
      <InsetGroup
        header={t("models.cycling")}
        footer={t("models.cyclingFooter")}
      >
        <StringListEditor
          items={settings.global.data?.enabledModels as string[] | undefined}
          onChange={(items) => settings.setKey("global", "enabledModels", items)}
          addPlaceholder={t("models.cyclingPlaceholder")}
        />
      </InsetGroup>

      {/* all models, grouped by provider */}
      {providers.map((p) => (
        <InsetGroup key={p} header={PROVIDER_META[p]?.label ?? p}>
          {models
            .filter((m) => m.provider === p)
            .map((m, i) => {
              const active =
                currentModel?.id === m.id && currentModel?.provider === m.provider;
              return (
                <GroupRow
                  key={`${m.provider}/${m.id}`}
                  first={i === 0}
                  icon={PROVIDER_META[p]?.icon ?? <Settings size={16} />}
                  iconBg={PROVIDER_META[p]?.bg}
                  title={m.name ?? m.id}
                  detail={`${m.id} · ${fmtCtx(m.contextWindow)}${m.reasoning ? ` · ${t("models.reasoning")}` : ""}`}
                  onClick={() => setModel(m)}
                  trailing={
                    active ? (
                      <motion.span
                        initial={{ scale: 0.5, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ type: "spring", stiffness: 500, damping: 22 }}
                        style={{ color: "var(--accent)", fontSize: 15, fontWeight: 700 }}
                      >
                        <Check size={14} />
                      </motion.span>
                    ) : undefined
                  }
                />
              );
            })}
        </InsetGroup>
      ))}
    </SettingsPage>
  );
}

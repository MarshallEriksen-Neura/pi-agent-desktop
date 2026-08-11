import { memo, useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  MessageSquare,
  CheckCircle2,
  XCircle,
  AlertCircle,
} from "lucide-react";
import { t } from "@/i18n";
import { useConnection } from "@/hooks/useConnection";
import { useInteractionStore } from "@/stores/interaction-store";
import { useExpiryCountdown } from "@/hooks/useExpiryCountdown";
import { StateView, FullScreenSpinner } from "@/components/primitives";
import {
  SectionLabel,
  MobileCard,
  BlockButton,
  EmptyState,
} from "@/components/visual";
import { CountdownRing, PromptBox, OptionRow } from "@/components/task-visual";
import type { RemoteInteractionSnapshot } from "@pi/remote-control-contracts";

/**
 * InteractionsPage — pending awaiting_input 交互的响应入口(设计 §6)。
 *
 * Visual(对齐 demo):
 *  - 每个待响应交互:MobileCard 内含 CountdownRing(倒计时圆环)+ PromptBox
 *    + 表单(confirm/select/input 三种)
 *  - confirm:btns2 双按钮(Yes/No)
 *  - select:OptionRow 单选列表 + 提交
 *  - input:textarea + 提交
 *  - history:MobileCard(opacity 0.7)+ 终态图标 + 回复摘要
 */
export const InteractionsPage = memo(function InteractionsPage() {
  const { isOnline } = useConnection();
  const loading = useInteractionStore((s) => s.loading);
  const order = useInteractionStore((s) => s.order);
  const interactions = useInteractionStore((s) => s.interactions);
  const refresh = useInteractionStore((s) => s.refresh);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!isOnline) {
    return (
      <StateView
        icon={<AlertCircle size={28} style={{ color: "var(--color-text-tertiary)" }} />}
        title={t("connection.offline")}
        detail={t("error.offlineDetail")}
      />
    );
  }

  if (loading && order.length === 0) {
    return <FullScreenSpinner label={t("common.loading")} />;
  }

  const pending = order
    .map((id) => interactions[id])
    .filter((i): i is RemoteInteractionSnapshot => Boolean(i) && i.status === "pending");
  const history = order
    .map((id) => interactions[id])
    .filter(
      (i): i is RemoteInteractionSnapshot => Boolean(i) && i.status !== "pending",
    );

  if (order.length === 0) {
    return <EmptyState icon={<MessageSquare size={28} />}>{t("interaction.emptyDetail")}</EmptyState>;
  }

  return (
    <div className="page-scroll">
      <h1 className="page-title">{t("interaction.title")}</h1>

      {/* Pending — actionable */}
      {pending.length > 0 && (
        <>
          <SectionLabel>{t("interaction.pending")}</SectionLabel>
          <AnimatePresence>
            {pending.map((ix) => (
              <InteractionCard key={ix.interactionId} interaction={ix} />
            ))}
          </AnimatePresence>
        </>
      )}

      {/* History — resolved/expired */}
      {history.length > 0 && (
        <>
          <SectionLabel>{t("interaction.history")}</SectionLabel>
          {history.map((ix) => (
            <HistoryCard key={ix.interactionId} interaction={ix} />
          ))}
        </>
      )}
    </div>
  );
});

// ----------------------------------------------------------------
// Pending interaction card — renders the right form per kind.
// ----------------------------------------------------------------

const InteractionCard = memo(function InteractionCard({
  interaction,
}: {
  interaction: RemoteInteractionSnapshot;
}) {
  if (interaction.kind === "confirm") return <ConfirmForm interaction={interaction} />;
  if (interaction.kind === "select") return <SelectForm interaction={interaction} />;
  return <InputForm interaction={interaction} />;
});

/** Shared header: countdown ring + prompt box. */
function InteractionHeader({
  interaction,
  remaining,
}: {
  interaction: RemoteInteractionSnapshot;
  remaining: number | null;
}) {
  const total = Math.max(
    1,
    Math.floor(
      (new Date(interaction.expiresAt).getTime() -
        new Date(interaction.createdAt).getTime()) /
        1000,
    ),
  );
  const showRing = remaining !== null && remaining > 0;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 10,
        marginBottom: 14,
      }}
    >
      {showRing && <CountdownRing remaining={remaining as number} total={total} />}
      <PromptBox>{interaction.prompt}</PromptBox>
    </div>
  );
}

// ----------------------------------------------------------------
// Confirm form — Yes / No
// ----------------------------------------------------------------

const ConfirmForm = memo(function ConfirmForm({
  interaction,
}: {
  interaction: RemoteInteractionSnapshot;
}) {
  const respond = useInteractionStore((s) => s.respond);
  const isResponding = useInteractionStore((s) =>
    s.responding.has(interaction.interactionId),
  );
  const remaining = useExpiryCountdown(interaction.expiresAt);

  const handle = (value: boolean) => {
    void respond(interaction.interactionId, "confirm", value);
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      style={{ marginBottom: 12 }}
    >
      <MobileCard style={{ padding: 14 }}>
        <InteractionHeader interaction={interaction} remaining={remaining} />
        <div className="btns2">
          <BlockButton
            variant="primary"
            onClick={() => handle(true)}
            disabled={isResponding || remaining === 0}
          >
            {t("interaction.yes")}
          </BlockButton>
          <BlockButton
            variant="outline"
            onClick={() => handle(false)}
            disabled={isResponding || remaining === 0}
          >
            {t("interaction.no")}
          </BlockButton>
        </div>
      </MobileCard>
    </motion.div>
  );
});

// ----------------------------------------------------------------
// Select form — radio-style option list
// ----------------------------------------------------------------

const SelectForm = memo(function SelectForm({
  interaction,
}: {
  interaction: RemoteInteractionSnapshot;
}) {
  const respond = useInteractionStore((s) => s.respond);
  const isResponding = useInteractionStore((s) =>
    s.responding.has(interaction.interactionId),
  );
  const remaining = useExpiryCountdown(interaction.expiresAt);
  const [selected, setSelected] = useState<string | null>(null);

  const options = interaction.options ?? [];
  const disabled = isResponding || remaining === 0 || selected === null;

  const handleSubmit = () => {
    if (selected !== null) {
      void respond(interaction.interactionId, "select", selected);
    }
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      style={{ marginBottom: 12 }}
    >
      <MobileCard style={{ padding: 14 }}>
        <InteractionHeader interaction={interaction} remaining={remaining} />
        {options.map((opt) => (
          <OptionRow
            key={opt.value}
            label={opt.label}
            selected={selected === opt.value}
            onClick={() => setSelected(opt.value)}
            disabled={isResponding || remaining === 0}
          />
        ))}
        <BlockButton variant="primary" onClick={handleSubmit} disabled={disabled}>
          {t("interaction.submit")}
        </BlockButton>
      </MobileCard>
    </motion.div>
  );
});

// ----------------------------------------------------------------
// Input form — text field + submit
// ----------------------------------------------------------------

const InputForm = memo(function InputForm({
  interaction,
}: {
  interaction: RemoteInteractionSnapshot;
}) {
  const respond = useInteractionStore((s) => s.respond);
  const isResponding = useInteractionStore((s) =>
    s.responding.has(interaction.interactionId),
  );
  const remaining = useExpiryCountdown(interaction.expiresAt);
  const [value, setValue] = useState("");

  const trimmed = value.trim();
  const disabled = isResponding || remaining === 0 || trimmed.length === 0;

  const handleSubmit = () => {
    if (trimmed.length > 0) {
      void respond(interaction.interactionId, "input", trimmed);
    }
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      style={{ marginBottom: 12 }}
    >
      <MobileCard style={{ padding: 14 }}>
        <InteractionHeader interaction={interaction} remaining={remaining} />
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={isResponding || remaining === 0}
          rows={3}
          placeholder={t("interaction.inputPlaceholder")}
          style={{
            width: "100%",
            minHeight: 80,
            padding: 12,
            marginTop: 4,
            border: "1px solid var(--color-separator)",
            borderRadius: "var(--radius-md)",
            background: "var(--color-bg-base)",
            color: "var(--color-text-primary)",
            fontSize: 16,
            fontFamily: "var(--font-ui)",
            resize: "none",
            outline: "none",
            boxSizing: "border-box",
          }}
        />
        <BlockButton variant="primary" onClick={handleSubmit} disabled={disabled}>
          {t("interaction.submit")}
        </BlockButton>
      </MobileCard>
    </motion.div>
  );
});

// ----------------------------------------------------------------
// History card — resolved/expired
// ----------------------------------------------------------------

const HistoryCard = memo(function HistoryCard({
  interaction,
}: {
  interaction: RemoteInteractionSnapshot;
}) {
  const isResolved = interaction.status === "resolved";
  const Icon = isResolved ? CheckCircle2 : XCircle;
  const color = isResolved ? "var(--color-success)" : "var(--color-text-tertiary)";
  const label = isResolved ? t("interaction.resolved") : t("interaction.expired");

  return (
    <MobileCard style={{ marginBottom: 8, padding: 12, opacity: 0.7 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <Icon size={16} style={{ color }} />
        <span style={{ fontSize: 13, fontWeight: 600, color }}>{label}</span>
      </div>
      <p
        style={{
          fontSize: 14,
          color: "var(--color-text-primary)",
          margin: "0 0 8px",
          lineHeight: 1.4,
        }}
      >
        {interaction.prompt}
      </p>
      {interaction.response && (
        <p style={{ fontSize: 13, color: "var(--color-text-tertiary)", margin: 0 }}>
          {t("interaction.response")}:{" "}
          {typeof interaction.response.value === "boolean"
            ? interaction.response.value
              ? t("interaction.yes")
              : t("interaction.no")
            : String(interaction.response.value)}
        </p>
      )}
    </MobileCard>
  );
});

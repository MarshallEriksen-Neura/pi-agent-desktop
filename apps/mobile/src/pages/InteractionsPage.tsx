import { memo, useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { MessageSquare, Clock, CheckCircle2, XCircle, AlertCircle } from "lucide-react";
import { t } from "@/i18n";
import { useConnection } from "@/hooks/useConnection";
import {
  useInteractionStore,
} from "@/stores/interaction-store";
import { useExpiryCountdown, formatCountdown } from "@/hooks/useExpiryCountdown";
import {
  Card,
  StateView,
  FullScreenSpinner,
  PrimaryButton,
  SecondaryButton,
} from "@/components/primitives";
import type { RemoteInteractionSnapshot } from "@pi/remote-control-contracts";

/**
 * InteractionsPage — surfaces pending awaiting_input interactions with a clear
 * entry point (design §6: "awaiting_input 必须有明显入口，不能隐藏在日志中").
 *
 * Each pending interaction renders one of three response forms:
 *  - confirm: Yes / No
 *  - select:  radio-style option list
 *  - input:   text field + submit
 *
 * Resolved/expired interactions show their terminal state below the pending
 * set, so the user can see what they responded to.
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
    .filter((i): i is RemoteInteractionSnapshot => Boolean(i) && i.status !== "pending");

  if (order.length === 0) {
    return (
      <StateView
        icon={<MessageSquare size={28} style={{ color: "var(--color-text-tertiary)" }} />}
        title={t("interaction.empty")}
        detail={t("interaction.emptyDetail")}
      />
    );
  }

  return (
    <div style={{ padding: "16px", overflowY: "auto", height: "100%" }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em", margin: "8px 0 20px" }}>
        {t("interaction.title")}
      </h1>

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
  if (interaction.kind === "confirm") {
    return <ConfirmForm interaction={interaction} />;
  }
  if (interaction.kind === "select") {
    return <SelectForm interaction={interaction} />;
  }
  return <InputForm interaction={interaction} />;
});

// ----------------------------------------------------------------
// Confirm form — Yes / No
// ----------------------------------------------------------------

const ConfirmForm = memo(function ConfirmForm({
  interaction,
}: {
  interaction: RemoteInteractionSnapshot;
}) {
  const respond = useInteractionStore((s) => s.respond);
  const isResponding = useInteractionStore((s) => s.responding.has(interaction.interactionId));
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
      <Card>
        <PromptHeader prompt={interaction.prompt} remaining={remaining} />
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <PrimaryButton onClick={() => handle(true)} disabled={isResponding || remaining === 0}>
            {t("interaction.yes")}
          </PrimaryButton>
          <SecondaryButton onClick={() => handle(false)} disabled={isResponding || remaining === 0}>
            {t("interaction.no")}
          </SecondaryButton>
        </div>
      </Card>
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
  const isResponding = useInteractionStore((s) => s.responding.has(interaction.interactionId));
  const remaining = useExpiryCountdown(interaction.expiresAt);
  const [selected, setSelected] = useState<string | null>(null);

  const options = interaction.options ?? [];
  const disabled = isResponding || remaining === 0 || selected === null;

  const handleSubmit = () => {
    if (selected === null) return;
    void respond(interaction.interactionId, "select", selected);
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      style={{ marginBottom: 12 }}
    >
      <Card>
        <PromptHeader prompt={interaction.prompt} remaining={remaining} />
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
          {options.map((opt) => {
            const active = selected === opt.value;
            return (
              <motion.button
                key={opt.value}
                whileTap={{ scale: 0.98 }}
                onClick={() => setSelected(opt.value)}
                disabled={isResponding || remaining === 0}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  width: "100%",
                  minHeight: "var(--tap-min)",
                  padding: "12px 16px",
                  border: `1px solid ${active ? "var(--color-accent)" : "var(--color-separator)"}`,
                  borderRadius: "var(--radius-md)",
                  background: active ? "var(--color-accent-muted)" : "transparent",
                  color: "var(--color-text-primary)",
                  fontSize: 16,
                  textAlign: "left",
                  cursor: "pointer",
                  fontFamily: "var(--font-ui)",
                }}
              >
                <span
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: "50%",
                    border: `2px solid ${active ? "var(--color-accent)" : "var(--color-text-tertiary)"}`,
                    display: "grid",
                    placeItems: "center",
                    flexShrink: 0,
                  }}
                >
                  {active && (
                    <span
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: "50%",
                        background: "var(--color-accent)",
                      }}
                    />
                  )}
                </span>
                {opt.label}
              </motion.button>
            );
          })}
        </div>
        <div style={{ marginTop: 16 }}>
          <PrimaryButton onClick={handleSubmit} disabled={disabled}>
            {t("interaction.submit")}
          </PrimaryButton>
        </div>
      </Card>
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
  const isResponding = useInteractionStore((s) => s.responding.has(interaction.interactionId));
  const remaining = useExpiryCountdown(interaction.expiresAt);
  const [value, setValue] = useState("");

  const trimmed = value.trim();
  const disabled = isResponding || remaining === 0 || trimmed.length === 0;

  const handleSubmit = () => {
    if (trimmed.length === 0) return;
    void respond(interaction.interactionId, "input", trimmed);
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      style={{ marginBottom: 12 }}
    >
      <Card>
        <PromptHeader prompt={interaction.prompt} remaining={remaining} />
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
            marginTop: 12,
            border: "1px solid var(--color-separator)",
            borderRadius: "var(--radius-md)",
            background: "var(--color-bg-base)",
            color: "var(--color-text-primary)",
            fontSize: 16,
            fontFamily: "var(--font-ui)",
            resize: "none",
            outline: "none",
          }}
        />
        <div style={{ marginTop: 12 }}>
          <PrimaryButton onClick={handleSubmit} disabled={disabled}>
            {t("interaction.submit")}
          </PrimaryButton>
        </div>
      </Card>
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
    <Card style={{ marginBottom: 8, opacity: 0.7 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <Icon size={16} style={{ color }} />
        <span style={{ fontSize: 13, fontWeight: 600, color }}>{label}</span>
      </div>
      <p style={{ fontSize: 14, color: "var(--color-text-primary)", margin: "0 0 8px", lineHeight: 1.4 }}>
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
    </Card>
  );
});

// ----------------------------------------------------------------
// Shared bits
// ----------------------------------------------------------------

function PromptHeader({
  prompt,
  remaining,
}: {
  prompt: string;
  remaining: number | null;
}) {
  const urgent = remaining !== null && remaining <= 10 && remaining > 0;
  return (
    <div>
      <p style={{ fontSize: 16, color: "var(--color-text-primary)", margin: "0 0 8px", lineHeight: 1.4 }}>
        {prompt}
      </p>
      {remaining !== null && (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontSize: 13,
            fontWeight: 600,
            color: urgent ? "var(--color-danger)" : "var(--color-text-tertiary)",
          }}
        >
          <Clock size={13} />
          {remaining === 0 ? t("interaction.expired") : formatCountdown(remaining)}
        </span>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 13,
        fontWeight: 600,
        color: "var(--color-text-tertiary)",
        padding: "0 4px 8px",
      }}
    >
      {children}
    </div>
  );
}

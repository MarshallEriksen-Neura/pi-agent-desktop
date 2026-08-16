"use client";

import { useEffect, useState } from "react";
import {
  Archive,
  Ban,
  ListTodo,
  RefreshCw,
  Send,
  Smartphone,
  WifiOff,
} from "lucide-react";
import { useT } from "@/lib/i18n";
import { useRemoteConversations } from "@/lib/remote-conversations/store";
import styles from "./page.module.css";

function clock(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function RemoteTasksPage() {
  const t = useT();
  const store = useRemoteConversations();
  const [draft, setDraft] = useState("");

  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store.start, store.stop]);

  const selected = store.selected;
  const modelRef =
    selected?.activeTurn?.modelRef ??
    selected?.latestTurn?.modelRef ??
    selected?.defaultModelRef;
  const archived = selected?.status === "archived";
  const canSend = !!selected && !archived && !store.sending;

  const submit = () => {
    if (!canSend || !draft.trim()) return;
    const prompt = draft;
    setDraft("");
    void store.append(prompt).then((ok) => {
      if (!ok) setDraft(prompt);
    });
  };

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <ListTodo size={18} style={{ color: "var(--accent)", marginRight: 9 }} />
        <div style={{ minWidth: 0 }}>
          <h1 style={{ fontSize: 15, fontWeight: 650, margin: 0 }}>{t("remoteTasks.title")}</h1>
          <p style={{ fontSize: 11, color: "var(--text-tertiary)", margin: "2px 0 0" }}>
            {t("remoteTasks.subtitle")}
          </p>
        </div>
        <button
          type="button"
          title={t("remoteTasks.refresh")}
          onClick={() => void store.refresh()}
          style={{
            width: 34,
            height: 34,
            display: "grid",
            placeItems: "center",
            border: 0,
            background: "transparent",
            color: "var(--text-secondary)",
            marginLeft: "auto",
            cursor: "pointer",
          }}
        >
          <RefreshCw size={15} />
        </button>
      </header>

      <div className={styles.content}>
        <aside className={styles.list} aria-label={t("remoteTasks.listLabel")}>
          {store.loading && store.conversations.length === 0 && (
            <p style={{ padding: 16, color: "var(--text-tertiary)", fontSize: 13 }}>
              {t("common.loading")}
            </p>
          )}
          {!store.loading && store.conversations.length === 0 && (
            <div style={{ padding: 20, color: "var(--text-tertiary)", textAlign: "center" }}>
              <Smartphone size={22} style={{ marginBottom: 8 }} />
              <div style={{ fontSize: 13 }}>{t("remoteTasks.empty")}</div>
            </div>
          )}
          {store.conversations.map((conversation) => (
            <button
              type="button"
              key={conversation.conversationId}
              className={`${styles.row} ${store.selectedId === conversation.conversationId ? styles.rowActive : ""}`}
              onClick={() => void store.select(conversation.conversationId)}
            >
              <span style={{ fontSize: 13, fontWeight: 620, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {conversation.title || t("remoteTasks.untitled")}
              </span>
              <span style={{ display: "flex", gap: 7, alignItems: "center", fontSize: 11, color: "var(--text-tertiary)" }}>
                <span>{t(`remoteTasks.status.${conversation.status}`)}</span>
                <span>·</span>
                <span>{conversation.queuedTurnCount} {t("remoteTasks.queued")}</span>
              </span>
              <span style={{ fontSize: 10, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {conversation.ownerDeviceId} · {clock(conversation.updatedAt)}
              </span>
            </button>
          ))}
        </aside>

        <section className={styles.detail}>
          {store.error && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--danger)", fontSize: 13, marginBottom: 16 }}>
              <WifiOff size={16} />
              <span>{store.error}</span>
            </div>
          )}
          {!selected && !store.error && (
            <p style={{ color: "var(--text-tertiary)", fontSize: 13 }}>
              {store.conversations.length === 0 ? t("remoteTasks.emptyDetail") : t("common.loading")}
            </p>
          )}
          {selected && (
            <>
              <div style={{ borderBottom: "1px solid var(--separator)", paddingBottom: 14, marginBottom: 18 }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                  <h2 style={{ fontSize: 18, fontWeight: 650, margin: 0, minWidth: 0 }}>
                    {selected.title || t("remoteTasks.untitled")}
                  </h2>
                  <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                    {selected.activeTurn && (
                      <button
                        type="button"
                        title={t("remoteTasks.cancel")}
                        onClick={() => void store.cancelActive()}
                        style={{
                          display: "grid",
                          placeItems: "center",
                          width: 30,
                          height: 30,
                          border: "1px solid var(--separator)",
                          borderRadius: 7,
                          background: "transparent",
                          color: "var(--danger)",
                          cursor: "pointer",
                        }}
                      >
                        <Ban size={14} />
                      </button>
                    )}
                    <button
                      type="button"
                      title={t("remoteTasks.archive")}
                      onClick={() => void store.archive(selected.conversationId)}
                      style={{
                        display: "grid",
                        placeItems: "center",
                        width: 30,
                        height: 30,
                        border: "1px solid var(--separator)",
                        borderRadius: 7,
                        background: "transparent",
                        color: "var(--text-secondary)",
                        cursor: "pointer",
                      }}
                    >
                      <Archive size={14} />
                    </button>
                  </span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 8, fontSize: 11, color: "var(--text-tertiary)" }}>
                  <span>{t(`remoteTasks.status.${selected.status}`)}</span>
                  <span>{t("remoteTasks.device")}: {selected.ownerDeviceId}</span>
                  <span>{t("remoteTasks.project")}: {selected.projectId}</span>
                  <span>{selected.turnCount} {t("remoteTasks.turns")}</span>
                  <span title={modelRef ?? undefined}>
                    {t("remoteTasks.model")}: {modelRef ?? t("remoteTasks.modelUnset")}
                  </span>
                </div>
              </div>
              <div aria-live="polite">
                {store.messages.map((message) => (
                  <div
                    key={message.messageId}
                    className={`${styles.message} ${message.role === "user" ? styles.userMessage : ""}`}
                  >
                    <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginBottom: 5 }}>
                      {message.role === "user" ? t("remoteTasks.user") : t("remoteTasks.assistant")} · {clock(message.createdAt)}
                    </div>
                    <div style={{ fontSize: 13 }}>{message.text || t("remoteTasks.waiting")}</div>
                  </div>
                ))}
              </div>

              {archived && (
                <p style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 16 }}>
                  {t("remoteTasks.archivedNote")}
                </p>
              )}
              {selected.activeTurn && !archived && (
                <p style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 16 }}>
                  {t("remoteTasks.busyNote")}
                </p>
              )}
              {!archived && (
                <form
                  className={styles.composer}
                  onSubmit={(event) => {
                    event.preventDefault();
                    submit();
                  }}
                >
                  <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder={t("remoteTasks.followUpPlaceholder")}
                    rows={2}
                    style={{
                      flex: 1,
                      resize: "none",
                      border: "1px solid var(--separator)",
                      borderRadius: 10,
                      background: "var(--surface)",
                      color: "var(--text)",
                      padding: "8px 10px",
                      fontSize: 13,
                      outline: "none",
                    }}
                  />
                  <button
                    type="submit"
                    disabled={!canSend || !draft.trim()}
                    title={t("remoteTasks.send")}
                    style={{
                      display: "grid",
                      placeItems: "center",
                      width: 36,
                      height: 36,
                      border: 0,
                      borderRadius: 10,
                      background: "var(--accent)",
                      color: "#fff",
                      cursor: canSend && draft.trim() ? "pointer" : "not-allowed",
                      opacity: canSend && draft.trim() ? 1 : 0.4,
                    }}
                  >
                    <Send size={15} />
                  </button>
                </form>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}

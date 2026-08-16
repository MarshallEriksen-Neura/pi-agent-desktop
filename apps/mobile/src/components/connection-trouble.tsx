import { memo, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import {
  ChevronRight,
  Loader2,
  Monitor,
  Power,
  ShieldAlert,
  Terminal,
  Wifi,
  WifiOff,
} from "lucide-react";
import { t } from "@/i18n";
import { formatClock } from "@/lib/task-label";
import type { RemoteTaskSnapshot } from "@pi/remote-control-contracts";
import { BlockButton, MobileCard, SectionLabel } from "@/components/visual";

/**
 * 连接异常的四个阶段,从设计稿「连接异常」复刻。
 *
 * 这四屏的共同设计目标:让用户知道**桌面端的任务还在跑**。遥控类 app 断连时,
 * 用户第一反应是「我的任务是不是死了」——如果 UI 只说「已离线」,那等于默认
 * 回答了「是」。所以每一态都要回答两个问题:发生了什么、任务怎么了。
 *
 * 这些组件替换掉页面里原来的 StateView 单行文案。
 */

/** 环境自查项。status 用三态而非布尔:大多数项客户端无法确知,只能提示去查。 */
function Checklist({
  items,
}: {
  items: { icon: React.ReactNode; label: string; status: "ok" | "bad" | "unknown" }[];
}) {
  return (
    <div className="chk">
      {items.map((item) => (
        <div className="ci" key={item.label}>
          <span className={`cdot ${item.status}`} aria-hidden="true" />
          <span aria-hidden="true" style={{ display: "grid", placeItems: "center" }}>
            {item.icon}
          </span>
          <span>{item.label}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * 重连中 —— 重点是「任务没有中断」。
 *
 * 倒计时是本地推进的展示值:store 的重连节奏由它自己控制,这里只给用户一个
 * 「还要等多久」的预期,以及一个立即重试的出口。
 */
export const ReconnectingView = memo(function ReconnectingView({
  retryIntervalMs = 2500,
  onRetryNow,
}: {
  retryIntervalMs?: number;
  onRetryNow: () => void;
}) {
  const [secs, setSecs] = useState(Math.ceil(retryIntervalMs / 1000));

  useEffect(() => {
    const tick = window.setInterval(() => {
      setSecs((s) => (s <= 1 ? Math.ceil(retryIntervalMs / 1000) : s - 1));
    }, 1000);
    return () => window.clearInterval(tick);
  }, [retryIntervalMs]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      style={{ padding: "0 16px", display: "flex", flexDirection: "column", gap: 14 }}
    >
      <MobileCard style={{ padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          {/* 全屏唯一动画元素 */}
          <Loader2
            size={18}
            className="pi-spin"
            style={{ color: "var(--color-status-degraded)", flexShrink: 0 }}
            aria-hidden="true"
          />
          <h2 style={{ fontSize: 17, fontWeight: 650, margin: 0 }}>
            {t("connection.reconnectingTitle")}
          </h2>
        </div>
        <p
          style={{
            fontSize: 14,
            lineHeight: 1.55,
            color: "var(--color-text-secondary)",
            margin: "0 0 12px",
          }}
        >
          {t("connection.reconnectingDetail")}
        </p>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            color: "var(--color-text-tertiary)",
            marginBottom: 12,
          }}
        >
          {t("connection.retryIn", { s: secs })}
        </div>
        <BlockButton variant="outline" onClick={onRetryNow}>
          {t("connection.retryNow")}
        </BlockButton>
      </MobileCard>
    </motion.div>
  );
});

/**
 * 已离线 —— 自查清单 + 唤醒出口 + 离线可查看的缓存任务。
 *
 * 缓存任务区整体降不透明度并标注缓存时间,避免用户把陈旧状态当成实时状态。
 */
export const OfflineView = memo(function OfflineView({
  canWake,
  cachedTasks,
  detail,
  onReconnect,
  onWake,
}: {
  canWake: boolean;
  cachedTasks: readonly RemoteTaskSnapshot[];
  detail?: string;
  onReconnect: () => void;
  onWake: () => void;
}) {
  const navigate = useNavigate();

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      style={{ padding: "0 16px", display: "flex", flexDirection: "column", gap: 14 }}
    >
      <MobileCard style={{ padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <WifiOff
            size={18}
            style={{ color: "var(--color-text-tertiary)", flexShrink: 0 }}
            aria-hidden="true"
          />
          <h2 style={{ fontSize: 17, fontWeight: 650, margin: 0 }}>
            {t("connection.offlineTitle")}
          </h2>
        </div>
        <p
          style={{
            fontSize: 14,
            lineHeight: 1.55,
            color: "var(--color-text-secondary)",
            margin: "0 0 4px",
          }}
        >
          {detail ?? t("error.unreachableDetail")}
        </p>

        <div style={{ margin: "8px 0 12px" }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--color-text-tertiary)",
              marginBottom: 2,
            }}
          >
            {t("connection.offlineChecklist")}
          </div>
          <Checklist
            items={[
              {
                icon: <Monitor size={14} />,
                label: t("connection.checkPower"),
                status: "unknown",
              },
              {
                icon: <Terminal size={14} />,
                label: t("connection.checkProcess"),
                status: "unknown",
              },
              {
                icon: <Wifi size={14} />,
                label: t("connection.checkNetwork"),
                status: "unknown",
              },
            ]}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {canWake && (
            <BlockButton variant="primary" onClick={onWake}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  justifyContent: "center",
                }}
              >
                <Power size={16} aria-hidden="true" />
                {t("wake.action")}
              </span>
            </BlockButton>
          )}
          <BlockButton variant={canWake ? "outline" : "primary"} onClick={onReconnect}>
            {t("connection.reconnect")}
          </BlockButton>
        </div>
      </MobileCard>

      {/* 离线可查看 —— 明确标注这是缓存,不是实时 */}
      {cachedTasks.length > 0 && (
        <div>
          <SectionLabel>{t("connection.cachedTasks")}</SectionLabel>
          <div style={{ opacity: 0.62 }}>
            {cachedTasks.map((task) => (
              <button
                key={task.taskId}
                className="task-card"
                onClick={() => navigate(`/tasks/${encodeURIComponent(task.taskId)}`)}
              >
                <span className="tdot done" />
                <span className="tmain">
                  <span className="ttitle">{task.taskId}</span>
                  <span className="tmeta">
                    {t("connection.cachedAt", { time: formatClock(task.updatedAt) })}
                  </span>
                </span>
                <ChevronRight size={16} className="chev" />
              </button>
            ))}
          </div>
        </div>
      )}
    </motion.div>
  );
});

/** 正在唤醒 —— 给出已等待时长,让用户判断是不是该放弃。 */
export const WakingView = memo(function WakingView({ onCancel }: { onCancel: () => void }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const tick = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(tick);
  }, []);

  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      style={{ padding: "0 16px" }}
    >
      <MobileCard style={{ padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <Power
            size={18}
            style={{ color: "var(--color-accent)", flexShrink: 0 }}
            aria-hidden="true"
          />
          <h2 style={{ fontSize: 17, fontWeight: 650, margin: 0 }}>
            {t("connection.wakingTitle")}
          </h2>
        </div>
        <p
          style={{
            fontSize: 14,
            lineHeight: 1.55,
            color: "var(--color-text-secondary)",
            margin: "0 0 12px",
          }}
        >
          {t("connection.wakingDetail")}
        </p>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 12px",
            marginBottom: 12,
            borderRadius: "var(--radius-sm)",
            background: "var(--color-bg-sunken)",
          }}
        >
          <span style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
            {t("connection.waitedFor")}
          </span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 15,
              fontWeight: 600,
              color: "var(--color-text-primary)",
            }}
          >
            {mm}:{ss}
          </span>
        </div>
        <BlockButton variant="outline" onClick={onCancel}>
          {t("common.cancel")}
        </BlockButton>
      </MobileCard>
    </motion.div>
  );
});

/** 身份校验失败 —— 安全性事件,给出错误码但默认动作是重新配对。 */
export const IdentityFailedView = memo(function IdentityFailedView({
  detail,
  onRepair,
}: {
  detail?: string | null;
  onRepair: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      style={{ padding: "0 16px" }}
    >
      <MobileCard style={{ padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <ShieldAlert
            size={18}
            style={{ color: "var(--color-danger)", flexShrink: 0 }}
            aria-hidden="true"
          />
          <h2 style={{ fontSize: 17, fontWeight: 650, margin: 0 }}>
            {t("connection.identityFailedTitle")}
          </h2>
        </div>
        <p
          style={{
            fontSize: 14,
            lineHeight: 1.55,
            color: "var(--color-text-secondary)",
            margin: "0 0 12px",
          }}
        >
          {t("connection.identityFailedDetail")}
        </p>

        {detail && (
          <details style={{ marginBottom: 12 }}>
            <summary
              style={{
                fontSize: 13,
                color: "var(--color-text-secondary)",
                cursor: "pointer",
                minHeight: "var(--tap-min)",
                display: "flex",
                alignItems: "center",
              }}
            >
              {t("connection.errorTrace")}
            </summary>
            <p
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                lineHeight: 1.5,
                color: "var(--color-text-tertiary)",
                wordBreak: "break-word",
                margin: "6px 0 0",
              }}
            >
              {detail}
            </p>
          </details>
        )}

        <BlockButton variant="primary" onClick={onRepair}>
          {t("connection.repair")}
        </BlockButton>
      </MobileCard>
    </motion.div>
  );
});

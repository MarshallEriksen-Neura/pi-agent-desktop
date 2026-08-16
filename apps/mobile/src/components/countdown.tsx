import { memo, useEffect, useState } from "react";
import { Timer } from "lucide-react";
import { t } from "@/i18n";

/** 进入 urgent 的阈值 —— 剩余不足 1 分钟。 */
const URGENT_MS = 60_000;
/** 进入 warn 的阈值 —— 剩余不足 3 分钟。 */
const WARN_MS = 180_000;

function fmt(ms: number): string {
  if (ms <= 0) return "--:--";
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Countdown — 交互请求的剩余时间。
 *
 * 交互请求带 expiresAt(见 RemoteInteractionSnapshot),过期后 agent 会按默认
 * 方式继续。用户必须知道还剩多久,否则「待我处理」列表就是一堆没有时间概念的
 * 待办 —— 这是设计稿里原本缺的一环。
 *
 * 一个组件一个 1s 定时器。设计稿曾为 30 根 sparkline 各起一个 setInterval,
 * 那是手机上持续耗电的做法;这里的定时器数量等于「屏上可见的待处理卡片数」,
 * 且到期即自行停止。
 */
export const Countdown = memo(function Countdown({
  expiresAt,
  onExpire,
}: {
  /** ISO 时间戳。 */
  expiresAt: string;
  onExpire?: () => void;
}) {
  const target = new Date(expiresAt).getTime();
  const [remain, setRemain] = useState(() => target - Date.now());

  useEffect(() => {
    // 已过期:不起定时器。
    if (target - Date.now() <= 0) {
      setRemain(0);
      return;
    }
    const tick = window.setInterval(() => {
      const next = target - Date.now();
      setRemain(next);
      if (next <= 0) {
        window.clearInterval(tick);
        onExpire?.();
      }
    }, 1000);
    return () => window.clearInterval(tick);
  }, [target, onExpire]);

  const expired = remain <= 0;
  const cls = expired
    ? "done"
    : remain < URGENT_MS
      ? "urgent"
      : remain < WARN_MS
        ? "warn"
        : "";

  return (
    <span
      className={`cd${cls ? ` ${cls}` : ""}`}
      // 秒级刷新对读屏是噪音;只播报状态变化,不逐秒念数字。
      aria-label={expired ? t("interaction.expired") : t("interaction.remaining")}
    >
      <Timer size={13} aria-hidden="true" />
      <span aria-hidden={!expired}>{fmt(remain)}</span>
    </span>
  );
});

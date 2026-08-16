import { memo, useCallback, useEffect, useRef, useState } from "react";
import { t } from "@/i18n";

/**
 * LongPressButton — 不可逆操作的确认闸门。
 *
 * 为什么不是「单击 + 确认弹窗」:远程批准合并这类操作在手机上误触代价不对称
 * (点错就推到远端,撤不回来),而弹窗会训练出「无脑点第二下」的肌肉记忆。
 * 长按把成本放在同一个手势里 —— 手指离开即取消,不产生任何副作用。
 *
 * 实现要点:
 *  - 进度条用 CSS transition(GPU 合成),不用 JS 逐帧;reduced-motion 下
 *    global.css 会把 transition 压到 0.01ms,此时进度条瞬间填满,但 onConfirm
 *    仍由 setTimeout 计时触发,所以时长语义不受影响。
 *  - pointer 事件而非 touch/mouse 双轨:统一处理触屏与鼠标,且 pointercancel
 *    (系统手势打断、来电)能正确取消。
 *  - 键盘可达:Space/Enter 按住同样计时,松开取消。
 */
export const LongPressButton = memo(function LongPressButton({
  children,
  onConfirm,
  durationMs = 1000,
  danger,
  disabled,
  hint,
  icon,
}: {
  children: React.ReactNode;
  onConfirm: () => void;
  /** 按住多久触发。批准类 1000ms,信任新证书这类更危险的用 2000ms。 */
  durationMs?: number;
  danger?: boolean;
  disabled?: boolean;
  /** 覆盖按钮上的提示语,默认「长按批准」/「长按 Ns 确认」。 */
  hint?: string;
  icon?: React.ReactNode;
}) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<number | null>(null);
  const fired = useRef(false);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const start = useCallback(() => {
    if (disabled || timer.current !== null) return;
    fired.current = false;
    setHolding(true);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      fired.current = true;
      setHolding(false);
      onConfirm();
    }, durationMs);
  }, [disabled, durationMs, onConfirm]);

  const cancel = useCallback(() => {
    clear();
    setHolding(false);
  }, [clear]);

  // 卸载时清理:计时中被路由切走不该在卸载后触发 onConfirm。
  useEffect(() => clear, [clear]);

  return (
    <button
      className={`lp${danger ? " danger" : ""}${holding ? " holding" : ""}`}
      style={{ ["--lp-dur" as string]: `${durationMs}ms` }}
      disabled={disabled}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          start();
        }
      }}
      onKeyUp={cancel}
      // 长按语义对读屏用户不可见,所以把「需要长按」写进无障碍名称。
      aria-label={`${typeof children === "string" ? children : ""} — ${
        hint ?? t("confirm.longPress")
      }`}
    >
      <span className="lpfill" aria-hidden="true" />
      <span className="lpc">
        {icon}
        {children}
      </span>
    </button>
  );
});

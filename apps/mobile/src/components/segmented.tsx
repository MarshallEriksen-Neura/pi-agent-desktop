import { memo } from "react";

export interface Segment<T extends string> {
  readonly key: T;
  readonly label: string;
  /** 数量徽标。0 或 undefined 时不显示。 */
  readonly count?: number;
  /** 标记为「待我处理」语义,选中时计数用 awaiting 紫而非 accent 蓝。 */
  readonly awaiting?: boolean;
}

/**
 * SegmentedControl — iOS 分段控件。
 *
 * 设计稿给的段高是 36px,低于 HIG 44px 最小可点尺寸;这里在 CSS 里锁到
 * --tap-min。分段控件是任务中心的主导航,它比页面里任何其他控件都更需要
 * 一次点准。
 *
 * 用 role="tablist" 而非一组普通 button:读屏会播报「第 N 项,共 M 项」,
 * 这对「待处理 / 进行中 / 已完成 / 全部」这种平级切换是正确语义。
 */
export const SegmentedControl = memo(function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  label,
}: {
  segments: readonly Segment<T>[];
  value: T;
  onChange: (key: T) => void;
  /** tablist 的无障碍名称,例如「任务筛选」。 */
  label: string;
}) {
  return (
    <div className="seg" role="tablist" aria-label={label}>
      {segments.map((seg) => (
        <button
          key={seg.key}
          role="tab"
          aria-selected={value === seg.key}
          className={seg.awaiting ? "awaiting" : undefined}
          onClick={() => onChange(seg.key)}
        >
          <span>{seg.label}</span>
          {seg.count ? <span className="segc">{seg.count}</span> : null}
        </button>
      ))}
    </div>
  );
}) as <T extends string>(props: {
  segments: readonly Segment<T>[];
  value: T;
  onChange: (key: T) => void;
  label: string;
}) => React.ReactElement;

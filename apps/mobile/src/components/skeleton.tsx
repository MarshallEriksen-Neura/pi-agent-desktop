import { memo } from "react";

/**
 * 骨架占位 — 形状必须与真实内容一致。
 *
 * 光转圈只告诉用户「在等」,骨架还告诉用户「等到的是什么形状」,页面落地时
 * 不会发生布局跳动。动画是水墨渗染式的明暗呼吸(pi-ink-wash),不是生硬的
 * 线性 shimmer —— 对齐 Ink & Logic 的材质语言。
 */

/** 单条骨架线。width 传 CSS 长度或百分比。 */
export const SkeletonLine = memo(function SkeletonLine({
  width = "100%",
  variant = "line",
}: {
  width?: string;
  variant?: "line" | "title" | "block";
}) {
  return <div className={`sk ${variant}`} style={{ width }} aria-hidden="true" />;
});

/**
 * 任务卡片骨架 —— 模拟 TaskCard 的标题行 / 进度条 / 日志行三段结构。
 * count 默认 3:比一屏能放的数量少一点,避免骨架自己撑出滚动条。
 */
export const TaskCardSkeleton = memo(function TaskCardSkeleton({
  count = 3,
}: {
  count?: number;
}) {
  return (
    <div role="status" aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <div className="sk-card" key={i}>
          <SkeletonLine width="62%" variant="title" />
          <SkeletonLine width="100%" />
          <SkeletonLine width="45%" />
        </div>
      ))}
    </div>
  );
});

/** 列表行骨架 —— 用于项目列表、文件树这类等高行。 */
export const ListSkeleton = memo(function ListSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div role="status" aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <div className="sk-card" key={i} style={{ gap: 8 }}>
          <SkeletonLine width={`${72 - i * 6}%`} variant="title" />
          <SkeletonLine width="38%" />
        </div>
      ))}
    </div>
  );
});

/** 详情页骨架 —— 标题块 + 段落 + 代码块。 */
export const DetailSkeleton = memo(function DetailSkeleton() {
  return (
    <div role="status" aria-busy="true" style={{ padding: "4px 0" }}>
      <div className="sk-card">
        <SkeletonLine width="55%" variant="title" />
        <SkeletonLine width="30%" />
      </div>
      <div className="sk-card">
        <SkeletonLine width="100%" />
        <SkeletonLine width="92%" />
        <SkeletonLine width="68%" />
      </div>
      <div className="sk-card">
        <SkeletonLine width="100%" variant="block" />
      </div>
    </div>
  );
});

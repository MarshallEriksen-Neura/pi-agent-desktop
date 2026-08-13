import { memo } from "react";
import { motion } from "motion/react";
import {
  FileText,
  Pencil,
  Terminal,
  Search,
  Wrench,
  MessageSquare,
  Check,
  Clock,
} from "lucide-react";
import { t } from "@/i18n";
import type { ToolInvocation } from "@/lib/transcript";

/**
 * 对话转录视觉组件 — 把 lib/transcript.ts 折好的条目渲染成 iMessage 风格对话。
 *
 * 分工:transcript.ts 负责「什么该合并、什么该独立」的逻辑(可单测);
 * 本文件只负责视觉,不做数据判断。
 */

/** 用户 / 助手气泡。user 蓝色右对齐,assistant 灰色左对齐。 */
export const MessageBubble = memo(function MessageBubble({
  role,
  text,
  time,
}: {
  role: "user" | "assistant";
  text: string;
  time?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 320, damping: 26 }}
      className={`msg ${role}`}
    >
      <div className="bubble">{text}</div>
      {time && <span className="msg-time">{time}</span>}
    </motion.div>
  );
});

/** 三点波动 — 任务活跃但还没有输出时显示,让等待可感知。 */
export const ThinkingDots = memo(function ThinkingDots() {
  return (
    <div className="thinking" role="status" aria-label={t("chat.thinking")}>
      <i />
      <i />
      <i />
    </div>
  );
});

/** 工具名 → 图标 + 配色 + 本地化标签。未知工具回退到通用扳手。 */
function toolPresentation(name: string): {
  icon: React.ReactNode;
  color: string;
  label: string;
} {
  const n = name.toLowerCase();
  if (n.includes("edit") || n.includes("write") || n.includes("patch")) {
    return {
      icon: <Pencil size={15} />,
      color: "var(--color-accent)",
      label: t("chat.toolEdit"),
    };
  }
  if (n.includes("read") || n.includes("cat") || n.includes("view")) {
    return {
      icon: <FileText size={15} />,
      color: "var(--color-success)",
      label: t("chat.toolRead"),
    };
  }
  if (n.includes("bash") || n.includes("shell") || n.includes("exec")) {
    return {
      icon: <Terminal size={15} />,
      color: "#ff9f0a",
      label: t("chat.toolBash"),
    };
  }
  if (n.includes("search") || n.includes("grep") || n.includes("glob")) {
    return {
      icon: <Search size={15} />,
      color: "var(--color-status-awaiting)",
      label: t("chat.toolSearch"),
    };
  }
  return {
    icon: <Wrench size={15} />,
    color: "var(--color-text-secondary)",
    label: name,
  };
}

/** 工具调用卡 — 图标 + 目标文件/命令 + 运行状态。 */
export const ToolCard = memo(function ToolCard({ tool }: { tool: ToolInvocation }) {
  const { icon, color, label } = toolPresentation(tool.name);
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 320, damping: 26 }}
      className={`toolcard${tool.isError ? " error" : ""}`}
    >
      <span
        className="ticon"
        style={{
          background: `color-mix(in srgb, ${color} 16%, transparent)`,
          color,
        }}
      >
        {icon}
      </span>
      <div className="tbody">
        <div className="tlabel">{label}</div>
        {tool.target && <div className="ttarget">{tool.target}</div>}
        <div className={`tstate${tool.isError ? " err" : ""}`}>
          {tool.isError
            ? t("chat.toolFailed")
            : tool.ended
              ? t("chat.toolDone")
              : t("chat.toolRunning")}
        </div>
      </div>
    </motion.div>
  );
});

/** stderr 警告块 — 与正文分离,避免诊断信息污染阅读。 */
export const WarningBlock = memo(function WarningBlock({ text }: { text: string }) {
  return <div className="warnblock">{text}</div>;
});

/** 系统提示 — 输出截断、无法解析的 tool 载荷等。居中弱化。 */
export const SystemNote = memo(function SystemNote({ text }: { text: string }) {
  return <div className="sysnote">{text}</div>;
});

/**
 * 内嵌交互卡外壳 — 待回答的请求直接长在对话流里,保留上下文。
 * 表单本体由调用方传入(confirm/select/input 三种形态复用 InteractionsPage 的组件)。
 */
export const InlineInteraction = memo(function InlineInteraction({
  countdown,
  children,
}: {
  countdown?: string;
  children: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: "spring", stiffness: 320, damping: 26 }}
      className="ix-inline"
    >
      <div className="ixhead">
        <span className="ixicon">
          <MessageSquare size={13} />
        </span>
        <span className="ixtitle">{t("chat.piWantsAction")}</span>
        {countdown && <span className="ixcd">{countdown}</span>}
      </div>
      {children}
    </motion.div>
  );
});

/** 已回答/已过期的交互 — 折叠成一行摘要,可追溯但不占地方。 */
export const ResolvedInteraction = memo(function ResolvedInteraction({
  prompt,
  answer,
  expired,
}: {
  prompt: string;
  answer: string;
  expired?: boolean;
}) {
  const color = expired ? "var(--color-text-tertiary)" : "var(--color-success)";
  return (
    <div className="ix-resolved">
      <span
        className="ricon"
        style={{
          background: `color-mix(in srgb, ${color} 16%, transparent)`,
          color,
        }}
      >
        {expired ? <Clock size={12} /> : <Check size={12} />}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="rprompt">{prompt}</div>
        <div className="ranswer" style={{ color }}>
          {answer}
        </div>
      </div>
    </div>
  );
});

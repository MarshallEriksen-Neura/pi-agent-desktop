import { memo, useState } from "react";
import { Streamdown } from "streamdown";
import { Check, Copy } from "lucide-react";
import { t } from "@/i18n";

/**
 * Markdown 渲染 — 复用桌面端(src/components/StreamdownRenderer.tsx)同款
 * streamdown 解析链:GFM 表格/嵌套列表/删除线、流式半截 markdown 补全、
 * rehype-sanitize(与旧手写解析器「绝不注入 HTML」的立场一致)。
 *
 * 刻意不取用 streamdown 的内置 UI:代码块 chrome、表格复制下拉、链接确认
 * 弹窗都是 Tailwind 类驱动,移动端没有 Tailwind,裸样式会碎一地 —— 所以
 * controls/linkSafety 全关,代码块走本地 BlockCode,其余元素由 components.css
 * 按 `.md-root` 纯 CSS 接管。语法高亮(shiki)留待后续按需引入。
 */

/** 块级代码 — 深底 + 圆角 + 等宽 + 复制。触屏没有 hover,复制按钮常显。 */
function BlockCode({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(codeText(children)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="md-codeblock">
      <button type="button" className="md-copy" onClick={copy} aria-label={t("chat.copyCode")}>
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
      <pre>
        <code>{children}</code>
      </pre>
    </div>
  );
}

/** hast 文本节点在 React 里是 string(或其数组);非文本片段丢弃。 */
function codeText(children: React.ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) {
    return children
      .map((part) => (typeof part === "string" || typeof part === "number" ? String(part) : ""))
      .join("");
  }
  return "";
}

/** code 元素统一入口:块级代码由默认 pre 渲染器打上 data-block → BlockCode;
 *  行内代码 → md-inline。模块级常量保持引用稳定(streamdown 按引用 memo)。 */
const markdownComponents = {
  code(props: React.ComponentProps<"code"> & { node?: unknown }) {
    if ("data-block" in props) {
      return <BlockCode>{props.children}</BlockCode>;
    }
    return <code className="md-inline">{props.children}</code>;
  },
};

/** 主入口: 一段 assistant 文本 → 渲染好的 markdown。签名与旧实现一致,调用方无感。 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md-root">
      <Streamdown
        mode="streaming"
        parseIncompleteMarkdown
        components={markdownComponents}
        controls={{ table: false, code: false }}
        linkSafety={{ enabled: false }}
      >
        {text}
      </Streamdown>
    </div>
  );
});

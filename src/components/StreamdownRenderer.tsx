"use client";

import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";

interface StreamdownRendererProps {
  text: string;
  animating: boolean;
}

/**
 * Isolated so the entire streamdown + shiki (code-highlight) chain lives in its
 * own chunk. MessageBubble loads this via next/dynamic (ssr:false), keeping it
 * out of the route's First Load JS — it's only fetched once a message has text.
 */
export function StreamdownRenderer({ text, animating }: StreamdownRendererProps) {
  return (
    <Streamdown isAnimating={animating} plugins={{ code }}>
      {text}
    </Streamdown>
  );
}

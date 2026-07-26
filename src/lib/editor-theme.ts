import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/**
 * Pi editor theme — every color is a CSS variable from globals.css,
 * so light/dark switching is automatic and instant. No JS theme swap needed.
 */
export const piTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13.5px",
    backgroundColor: "transparent",
    color: "var(--text-primary)",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.7",
    overflow: "auto",
  },
  ".cm-content": {
    caretColor: "var(--accent)",
    padding: "16px 0 48vh 0", // scroll-past-end for immersive focus
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--accent)",
    borderLeftWidth: "2px",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
    {
      backgroundColor: "var(--accent-muted) !important",
    },
  ".cm-activeLine": {
    backgroundColor: "var(--accent-muted)",
    borderRadius: "4px",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--text-tertiary)",
    border: "none",
    paddingLeft: "8px",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--text-secondary)",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "38px",
    padding: "0 14px 0 0",
    userSelect: "none",
  },
  "&.cm-focused": { outline: "none" },

  /* streaming-diff line marks (iOS low-saturation treatment).
     Fade-out happens by swapping to .pi-stream-fade — the transition lives
     only on these two classes so cursor-line highlights stay instant. */
  ".cm-line.pi-stream-add": {
    backgroundColor: "var(--diff-add-bg)",
    borderRadius: "4px",
    transition: "background-color 0.6s var(--spring-smooth)",
  },
  ".cm-line.pi-stream-fade": {
    backgroundColor: "transparent",
    borderRadius: "4px",
    transition: "background-color 0.6s var(--spring-smooth)",
  },
});

/** Syntax palette — restrained, from the same iOS primitives. */
export const piHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: "var(--ios-purple)" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--accent)" },
    { tag: [t.typeName, t.className, t.namespace], color: "var(--ios-teal)" },
    { tag: [t.string, t.special(t.string), t.regexp], color: "var(--ios-orange)" },
    { tag: [t.number, t.bool, t.null], color: "var(--ios-green)" },
    { tag: [t.comment, t.blockComment, t.lineComment], color: "var(--text-tertiary)", fontStyle: "italic" },
    { tag: [t.propertyName, t.attributeName], color: "var(--text-primary)" },
    { tag: [t.variableName, t.definition(t.variableName)], color: "var(--text-primary)" },
    { tag: [t.punctuation, t.bracket, t.operator], color: "var(--text-secondary)" },
  ])
);

/**
 * Slim stand-in for shiki's default `bundle-full` entry.
 *
 * `next.config.ts` aliases the bare `shiki` specifier to this module. The only
 * importer is `@streamdown/code`, which pulls three symbols —
 * `bundledLanguages`, `bundledLanguagesInfo`, `createHighlighter` — and
 * evaluates the first two at module scope:
 *
 *     C = Object.fromEntries(bundledLanguagesInfo.flatMap(...))  // alias table
 *     r = new Set(Object.keys(bundledLanguages))                 // supported set
 *
 * `Object.keys()` needs the whole record to exist, so shiki's barrel cannot be
 * tree-shaken. Importing `shiki` therefore put **332** language entries (235
 * distinct grammar files plus alias keys) and **65** themes into the webpack
 * graph as separately-emitted chunks, each with its own AST, module-graph node,
 * and Terser pass — for a UI that only ever renders two themes. That bookkeeping
 * is the bulk of `next build`'s memory use here.
 *
 * Measured after this change: 34 languages / 18 aliases / 2 themes.
 *
 * Shipping an explicit list keeps the same interface shape while cutting the
 * graph to the languages below plus two themes.
 *
 * `shiki/bundle/web` was the obvious alternative and is the wrong fit: its 57
 * languages are web-oriented and omit rust, go, toml, diff, and dockerfile —
 * this app's own stack. Code fences in those would degrade to plain text.
 *
 * **Adding a language:** add the id to LANGS. It must be a real shiki id (see
 * `@shikijs/langs`), not an alias — aliases come free via the `aliases`
 * metadata below, which is how ```bash resolves to shellscript. An unlisted
 * language is not an error: `@streamdown/code` falls back to `text`.
 */
import {
  createBundledHighlighter,
  createSingletonShorthands,
  guessEmbeddedLanguages,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

export * from "shiki/core";

/**
 * Mainstream development languages. Static `import()` calls, so webpack emits
 * one lazily-fetched chunk per entry — nothing is loaded until a fence uses it.
 */
const LANGS = {
  // web / TS
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  html: () => import("@shikijs/langs/html"),
  css: () => import("@shikijs/langs/css"),
  scss: () => import("@shikijs/langs/scss"),
  vue: () => import("@shikijs/langs/vue"),
  svelte: () => import("@shikijs/langs/svelte"),
  graphql: () => import("@shikijs/langs/graphql"),
  // systems
  rust: () => import("@shikijs/langs/rust"),
  go: () => import("@shikijs/langs/go"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  java: () => import("@shikijs/langs/java"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  swift: () => import("@shikijs/langs/swift"),
  // scripting
  python: () => import("@shikijs/langs/python"),
  ruby: () => import("@shikijs/langs/ruby"),
  php: () => import("@shikijs/langs/php"),
  lua: () => import("@shikijs/langs/lua"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  powershell: () => import("@shikijs/langs/powershell"),
  // data / config / prose
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  ini: () => import("@shikijs/langs/ini"),
  xml: () => import("@shikijs/langs/xml"),
  sql: () => import("@shikijs/langs/sql"),
  markdown: () => import("@shikijs/langs/markdown"),
  diff: () => import("@shikijs/langs/diff"),
  docker: () => import("@shikijs/langs/docker"),
} as const;

/** Only what the UI renders. shiki's own barrel ships 65. */
const THEMES = {
  "github-light": () => import("@shikijs/themes/github-light"),
  "github-dark": () => import("@shikijs/themes/github-dark"),
} as const;

/**
 * Alias metadata, mirroring the shape `@streamdown/code` reads. Values are
 * copied from `@shikijs/langs`; keep them in sync when adding a language, since
 * a missing alias silently drops highlighting for that fence tag.
 */
const ALIASES: Record<string, string[]> = {
  typescript: ["ts"],
  javascript: ["js"],
  shellscript: ["bash", "sh", "shell", "zsh"],
  python: ["py"],
  ruby: ["rb"],
  csharp: ["c#", "cs"],
  cpp: ["c++"],
  markdown: ["md"],
  yaml: ["yml"],
  docker: ["dockerfile"],
  powershell: ["ps", "ps1"],
  kotlin: ["kt", "kts"],
};

/** Display names, used by `getSupportedLanguages()` consumers. */
const NAMES: Record<string, string> = {
  typescript: "TypeScript",
  tsx: "TSX",
  javascript: "JavaScript",
  jsx: "JSX",
  html: "HTML",
  css: "CSS",
  scss: "SCSS",
  vue: "Vue",
  svelte: "Svelte",
  graphql: "GraphQL",
  rust: "Rust",
  go: "Go",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  java: "Java",
  kotlin: "Kotlin",
  swift: "Swift",
  python: "Python",
  ruby: "Ruby",
  php: "PHP",
  lua: "Lua",
  shellscript: "Shell",
  powershell: "PowerShell",
  json: "JSON",
  jsonc: "JSON with Comments",
  yaml: "YAML",
  toml: "TOML",
  ini: "INI",
  xml: "XML",
  sql: "SQL",
  markdown: "Markdown",
  diff: "Diff",
  docker: "Dockerfile",
};

export const bundledLanguages = LANGS;
export const bundledThemes = THEMES;

export const bundledLanguagesInfo = Object.keys(LANGS).map((id) => ({
  id,
  name: NAMES[id] ?? id,
  aliases: ALIASES[id],
  import: LANGS[id as keyof typeof LANGS],
}));

export const bundledThemesInfo = Object.keys(THEMES).map((id) => ({
  id,
  name: id,
  import: THEMES[id as keyof typeof THEMES],
}));

/**
 * The JS regex engine is the default here, unlike shiki's entry which defaults
 * to oniguruma and would drag `shiki/wasm` in. `@streamdown/code` passes its own
 * engine per call anyway, so this default just keeps the wasm blob out of the
 * graph.
 */
export const createHighlighter = createBundledHighlighter({
  langs: LANGS,
  themes: THEMES,
  engine: () => createJavaScriptRegexEngine({ forgiving: true }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any);

export const {
  codeToHtml,
  codeToHast,
  codeToTokens,
  codeToTokensBase,
  codeToTokensWithThemes,
  getSingletonHighlighter,
  getLastGrammarState,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} = createSingletonShorthands(createHighlighter as any, {
  guessEmbeddedLanguages,
});

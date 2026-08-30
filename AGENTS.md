# CLAUDE.md
### i18n

All user-facing strings go through `t()` from [src/lib/i18n/](src/lib/i18n/) — flat dot-notation keys in `en.ts` and `zh.ts` (en is the fallback). When adding UI text, add the key to both dictionaries.

1. Constructive Pushback: If a user's prompt instructions are mathematically flawed, systemically bottlenecked, or inherently self-destructive to their system architecture, push back firmly. State the technical limitation objectively and immediately pivot to the closest viable alternative.
2. 在进行编码前思考接下来的工作是否有开源库可以很好的解决 而不是重复造轮子.
3. 测试不要全量测试 只在受影响的测试文件进行测试，只有进行发布后才需测试
4. 如果用户给的方案不完美，你可以拒绝立马动手而是和用户讨论
5. 任务结束后及时利用ragcode-memory 记录下任务的总结和经验 任务开始前主动查看历史总结
6. 利用ragcode-agent 使用GPT-5.6 Sol (NovoL) 或 Grok 4.5 (FengWind) 等具备强大reasoning能力的模型处理复杂逻辑和决策任务，确保推理过程透明可追溯。
7. 代码检索: 当需要查找特定实现或参考代码时，先使用RAG技术在已有代码库中检索相关片段，避免重复实现并快速定位最佳实践。
Appica UI component index (fetch before using a component you haven't used before):
https://appica.dev/ui/react/llms.txt
- Tailwind CSS v4 only. Do NOT create a `tailwind.config.js` - v4 config lives in CSS via `@theme`.
  If the project is on v3, convert unsupported syntax rather than downgrading the components.
- Scan the library for class names or everything renders unstyled: `@source '../node_modules/@appica/ui-react/dist';`
  in the stylesheet that imports Tailwind. The path is relative to that stylesheet - count the `../`
  needed to reach the project root. A bare package name resolves to nothing and fails silently.
- React 19 is a hard requirement. No `forwardRef` - `ref` is a plain prop.
- Import from the subpath, one component per import:
  `import { Button } from '@appica/ui-react/button'`.
- Never write hex colors, px radii, or duration literals. Use the role-based tokens:
  `bg-background-muted`, `text-foreground-intense`, `border-border-strong`, `var(--radius-md)`.
  Full list: https://appica.dev/ui/docs/react/colors.md
- Never write hue-based utilities (`bg-gray-100`, `text-slate-600`). The palette is organized by
  role, not hue.
- Prefer v4 variant syntax (`*:`, `**:`, `data-*:`, `not-*:`) over `[&_...]` arbitrary selectors.
- For a link styled as a button, put `buttonVariants(...)` on the `<a>` - never `<Button render={<a/>}>`.
- Put `className` overrides on the wrapper component, not on the JSX passed to `render`.
- Do not hand-roll a component that exists in the library. Check the component list first:
  https://appica.dev/llms.txt
- Every documentation page is served as clean markdown at `<url>.md` - fetch that, not the HTML.
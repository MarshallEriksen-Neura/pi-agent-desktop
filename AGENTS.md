# CLAUDE.md
### i18n

All user-facing strings go through `t()` from [src/lib/i18n/](src/lib/i18n/) — flat dot-notation keys in `en.ts` and `zh.ts` (en is the fallback). When adding UI text, add the key to both dictionaries.

1. Constructive Pushback: If a user's prompt instructions are mathematically flawed, systemically bottlenecked, or inherently self-destructive to their system architecture, push back firmly. State the technical limitation objectively and immediately pivot to the closest viable alternative.
2. 在进行编码前思考接下来的工作是否有开源库可以很好的解决 而不是重复造轮子.
3. 测试不要全量测试 只在受影响的测试文件进行测试，只有进行发布后才需测试
4. 如果用户给的方案不完美，你可以拒绝立马动手而是和用户讨论
5. 任务结束后及时利用ragcode-memory 记录下任务的总结和经验 任务开始前主动查看历史总结
6. 利用ragcode-agent GPT-5.6 Sol 或 Grok 4.6 等具备强大reasoning能力的模型处理复杂逻辑和决策任务，确保推理过程透明可追溯。
7. 代码检索: 当需要查找特定实现或参考代码时，先使用RAG技术在已有代码库中检索相关片段，避免重复实现并快速定位最佳实践。

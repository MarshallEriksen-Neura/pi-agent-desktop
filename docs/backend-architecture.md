# Frontend backend boundary

Pi Desktop separates product state from platform APIs through capability ports.

```text
BackendProvider
  -> desktop composition -> src/lib/backend/desktop/** -> Tauri commands/plugins
  -> browser composition -> src/lib/backend/mock/**    -> preview implementations
```

- Ports live in `src/lib/backend/ports/` and expose domain operations rather than arbitrary command strings.
- `src/lib/backend/desktop/**` is the only frontend directory allowed to import `@tauri-apps/*` or map desktop command names.
- Stores and components obtain capabilities through the fail-closed container. They must remain inert until `BackendProvider` has installed one composition.
- Desktop and browser adapters are imported through separate composition modules. Do not add a barrel that statically imports both.
- Mobile is a separate application boundary. It may share `@pi/remote-control-contracts`, but it must not import desktop stores, adapters, paths, Pi RPC commands, or browser mocks.

Focused checks:

```bash
pnpm test:backend
node scripts/check-backend-boundaries.mjs --strict
pnpm --filter @pi/remote-control-contracts typecheck
```

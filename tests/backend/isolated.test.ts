/**
 * Specs that need their own process.
 *
 * `all.test.ts` runs every spec in one process, which is fine for anything whose
 * setup is reversible. These are not: they drive the chat store's `init()`, and
 * `init()` subscribes to the global ext-ui store with no teardown. Clearing the
 * chat-store map leaves that subscriber alive, holding a closure over a client
 * the spec disposes on the way out — which then surfaces as an unrelated later
 * spec timing out on requests nobody answers.
 *
 * Run by `scripts/run-backend-tests.mjs` as a second `node --test` entry.
 */
import "./remote-exit-recovery.test";

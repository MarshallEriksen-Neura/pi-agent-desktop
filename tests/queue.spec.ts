/**
 * Mid-turn delivery: `steer` (interrupt) and `follow_up` (queue), plus `abort`.
 *
 * Drives the real composer against the mock pi transport (`pnpm dev` in a plain
 * browser), so no store internals are poked — everything goes through the UI the
 * way a user would.
 *
 * NOTE: the repo has no test runner wired up yet (no `@playwright/test`
 * dependency, no playwright.config, no `test` script), so this spec documents
 * and pins the intended behaviour rather than running in CI today. To run it:
 *   pnpm add -D @playwright/test && npx playwright install chromium
 *   npx playwright test --ui   # with `pnpm dev` on http://localhost:3000
 */
import { test, expect } from "@playwright/test";

/** ⌘⏎ on macOS, Ctrl+⏎ elsewhere — the composer accepts either */
const SUBMIT = process.platform === "darwin" ? "Meta+Enter" : "Control+Enter";
const SUBMIT_ALT = process.platform === "darwin" ? "Meta+Shift+Enter" : "Control+Shift+Enter";

test.describe("mid-turn delivery", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("aside.material textarea", { timeout: 5000 });
  });

  /** send `text` and wait until the mock turn is actually streaming */
  async function startTurn(page: import("@playwright/test").Page, text: string) {
    const composer = page.locator("aside.material textarea");
    await composer.fill(text);
    await composer.press(SUBMIT);
    // Stop replaces Send while a turn is in flight
    await expect(page.locator('aside.material button[title="Stop"]')).toBeVisible();
  }

  test("steer interrupts the running turn", async ({ page }) => {
    await startTurn(page, "first prompt");

    const composer = page.locator("aside.material textarea");
    await composer.fill("actually, do it differently");
    await composer.press(SUBMIT); // default delivery is Interrupt

    // pending chip reflects pi's own queue_update, not a local array
    await expect(page.getByText(/1 steering/)).toBeVisible();
    // the bubble is tagged so the transcript shows how it was delivered
    await expect(page.getByText("interrupted")).toBeVisible();

    // the mock injects at the next boundary and keeps the same turn going
    await expect(page.getByText(/steered mid-turn/)).toBeVisible({ timeout: 3000 });
    await expect(page.getByText(/1 steering/)).toBeHidden();
  });

  test("follow-up waits for the turn to end, then runs by itself", async ({ page }) => {
    await startTurn(page, "first prompt");

    const composer = page.locator("aside.material textarea");
    await composer.fill("and then run the tests");
    await composer.press(SUBMIT_ALT); // ⇧ flips Interrupt → Queue for one send

    await expect(page.getByText(/1 queued/)).toBeVisible();
    await expect(page.getByText("queued")).toBeVisible();

    // pi owns execution — the frontend must not re-send it as a fresh prompt
    await expect(page.getByText(/ran queued follow-up/)).toBeVisible({ timeout: 8000 });
    await expect(page.getByText(/1 queued/)).toBeHidden();
  });

  test("the delivery toggle switches what ⌘⏎ does", async ({ page }) => {
    await startTurn(page, "first prompt");

    await page.getByRole("button", { name: "Queue", exact: true }).click();
    const composer = page.locator("aside.material textarea");
    await composer.fill("queued via the toggle");
    await composer.press(SUBMIT);

    await expect(page.getByText(/1 queued/)).toBeVisible();
    await expect(page.getByText(/steering/)).toBeHidden();
  });

  test("abort drops what pi has not started yet", async ({ page }) => {
    await startTurn(page, "first prompt");

    const composer = page.locator("aside.material textarea");
    await composer.fill("never mind this one");
    await composer.press(SUBMIT_ALT); // queue it
    await expect(page.getByText(/1 queued/)).toBeVisible();

    await page.locator('aside.material button[title="Stop"]').click();

    // Stop is the only way back out — the chip goes with the turn
    await expect(page.getByText(/queued|steering/)).toBeHidden();
    await expect(page.locator('aside.material button[title="Stop"]')).toBeHidden();
  });

  test("nothing is queued when no turn is running", async ({ page }) => {
    const composer = page.locator("aside.material textarea");
    await composer.fill("plain prompt");
    await composer.press(SUBMIT);

    // goes out as a normal `prompt`, so no pending chip and no delivery tag
    await expect(page.getByText(/queued|steering/)).toBeHidden();
    await expect(page.getByText("interrupted")).toBeHidden();
  });
});

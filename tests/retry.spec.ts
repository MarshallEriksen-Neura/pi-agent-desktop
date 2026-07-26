import { test, expect } from "@playwright/test";

test.describe("Retry Toast", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Wait for app to initialize
    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 5000 });
  });

  test("toast appears on auto_retry_start event", async ({ page }) => {
    // Emit auto_retry_start event
    await page.evaluate(() => {
      const event = {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2000,
      };
      window.dispatchEvent(
        new CustomEvent("pi-event", { detail: event })
      );
    });

    // Wait for toast to appear
    const toast = page.locator('[data-testid="retry-toast"]').first();
    await expect(toast).toBeVisible({ timeout: 500 });

    // Check content
    await expect(toast).toContainText("Retrying");
    await expect(toast).toContainText("1/3");
  });

  test("toast updates on auto_retry_end with success", async ({ page }) => {
    // Start retry
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("pi-event", {
          detail: {
            type: "auto_retry_start",
            attempt: 2,
            maxAttempts: 3,
            delayMs: 2000,
          },
        })
      );
    });

    await page.waitForTimeout(100);

    // End with success
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("pi-event", {
          detail: {
            type: "auto_retry_end",
            success: true,
            attempt: 2,
          },
        })
      );
    });

    // Toast should show success state
    const toast = page.locator('[data-testid="retry-toast"]').first();
    await expect(toast).toContainText("succeeded");
    await expect(toast).toContainText("2");
  });

  test("toast updates on auto_retry_end with failure", async ({ page }) => {
    // Start retry
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("pi-event", {
          detail: {
            type: "auto_retry_start",
            attempt: 3,
            maxAttempts: 3,
            delayMs: 2000,
          },
        })
      );
    });

    await page.waitForTimeout(100);

    // End with failure
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("pi-event", {
          detail: {
            type: "auto_retry_end",
            success: false,
            attempt: 3,
            finalError: "rate_limit",
          },
        })
      );
    });

    // Toast should show error state
    const toast = page.locator('[data-testid="retry-toast"]').first();
    await expect(toast).toContainText("failed");
    await expect(toast).toContainText("rate_limit");
  });

  test("toast respects prefers-reduced-motion", async ({ page }) => {
    // Enable reduced motion
    await page.emulateMedia({ reducedMotion: "reduce" });

    const startTime = Date.now();

    // Emit event
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("pi-event", {
          detail: {
            type: "auto_retry_start",
            attempt: 1,
            maxAttempts: 3,
            delayMs: 2000,
          },
        })
      );
    });

    // Toast should appear instantly (no animation delay)
    const toast = page.locator('[data-testid="retry-toast"]').first();
    await expect(toast).toBeVisible({ timeout: 300 });

    const elapsed = Date.now() - startTime;
    // Should be much faster than the 250ms animation duration
    expect(elapsed).toBeLessThan(250);
  });

  test("success/error toasts auto-dismiss after 5 seconds", async ({ page }) => {
    // Start and immediately succeed
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("pi-event", {
          detail: {
            type: "auto_retry_start",
            attempt: 1,
            maxAttempts: 3,
            delayMs: 2000,
          },
        })
      );
    });

    await page.waitForTimeout(100);

    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("pi-event", {
          detail: {
            type: "auto_retry_end",
            success: true,
            attempt: 1,
          },
        })
      );
    });

    const toast = page.locator('[data-testid="retry-toast"]').first();
    await expect(toast).toBeVisible();

    // Wait for auto-dismiss (5s + some buffer)
    await page.waitForTimeout(5500);
    await expect(toast).not.toBeVisible();
  });

  test("loading toast does not auto-dismiss", async ({ page }) => {
    // Start retry
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("pi-event", {
          detail: {
            type: "auto_retry_start",
            attempt: 1,
            maxAttempts: 3,
            delayMs: 2000,
          },
        })
      );
    });

    const toast = page.locator('[data-testid="retry-toast"]').first();
    await expect(toast).toBeVisible();

    // Wait 6 seconds (longer than auto-dismiss timeout)
    await page.waitForTimeout(6000);

    // Toast should still be visible
    await expect(toast).toBeVisible();
  });

  test("dismiss button works on success/error toasts", async ({ page }) => {
    // Start and succeed
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("pi-event", {
          detail: { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000 },
        })
      );
    });

    await page.waitForTimeout(100);

    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("pi-event", {
          detail: { type: "auto_retry_end", success: true, attempt: 1 },
        })
      );
    });

    const toast = page.locator('[data-testid="retry-toast"]').first();
    await expect(toast).toBeVisible();

    // Click dismiss button
    const dismissBtn = toast.locator('button[aria-label="Dismiss"]');
    await dismissBtn.click();

    // Toast should disappear
    await expect(toast).not.toBeVisible();
  });
});

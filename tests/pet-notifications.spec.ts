import { test, expect } from "@playwright/test";

test.describe("Pet Notifications", () => {
  test.beforeEach(async ({ page, context }) => {
    // Grant notification permission
    await context.grantPermissions(["notifications"]);
    await page.goto("/");
    // Wait for app to initialize
    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 5000 });
  });

  test("pet notification fires when agent_settled transitions pet to review", async ({
    page,
  }) => {
    // Enable notifications
    await page.evaluate(() => {
      const { useUI } = require("@/lib/store");
      useUI.getState().setNotificationEnabled(true);
    });

    // Mock hidden window
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        writable: true,
        configurable: true,
        value: "hidden",
      });
    });

    // Set up notification spy
    const notificationPromise = page.evaluate(() => {
      return new Promise<{ title: string; body: string }>((resolve) => {
        const OriginalNotification = window.Notification;
        (window as any).Notification = class extends OriginalNotification {
          constructor(title: string, options?: NotificationOptions) {
            super(title, options);
            resolve({ title, body: options?.body || "" });
          }
        };
      });
    });

    // Trigger agent_settled event (pet bridge listens to this)
    await page.evaluate(() => {
      const { getPiClient } = require("@/lib/pi/client");
      const client = getPiClient();
      // Set up a current session first so the bridge tracks it
      client.emit("session", {
        type: "session",
        id: "test-session-1",
        version: 1,
        timestamp: new Date().toISOString(),
        cwd: "/test",
      });
      // Now trigger agent_settled → pet transitions to "review"
      client.emit("agent_settled", { type: "agent_settled" });
    });

    // Wait for notification
    const notification = await notificationPromise;
    expect(notification.title).toContain("finished");
    expect(notification.body).toContain("Task complete");
  });

  test("pet notification fires when extension_ui_request transitions pet to waiting", async ({
    page,
  }) => {
    // Enable notifications
    await page.evaluate(() => {
      const { useUI } = require("@/lib/store");
      useUI.getState().setNotificationEnabled(true);
    });

    // Mock hidden window
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        writable: true,
        configurable: true,
        value: "hidden",
      });
    });

    // Set up notification spy
    const notificationPromise = page.evaluate(() => {
      return new Promise<{ title: string; body: string }>((resolve) => {
        const OriginalNotification = window.Notification;
        (window as any).Notification = class extends OriginalNotification {
          constructor(title: string, options?: NotificationOptions) {
            super(title, options);
            resolve({ title, body: options?.body || "" });
          }
        };
      });
    });

    // Trigger extension_ui_request event (pet bridge listens to this)
    await page.evaluate(() => {
      const { getPiClient } = require("@/lib/pi/client");
      const client = getPiClient();
      client.emit("session", {
        type: "session",
        id: "test-session-2",
        version: 1,
        timestamp: new Date().toISOString(),
        cwd: "/test",
      });
      // extension_ui_request → pet transitions to "waiting"
      client.emit("extension_ui_request", {
        type: "extension_ui_request",
        id: "ui-test-1",
        method: "confirm",
        title: "Approve?",
        message: "Apply changes?",
      });
    });

    const notification = await notificationPromise;
    // Title should contain "input" (from the i18n string)
    expect(notification.title.toLowerCase()).toContain("input");
    expect(notification.body).toContain("Needs approval");
  });

  test("pet notification fires when auto_retry_end fails (failed state)", async ({
    page,
  }) => {
    // Enable notifications
    await page.evaluate(() => {
      const { useUI } = require("@/lib/store");
      useUI.getState().setNotificationEnabled(true);
    });

    // Mock hidden window
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        writable: true,
        configurable: true,
        value: "hidden",
      });
    });

    // Set up notification spy
    const notificationPromise = page.evaluate(() => {
      return new Promise<{ title: string; body: string }>((resolve) => {
        const OriginalNotification = window.Notification;
        (window as any).Notification = class extends OriginalNotification {
          constructor(title: string, options?: NotificationOptions) {
            super(title, options);
            resolve({ title, body: options?.body || "" });
          }
        };
      });
    });

    // Trigger auto_retry_end with failure → pet transitions to "failed"
    await page.evaluate(() => {
      const { getPiClient } = require("@/lib/pi/client");
      const client = getPiClient();
      client.emit("session", {
        type: "session",
        id: "test-session-3",
        version: 1,
        timestamp: new Date().toISOString(),
        cwd: "/test",
      });
      client.emit("auto_retry_end", {
        type: "auto_retry_end",
        success: false,
        attempt: 3,
        finalError: "Rate limit exceeded",
      });
    });

    const notification = await notificationPromise;
    expect(notification.title.toLowerCase()).toContain("fail");
    expect(notification.body).toContain("Rate limit exceeded");
  });

  test("pet notification does NOT fire when window is visible", async ({ page }) => {
    // Enable notifications
    await page.evaluate(() => {
      const { useUI } = require("@/lib/store");
      useUI.getState().setNotificationEnabled(true);
    });

    // Ensure visible
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        writable: true,
        configurable: true,
        value: "visible",
      });
    });

    let notificationCalled = false;
    await page.evaluate(() => {
      const OriginalNotification = window.Notification;
      (window as any).Notification = class extends OriginalNotification {
        constructor(title: string, options?: NotificationOptions) {
          super(title, options);
          (window as any).__petNotificationCalled = true;
        }
      };
    });

    // Trigger agent_settled
    await page.evaluate(() => {
      const { getPiClient } = require("@/lib/pi/client");
      const client = getPiClient();
      client.emit("session", {
        type: "session",
        id: "test-session-4",
        version: 1,
        timestamp: new Date().toISOString(),
        cwd: "/test",
      });
      client.emit("agent_settled", { type: "agent_settled" });
    });

    await page.waitForTimeout(500);
    notificationCalled = await page.evaluate(
      () => (window as any).__petNotificationCalled
    );
    expect(notificationCalled).toBeFalsy();
  });

  test("pet notification does NOT fire when notifications disabled", async ({
    page,
  }) => {
    // Disable notifications
    await page.evaluate(() => {
      const { useUI } = require("@/lib/store");
      useUI.getState().setNotificationEnabled(false);
    });

    // Mock hidden window
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        writable: true,
        configurable: true,
        value: "hidden",
      });
    });

    let notificationCalled = false;
    await page.evaluate(() => {
      const OriginalNotification = window.Notification;
      (window as any).Notification = class extends OriginalNotification {
        constructor(title: string, options?: NotificationOptions) {
          super(title, options);
          (window as any).__petNotificationCalled = true;
        }
      };
    });

    // Trigger agent_settled
    await page.evaluate(() => {
      const { getPiClient } = require("@/lib/pi/client");
      const client = getPiClient();
      client.emit("session", {
        type: "session",
        id: "test-session-5",
        version: 1,
        timestamp: new Date().toISOString(),
        cwd: "/test",
      });
      client.emit("agent_settled", { type: "agent_settled" });
    });

    await page.waitForTimeout(500);
    notificationCalled = await page.evaluate(
      () => (window as any).__petNotificationCalled
    );
    expect(notificationCalled).toBeFalsy();
  });

  test("pet notification does NOT fire for running state", async ({ page }) => {
    // Enable notifications
    await page.evaluate(() => {
      const { useUI } = require("@/lib/store");
      useUI.getState().setNotificationEnabled(true);
    });

    // Mock hidden window
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        writable: true,
        configurable: true,
        value: "hidden",
      });
    });

    let notificationCalled = false;
    await page.evaluate(() => {
      const OriginalNotification = window.Notification;
      (window as any).Notification = class extends OriginalNotification {
        constructor(title: string, options?: NotificationOptions) {
          super(title, options);
          (window as any).__petNotificationCalled = true;
        }
      };
    });

    // Trigger agent_start → pet transitions to "running" (should NOT notify)
    await page.evaluate(() => {
      const { getPiClient } = require("@/lib/pi/client");
      const client = getPiClient();
      client.emit("session", {
        type: "session",
        id: "test-session-6",
        version: 1,
        timestamp: new Date().toISOString(),
        cwd: "/test",
      });
      client.emit("agent_start", { type: "agent_start" });
    });

    await page.waitForTimeout(500);
    notificationCalled = await page.evaluate(
      () => (window as any).__petNotificationCalled
    );
    expect(notificationCalled).toBeFalsy();
  });
});

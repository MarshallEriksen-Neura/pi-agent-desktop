import { test, expect } from "@playwright/test";

test.describe("Desktop Notifications", () => {
  test.beforeEach(async ({ page, context }) => {
    // Grant notification permission
    await context.grantPermissions(["notifications"]);
    await page.goto("/");
    // Wait for app to initialize
    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 5000 });
  });

  test("notification fires when message_end occurs while window is hidden", async ({
    page,
  }) => {
    // Enable notifications in settings
    await page.evaluate(() => {
      const { useUI } = require("@/lib/store");
      useUI.getState().setNotificationEnabled(true);
    });

    // Mock document.visibilityState to "hidden"
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

    // Trigger message_end event with assistant message
    await page.evaluate(() => {
      const { useChat } = require("@/lib/pi/chat");
      const store = useChat.getState();

      // Add an assistant message
      store.load([
        {
          id: "msg-1",
          role: "assistant",
          text: "This is a test message that should trigger a notification when complete.",
          thinking: "",
          tools: [],
          streaming: false,
        },
      ]);

      // Trigger message_end by dispatching the event
      const { getPiClient } = require("@/lib/pi/client");
      const client = getPiClient();
      client.emit("message_end", { type: "message_end" });
    });

    // Wait for notification
    const notification = await notificationPromise;
    expect(notification.title).toBe("Pi finished");
    expect(notification.body).toContain("This is a test message");
    expect(notification.body.length).toBeLessThanOrEqual(61); // 60 chars + ellipsis
  });

  test("notification does NOT fire when window is visible", async ({ page }) => {
    // Enable notifications
    await page.evaluate(() => {
      const { useUI } = require("@/lib/store");
      useUI.getState().setNotificationEnabled(true);
    });

    // Ensure document.visibilityState is "visible"
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        writable: true,
        configurable: true,
        value: "visible",
      });
    });

    // Set up notification spy that will reject if called
    let notificationCalled = false;
    await page.evaluate(() => {
      const OriginalNotification = window.Notification;
      (window as any).Notification = class extends OriginalNotification {
        constructor(title: string, options?: NotificationOptions) {
          super(title, options);
          (window as any).__notificationCalled = true;
        }
      };
    });

    // Trigger message_end event
    await page.evaluate(() => {
      const { useChat } = require("@/lib/pi/chat");
      const store = useChat.getState();

      store.load([
        {
          id: "msg-1",
          role: "assistant",
          text: "This message should not trigger a notification.",
          thinking: "",
          tools: [],
          streaming: false,
        },
      ]);

      const { getPiClient } = require("@/lib/pi/client");
      const client = getPiClient();
      client.emit("message_end", { type: "message_end" });
    });

    // Wait a bit to ensure notification would have fired if it was going to
    await page.waitForTimeout(500);

    notificationCalled = await page.evaluate(() => (window as any).__notificationCalled);
    expect(notificationCalled).toBeFalsy();
  });

  test("notification does NOT fire when disabled in settings", async ({ page }) => {
    // Disable notifications
    await page.evaluate(() => {
      const { useUI } = require("@/lib/store");
      useUI.getState().setNotificationEnabled(false);
    });

    // Mock hidden state
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        writable: true,
        configurable: true,
        value: "hidden",
      });
    });

    // Set up notification spy
    let notificationCalled = false;
    await page.evaluate(() => {
      const OriginalNotification = window.Notification;
      (window as any).Notification = class extends OriginalNotification {
        constructor(title: string, options?: NotificationOptions) {
          super(title, options);
          (window as any).__notificationCalled = true;
        }
      };
    });

    // Trigger message_end event
    await page.evaluate(() => {
      const { useChat } = require("@/lib/pi/chat");
      const store = useChat.getState();

      store.load([
        {
          id: "msg-1",
          role: "assistant",
          text: "Disabled notification test.",
          thinking: "",
          tools: [],
          streaming: false,
        },
      ]);

      const { getPiClient } = require("@/lib/pi/client");
      const client = getPiClient();
      client.emit("message_end", { type: "message_end" });
    });

    await page.waitForTimeout(500);

    notificationCalled = await page.evaluate(() => (window as any).__notificationCalled);
    expect(notificationCalled).toBeFalsy();
  });

  test("notification click handler focuses window", async ({ page }) => {
    await page.evaluate(() => {
      const { useUI } = require("@/lib/store");
      useUI.getState().setNotificationEnabled(true);
    });

    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        writable: true,
        configurable: true,
        value: "hidden",
      });
    });

    // Track window.focus() calls
    await page.evaluate(() => {
      (window as any).__focusCalled = false;
      const originalFocus = window.focus;
      window.focus = function () {
        (window as any).__focusCalled = true;
        return originalFocus.apply(this);
      };
    });

    // Capture notification instance and trigger click
    const clickHandlerFired = await page.evaluate(() => {
      return new Promise<boolean>((resolve) => {
        const OriginalNotification = window.Notification;
        (window as any).Notification = class extends OriginalNotification {
          constructor(title: string, options?: NotificationOptions) {
            super(title, options);
            // Simulate click
            setTimeout(() => {
              if (this.onclick) {
                this.onclick(new Event("click"));
              }
              setTimeout(() => resolve((window as any).__focusCalled), 100);
            }, 100);
          }
        };

        // Trigger message_end
        const { useChat } = require("@/lib/pi/chat");
        const store = useChat.getState();
        store.load([
          {
            id: "msg-1",
            role: "assistant",
            text: "Click test message.",
            thinking: "",
            tools: [],
            streaming: false,
          },
        ]);

        const { getPiClient } = require("@/lib/pi/client");
        const client = getPiClient();
        client.emit("message_end", { type: "message_end" });
      });
    });

    expect(clickHandlerFired).toBe(true);
  });

  test("notification truncates long messages to 60 characters", async ({ page }) => {
    await page.evaluate(() => {
      const { useUI } = require("@/lib/store");
      useUI.getState().setNotificationEnabled(true);
    });

    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        writable: true,
        configurable: true,
        value: "hidden",
      });
    });

    const notificationPromise = page.evaluate(() => {
      return new Promise<{ body: string }>((resolve) => {
        const OriginalNotification = window.Notification;
        (window as any).Notification = class extends OriginalNotification {
          constructor(title: string, options?: NotificationOptions) {
            super(title, options);
            resolve({ body: options?.body || "" });
          }
        };
      });
    });

    const longMessage =
      "This is a very long message that should be truncated to exactly 60 characters plus an ellipsis to indicate there is more content available in the full message.";

    await page.evaluate((msg) => {
      const { useChat } = require("@/lib/pi/chat");
      const store = useChat.getState();
      store.load([
        {
          id: "msg-1",
          role: "assistant",
          text: msg,
          thinking: "",
          tools: [],
          streaming: false,
        },
      ]);

      const { getPiClient } = require("@/lib/pi/client");
      const client = getPiClient();
      client.emit("message_end", { type: "message_end" });
    }, longMessage);

    const notification = await notificationPromise;
    expect(notification.body).toBe(longMessage.slice(0, 60) + "…");
    expect(notification.body.length).toBe(61);
  });

  test("settings toggle enables and disables notifications", async ({ page }) => {
    // Go to settings page
    await page.goto("/settings");
    await page.waitForSelector("text=Desktop Notifications", { timeout: 5000 });

    // Find the notification toggle
    const notificationRow = page.locator('text="Desktop Notifications"').locator("..");
    const toggle = notificationRow.locator('[role="switch"]');

    // Check initial state (should be enabled by default)
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    // Click to disable
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    // Verify state in store
    const isEnabled = await page.evaluate(() => {
      const { useUI } = require("@/lib/store");
      return useUI.getState().notificationSettings.enabled;
    });
    expect(isEnabled).toBe(false);

    // Click to enable again
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
  });
});

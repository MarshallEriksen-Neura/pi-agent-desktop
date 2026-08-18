import { test, expect } from '@playwright/test';

test.describe('Message Operations', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the app
    await page.goto('/');

    // Wait for the app to load
    await page.waitForSelector('[data-testid="agent-panel"], aside.material', { timeout: 5000 });
  });

  test('should show menu on hover over assistant message', async ({ page }) => {
    // Mock a conversation with an assistant message
    await page.evaluate(() => {
      const { useChat } = require('@/lib/pi/chat');
      useChat.getState().load([
        {
          id: 'msg-1',
          role: 'user',
          text: 'Hello',
          thinking: '',
          tools: [],
          streaming: false,
        },
        {
          id: 'msg-2',
          role: 'assistant',
          text: 'Hello! How can I help you?',
          thinking: '',
          tools: [],
          streaming: false,
        },
      ]);
    });

    // Wait for message to appear
    await page.waitForSelector('text=Hello! How can I help you?');

    // Find the assistant message container
    const messageContainer = page.locator('text=Hello! How can I help you?').locator('..');

    // Hover over the message
    await messageContainer.hover();

    // The menu button should become visible (opacity transition)
    const menuButton = messageContainer.locator('button[aria-label="Message options"]');
    await expect(menuButton).toBeVisible({ timeout: 500 });
  });

  test('should copy message markdown to clipboard', async ({ page, context }) => {
    // Grant clipboard permissions
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    const messageText = 'This is a test message to copy';

    // Mock a conversation
    await page.evaluate((text) => {
      const { useChat } = require('@/lib/pi/chat');
      useChat.getState().load([
        {
          id: 'msg-1',
          role: 'assistant',
          text,
          thinking: '',
          tools: [],
          streaming: false,
        },
      ]);
    }, messageText);

    await page.waitForSelector(`text=${messageText}`);

    // Hover and click menu
    const messageContainer = page.locator(`text=${messageText}`).locator('..');
    await messageContainer.hover();
    const menuButton = messageContainer.locator('button[aria-label="Message options"]');
    await menuButton.click();

    // Click copy option (scoped to the menu — the hover copy pill on the
    // message also matches the "Copy" text)
    await page.locator('[role="menu"] button:has-text("Copy")').click();

    // Wait a bit for clipboard operation
    await page.waitForTimeout(100);

    // Verify clipboard content
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe(messageText);
  });

  test('should send fork command when clicking fork', async ({ page }) => {
    const messageText = 'Message to fork';
    const entryId = 'msg-fork-1';

    // Mock a conversation
    await page.evaluate(({ text, id }) => {
      const { useChat } = require('@/lib/pi/chat');
      useChat.getState().load([
        {
          id,
          role: 'assistant',
          text,
          thinking: '',
          tools: [],
          streaming: false,
        },
      ]);
    }, { text: messageText, id: entryId });

    await page.waitForSelector(`text=${messageText}`);

    // Track sent commands
    const sentCommands: any[] = [];
    await page.evaluate(() => {
      const { getPiClient } = require('@/lib/pi/client');
      const originalSend = getPiClient().send;
      getPiClient().send = (cmd: any) => {
        (window as any).__sentCommands = (window as any).__sentCommands || [];
        (window as any).__sentCommands.push(cmd);
        return originalSend.call(getPiClient(), cmd);
      };
    });

    // Hover and click menu
    const messageContainer = page.locator(`text=${messageText}`).locator('..');
    await messageContainer.hover();
    const menuButton = messageContainer.locator('button[aria-label="Message options"]');
    await menuButton.click();

    // Click fork option
    await page.locator('text=Fork').click();

    // Verify fork command was sent
    const commands = await page.evaluate(() => (window as any).__sentCommands || []);
    expect(commands).toContainEqual({ type: 'fork', entryId });
  });

  test('should copy message using keyboard shortcut Cmd+Shift+C', async ({ page, context }) => {
    // Grant clipboard permissions
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    const messageText = 'Message to copy with keyboard';

    // Mock a conversation
    await page.evaluate((text) => {
      const { useChat } = require('@/lib/pi/chat');
      useChat.getState().load([
        {
          id: 'msg-kb-1',
          role: 'assistant',
          text,
          thinking: '',
          tools: [],
          streaming: false,
        },
      ]);
    }, messageText);

    await page.waitForSelector(`text=${messageText}`);

    // Focus the agent panel container
    await page.locator('aside.material').click();

    // Press Cmd+Shift+C (or Ctrl+Shift+C on Windows/Linux)
    const isMac = process.platform === 'darwin';
    if (isMac) {
      await page.keyboard.press('Meta+Shift+KeyC');
    } else {
      await page.keyboard.press('Control+Shift+KeyC');
    }

    // Wait for clipboard operation
    await page.waitForTimeout(100);

    // Verify clipboard content
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe(messageText);
  });

  test('should not show menu for streaming messages', async ({ page }) => {
    const messageText = 'Streaming message';

    // Mock a streaming message
    await page.evaluate((text) => {
      const { useChat } = require('@/lib/pi/chat');
      useChat.getState().load([
        {
          id: 'msg-stream-1',
          role: 'assistant',
          text,
          thinking: '',
          tools: [],
          streaming: true, // Still streaming
        },
      ]);
    }, messageText);

    await page.waitForSelector(`text=${messageText}`);

    // Try to find menu button (should not exist for streaming messages)
    const messageContainer = page.locator(`text=${messageText}`).locator('..');
    await messageContainer.hover();

    const menuButton = messageContainer.locator('button[aria-label="Message options"]');
    await expect(menuButton).not.toBeVisible();
  });

  test('should not show menu for user messages', async ({ page }) => {
    const messageText = 'User message';

    // Mock a user message
    await page.evaluate((text) => {
      const { useChat } = require('@/lib/pi/chat');
      useChat.getState().load([
        {
          id: 'msg-user-1',
          role: 'user',
          text,
          thinking: '',
          tools: [],
          streaming: false,
        },
      ]);
    }, messageText);

    await page.waitForSelector(`text=${messageText}`);

    // User messages don't have menu buttons
    const messageContainer = page.locator(`text=${messageText}`).locator('..');
    const menuButton = messageContainer.locator('button[aria-label="Message options"]');
    await expect(menuButton).not.toBeVisible();
  });
});

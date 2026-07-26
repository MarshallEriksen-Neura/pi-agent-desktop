import { test, expect } from '@playwright/test';

test.describe('Streaming Queue', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the app
    await page.goto('/');

    // Wait for the app to load
    await page.waitForSelector('[data-testid="agent-panel"], aside.material', { timeout: 5000 });
  });

  test('should show queue badge when prompt queued during streaming', async ({ page }) => {
    // Set streaming state
    await page.evaluate(() => {
      const { useChat } = require('@/lib/pi/chat');
      useChat.setState({ streaming: true });
    });

    // Type a prompt in the composer
    const input = page.locator('input[placeholder*="Pi"]');
    await input.fill('test prompt');
    await input.press('Enter');

    // Queue badge should appear
    await expect(page.locator('text=/queued/')).toBeVisible({ timeout: 1000 });

    // Verify the count shows 1
    await expect(page.locator('text=/1.*queued|queued.*1/')).toBeVisible();
  });

  test('should auto-send queued prompt when streaming stops', async ({ page }) => {
    // Set streaming state and queue a prompt
    await page.evaluate(() => {
      const { useChat } = require('@/lib/pi/chat');
      useChat.setState({ streaming: true });
      useChat.getState().queuePrompt('queued test message');
    });

    // Verify badge shows
    await expect(page.locator('text=/1.*queued|queued.*1/')).toBeVisible();

    // Track sent messages
    await page.evaluate(() => {
      const { getPiClient } = require('@/lib/pi/client');
      const originalSend = getPiClient().send;
      getPiClient().send = (cmd: any) => {
        (window as any).__sentCommands = (window as any).__sentCommands || [];
        (window as any).__sentCommands.push(cmd);
        return originalSend.call(getPiClient(), cmd);
      };
    });

    // Transition to idle
    await page.evaluate(() => {
      const { useChat } = require('@/lib/pi/chat');
      useChat.setState({ streaming: false });
    });

    // Wait a bit for auto-send effect
    await page.waitForTimeout(200);

    // Verify the prompt was sent
    const commands = await page.evaluate(() => (window as any).__sentCommands || []);
    expect(commands.some((cmd: any) =>
      cmd.type === 'prompt' && cmd.message === 'queued test message'
    )).toBe(true);

    // Badge should disappear
    await expect(page.locator('text=/queued/')).not.toBeVisible({ timeout: 500 });
  });

  test('should clear queue when cancel button clicked', async ({ page }) => {
    // Set streaming and queue prompts
    await page.evaluate(() => {
      const { useChat } = require('@/lib/pi/chat');
      useChat.setState({ streaming: true });
      useChat.getState().queuePrompt('first');
      useChat.getState().queuePrompt('second');
    });

    // Wait for badge to appear
    await expect(page.locator('text=/2.*queued|queued.*2/')).toBeVisible();

    // Click cancel button
    await page.locator('button:has-text("Cancel")').click();

    // Badge should disappear
    await expect(page.locator('text=/queued/')).not.toBeVisible({ timeout: 500 });

    // Verify queue is empty
    const queueLength = await page.evaluate(() => {
      const { useChat } = require('@/lib/pi/chat');
      return useChat.getState().queuedPrompts.length;
    });
    expect(queueLength).toBe(0);
  });

  test('should not queue when not streaming', async ({ page }) => {
    // Ensure not streaming
    await page.evaluate(() => {
      const { useChat } = require('@/lib/pi/chat');
      useChat.setState({ streaming: false });
    });

    // Track sent messages
    await page.evaluate(() => {
      const { getPiClient } = require('@/lib/pi/client');
      const originalSend = getPiClient().send;
      getPiClient().send = (cmd: any) => {
        (window as any).__sentCommands = (window as any).__sentCommands || [];
        (window as any).__sentCommands.push(cmd);
        return originalSend.call(getPiClient(), cmd);
      };
    });

    // Type and send a prompt
    const input = page.locator('input[placeholder*="Pi"]');
    await input.fill('direct send');
    await input.press('Enter');

    // Wait a bit
    await page.waitForTimeout(100);

    // Should send directly, not queue
    const commands = await page.evaluate(() => (window as any).__sentCommands || []);
    expect(commands.some((cmd: any) =>
      cmd.type === 'prompt' && cmd.message === 'direct send'
    )).toBe(true);

    // Badge should not appear
    await expect(page.locator('text=/queued/')).not.toBeVisible();
  });
});

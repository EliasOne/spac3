// Smoke tests: the core flows still work. Run before every merge.
// Tests marked test.fail() document a KNOWN bug from the Supabase audit:
// they pass while the bug exists, and Playwright flags them the moment
// the bug is fixed, so we remember to turn them into normal tests.

import { test, expect } from '@playwright/test';
import {
  USERS, ROOM, roomUrl, signedInContext, trackPageErrors, sendChat, chatLine,
} from './helpers.js';

test.describe('pages load', () => {
  for (const path of ['/index.html', '/sketch.html']) {
    test(`${path} loads without script errors (signed out)`, async ({ page }) => {
      const errors = trackPageErrors(page);
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      expect(errors).toEqual([]);
    });
  }
});

test.describe('room', () => {
  test('signed-in user opens the room without script errors', async ({ browser }) => {
    const context = await signedInContext(browser, USERS.alice);
    const page = await context.newPage();
    const errors = trackPageErrors(page);
    await page.goto(roomUrl());
    await expect(page.locator('#spac3Name')).toHaveText(ROOM.name);
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
    await context.close();
  });

  test('chat history loads', async ({ browser }) => {
    const context = await signedInContext(browser, USERS.alice);
    const page = await context.newPage();
    await page.goto(roomUrl());
    await expect(page.locator('#chatLog .chat-line').first()).toBeAttached();
    await expect(page.locator('#chatLog .chat-line')).toHaveCount(200);
    await context.close();
  });

  test('a message from one user appears live for another', async ({ browser }) => {
    const aliceCtx = await signedInContext(browser, USERS.alice);
    const bobCtx = await signedInContext(browser, USERS.bob);
    const alice = await aliceCtx.newPage();
    const bob = await bobCtx.newPage();
    await alice.goto(roomUrl());
    await bob.goto(roomUrl());
    await expect(alice.locator('#spac3Name')).toHaveText(ROOM.name);
    await expect(bob.locator('#spac3Name')).toHaveText(ROOM.name);
    // Give both realtime connections a moment to join the room channel.
    await alice.waitForTimeout(1500);

    const text = `hello from bob ${Date.now()}`;
    await sendChat(bob, text);

    await expect(chatLine(bob, text)).toBeAttached();
    await expect(chatLine(alice, text)).toBeAttached();
    await aliceCtx.close();
    await bobCtx.close();
  });
});

test.describe('known bugs (Supabase audit)', () => {
  test('B1: the room shows the NEWEST 200 messages', async ({ browser }) => {
    test.fail(true, 'Audit B1: chat loads the oldest 200 messages. Remove test.fail() when fixed.');
    const context = await signedInContext(browser, USERS.alice);
    const page = await context.newPage();
    await page.goto(roomUrl());
    await expect(page.locator('#chatLog .chat-line').first()).toBeAttached();
    await expect(chatLine(page, 'Seed message 250')).toBeAttached({ timeout: 5_000 });
    await context.close();
  });

  test('B2: opening a room makes no requests to the missing sticker_tags table', async ({ browser }) => {
    test.fail(true, 'Audit B2: room still queries sticker_tags. Remove test.fail() when Sticker Tags moves to Presence.');
    const context = await signedInContext(browser, USERS.alice);
    const page = await context.newPage();
    const stickerTagRequests = [];
    page.on('request', (req) => { if (req.url().includes('sticker_tags')) stickerTagRequests.push(req.url()); });
    await page.goto(roomUrl());
    await expect(page.locator('#spac3Name')).toHaveText(ROOM.name);
    await page.waitForLoadState('networkidle');
    expect(stickerTagRequests).toEqual([]);
    await context.close();
  });
});

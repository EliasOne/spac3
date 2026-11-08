// Smoke tests: the core flows still work. Run before every merge.
// Tests marked test.fail() document a KNOWN bug from the Supabase audit:
// they pass while the bug exists, and Playwright flags them the moment
// the bug is fixed, so we remember to turn them into normal tests.

import { test, expect } from '@playwright/test';
import {
  USERS, ROOM, roomUrl, signedInContext, trackPageErrors, sendChat, chatHasMessage,
  watchConsole, describePage, watchRealtime, waitForRealtime,
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
    const aliceErrors = watchConsole(alice);
    const bobErrors = watchConsole(bob);
    const aliceRealtime = watchRealtime(alice);
    const bobRealtime = watchRealtime(bob);
    await alice.goto(roomUrl());
    await bob.goto(roomUrl());
    await expect(alice.locator('#spac3Name')).toHaveText(ROOM.name);
    await expect(bob.locator('#spac3Name')).toHaveText(ROOM.name);

    // Realtime switches on database-change listening a moment after joining
    // the room. Wait for both, like real users who don't type within 1 s.
    await Promise.all([waitForRealtime(aliceRealtime), waitForRealtime(bobRealtime)]);
    expect(bobRealtime.error, 'Supabase refused the room\'s live-update listeners').toBeNull();
    expect(aliceRealtime.error, 'Supabase refused the room\'s live-update listeners').toBeNull();

    // Step 1: the message must reach the database. (Before sending, the app
    // checks the live room connection and silently skips the send if it's down.)
    const text = `hello from bob ${Date.now()}`;
    const posted = bob.waitForResponse(
      (r) => r.url().includes('/rest/v1/messages') && r.request().method() === 'POST',
      { timeout: 10_000 },
    ).catch(() => null);
    await sendChat(bob, text);
    const res = await posted;
    if (!res) throw new Error(`Bob's message was never sent to the database.\n${await describePage(bob, bobErrors)}`);
    expect(res.status(), `Insert failed: ${await res.text()}`).toBe(201);

    // Step 2: realtime delivers it to both screens (there's no optimistic
    // render, so even the sender only sees it via realtime).
    await expect.poll(() => chatHasMessage(bob, text), {
      message: `Bob's own message never arrived over realtime.\n${await describePage(bob, bobErrors, bobRealtime)}`,
    }).toBe(true);
    await expect.poll(() => chatHasMessage(alice, text), {
      message: `Alice never received Bob's message.\n${await describePage(alice, aliceErrors, aliceRealtime)}`,
    }).toBe(true);
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
    await page.waitForLoadState('networkidle');
    expect(await chatHasMessage(page, 'Seed message 250')).toBe(true);
    await context.close();
  });

  test('B2 (fixed): opening a room makes no requests to the missing sticker_tags table', async ({ browser }) => {
    const context = await signedInContext(browser, USERS.alice);
    const page = await context.newPage();
    const stickerTagRequests = [];
    page.on('request', (req) => { if (req.url().includes('sticker_tags')) stickerTagRequests.push(req.url()); });
    const realtime = watchRealtime(page);
    await page.goto(roomUrl());
    await expect(page.locator('#spac3Name')).toHaveText(ROOM.name);
    await waitForRealtime(realtime);
    expect(stickerTagRequests).toEqual([]);
    expect(realtime.error, 'Room live updates must not be refused').toBeNull();
    expect(realtime.ready).toBe(true);
    await context.close();
  });
});

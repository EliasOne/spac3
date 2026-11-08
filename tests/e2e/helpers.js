// Shared test data and helpers. IDs and accounts match supabase/seed.sql.

export const SUPABASE_URL = process.env.SPAC3_LOCAL_SUPABASE_URL || 'http://127.0.0.1:54321';
export const SUPABASE_KEY = process.env.SPAC3_LOCAL_SUPABASE_KEY || 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';

export const PASSWORD = 'spac3-test-pass';
export const USERS = {
  alice: { id: '11111111-1111-4111-8111-111111111111', email: 'alice@test.local', username: 'alice' },
  bob: { id: '22222222-2222-4222-8222-222222222222', email: 'bob@test.local', username: 'bob' },
};
export const ROOM = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Test Room' };
export const roomUrl = (id = ROOM.id) => `/room.html?id=${id}`;

// supabase-js keeps the session in localStorage under sb-<first host label>-auth-token.
const STORAGE_KEY = `sb-${new URL(SUPABASE_URL).hostname.split('.')[0]}-auth-token`;

const sessions = new Map();

// Signs in through the local auth API (fast, no UI) and returns the session.
export async function getSession(user) {
  if (sessions.has(user.email)) return sessions.get(user.email);
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Sign-in failed for ${user.email}: ${res.status} ${await res.text()}`);
  const session = await res.json();
  sessions.set(user.email, session);
  return session;
}

// Makes a fresh browser context that is already signed in as `user`.
export async function signedInContext(browser, user) {
  const session = await getSession(user);
  const context = await browser.newContext();
  await context.addInitScript(([key, value]) => {
    window.localStorage.setItem(key, value);
  }, [STORAGE_KEY, JSON.stringify(session)]);
  return context;
}

// Collects uncaught page errors so a test can assert there were none.
export function trackPageErrors(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

// Sends a chat message through the real chat form.
// The chat window may be closed; the form still submits the same way.
export async function sendChat(page, text) {
  await page.evaluate((body) => {
    const input = document.getElementById('chatInput');
    const form = document.getElementById('chatForm');
    input.value = body;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    form.requestSubmit();
  }, text);
}

export const chatLine = (page, text) =>
  page.locator('#chatLog .chat-line', { hasText: text });

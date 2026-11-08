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
  await context.addInitScript(recordToasts);
  return context;
}

// Runs inside the page: keeps every toast message the app shows in
// window.__toasts, so a failing test can report them after they fade.
function recordToasts() {
  window.__toasts = [];
  new MutationObserver((records) => {
    for (const r of records) for (const node of r.addedNodes) {
      if (node.nodeType === 1 && node.classList.contains('toast')) window.__toasts.push(node.textContent);
    }
  }).observe(document, { childList: true, subtree: true });
}

// Starts collecting console errors for a page; call before page.goto().
export function watchConsole(page) {
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  return errors;
}

// Watches the page's realtime websocket for the ROOM channel. Supabase sends a
// "system" message once database-change listening is ready ("Subscribed to
// PostgreSQL"), or an error if it refused (e.g. a listener on a missing table
// makes it refuse ALL of that channel's listeners). Call before page.goto().
export function watchRealtime(page, topic = 'realtime:room:') {
  const state = { ready: false, error: null, system: [] };
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/realtime/')) return;
    ws.on('framereceived', ({ payload }) => {
      const text = typeof payload === 'string' ? payload : payload.toString();
      if (!text.includes('system') || !text.includes(topic)) return;
      state.system.push(text.slice(0, 400));
      if (text.includes('Subscribed to PostgreSQL')) state.ready = true;
      else if (text.includes('"error"')) state.error = text.slice(0, 400);
    });
  });
  return state;
}

// Waits until realtime database changes are live for this page. Doesn't fail
// on timeout: the assertion that follows reports what realtime said instead.
export async function waitForRealtime(state, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (!state.ready && !state.error && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  return state.ready;
}

// A readable summary of what the page told the user, for failure messages.
export async function describePage(page, consoleErrors = [], realtime = null) {
  const toasts = await page.evaluate(() => window.__toasts || []).catch(() => []);
  let out = `toasts: ${JSON.stringify(toasts)}\nconsole errors: ${JSON.stringify(consoleErrors.slice(-8))}`;
  if (realtime) out += `\nroom realtime ready: ${realtime.ready}\nroom realtime error: ${realtime.error}\nroom realtime system messages: ${JSON.stringify(realtime.system.slice(-5))}`;
  return out;
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

// True when the chat log contains a message whose text is EXACTLY `text`.
// (Each line's time sits right after the text with no space, so a plain
// substring match can confuse "message 25" + "08:04" with "message 250".)
export function chatHasMessage(page, text) {
  return page.evaluate((wanted) => [...document.querySelectorAll('#chatLog .chat-line .t')].some((t) => {
    const copy = t.cloneNode(true);
    copy.querySelectorAll('.when, .chat-lock').forEach((el) => el.remove());
    return copy.textContent.trim() === wanted;
  }), text);
}

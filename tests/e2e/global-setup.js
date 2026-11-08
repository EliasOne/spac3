// Fails fast with a clear message if the local Supabase isn't running or
// hasn't been seeded, instead of every test timing out.

import { SUPABASE_URL, USERS, getSession } from './helpers.js';

export default async function globalSetup() {
  try {
    await fetch(`${SUPABASE_URL}/auth/v1/health`);
  } catch {
    throw new Error(
      `Local Supabase is not reachable at ${SUPABASE_URL}.\n` +
      'Start Docker, then run: npx supabase start',
    );
  }
  try {
    await getSession(USERS.alice);
  } catch (err) {
    throw new Error(
      `${err.message}\nThe test accounts are missing. Run: npx supabase db reset`,
    );
  }
}

import { createClient } from './supabase-js.bundle.js'; // bundled supabase-js 2.117.3 (was an unpinned esm.sh import)
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const isConfigured = Boolean(
  SUPABASE_URL && !SUPABASE_URL.includes('YOUR_') &&
  SUPABASE_ANON_KEY && !SUPABASE_ANON_KEY.includes('YOUR_')
);

export const supabase = isConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

// Shows a small banner across the top of the page when the app hasn't
// been connected to a Supabase project yet, so it's obvious why auth /
// data actions aren't working instead of failing silently.
export function warnIfUnconfigured() {
  if (isConfigured) return;
  const bar = document.createElement('div');
  bar.textContent =
    'SPAC3 isn’t connected to a Supabase project yet. Edit js/config.js with your project URL + anon key (see README.md), then reload.';
  bar.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; z-index: 999;
    background: #fbbf24; color: #1a1300; font-size: 13px;
    padding: 8px 14px; text-align: center; font-family: sans-serif;
  `;
  document.body.appendChild(bar);
}

// Entry point for the Supabase client library.
// The build turns this into dist/supabase-js.bundle.js, which supabaseClient.js
// imports. The version is pinned in package.json; to upgrade, change it there
// and run `npm install`. Do not hand-edit the built file.
export { createClient } from '@supabase/supabase-js';

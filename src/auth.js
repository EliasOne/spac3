import { supabase } from './supabaseClient.js';

// A much wider, Roblox-style roster of character types to pick from,
// grouped into categories so a 60+ option picker still feels browsable
// instead of one giant wall of emoji. AVATAR_EMOJIS (the flat list) is
// kept alongside the categorized version since some code just needs
// "any valid avatar emoji" (e.g. picking the default).
const AVATAR_EMOJI_CATEGORIES = [
  {
    label: 'Classic',
    emojis: ['🙂', '😎', '🥸', '🤡', '⭐', '🌙', '🚀'],
  },
  {
    label: 'Fantasy',
    emojis: ['🧙‍♂️', '🧙‍♀️', '🧝‍♂️', '🧝‍♀️', '🧚‍♀️', '🧞‍♂️', '🧜‍♀️', '🧜‍♂️', '🦄', '🐉'],
  },
  {
    label: 'Spooky',
    emojis: ['💀', '👻', '🧛‍♂️', '🧛‍♀️', '🧟‍♂️', '🧟‍♀️', '👺', '👹', '🎃'],
  },
  {
    label: 'Sci-Fi',
    emojis: ['🤖', '👽', '👾', '🧑‍🚀', '🛸'],
  },
  {
    label: 'Roleplay',
    emojis: ['🤠', '🥷', '🦸‍♂️', '🦸‍♀️', '🦹‍♂️', '🦹‍♀️', '🧑‍🎤', '🧑‍🍳', '🧑‍⚕️', '🧑‍🚒', '🧑‍🎨', '🥋'],
  },
  {
    label: 'Creatures',
    emojis: ['🐶', '🐱', '🦊', '🐺', '🐼', '🐨', '🐯', '🦁', '🐸', '🐵', '🐷', '🐻', '🐧', '🦉', '🦅', '🐙', '🦖'],
  },
];
const AVATAR_EMOJIS = AVATAR_EMOJI_CATEGORIES.flatMap((c) => c.emojis);

const AVATAR_COLORS = [
  '#7dd3fc', '#c084fc', '#4ade80', '#fb7185', '#facc15', '#f97316',
  '#38bdf8', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#94a3b8',
];

export { AVATAR_EMOJIS, AVATAR_EMOJI_CATEGORIES, AVATAR_COLORS };

export async function getSession() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export function onAuthStateChange(cb) {
  if (!supabase) return { data: { subscription: { unsubscribe() {} } } };
  return supabase.auth.onAuthStateChange((_event, session) => cb(session));
}

export async function fetchProfile(userId) {
  if (!supabase || !userId) return null;
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    console.error('fetchProfile error', error);
    return null;
  }
  return data;
}

// After sign-up, the profiles row is created a moment later by a DB
// trigger. Poll briefly for it so we can immediately apply the
// avatar choices the user made on the sign-up form.
async function waitForProfile(userId, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    const profile = await fetchProfile(userId);
    if (profile) return profile;
    await new Promise((r) => setTimeout(r, 350));
  }
  return null;
}

export async function signUp({ email, password, username, avatarColor, avatarEmoji }) {
  if (!supabase) throw new Error('App is not connected to Supabase yet.');
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { username } },
  });
  if (error) throw error;

  const user = data.user;
  if (user) {
    const profile = await waitForProfile(user.id);
    if (profile) {
      await supabase
        .from('profiles')
        .update({ avatar_color: avatarColor, avatar_emoji: avatarEmoji })
        .eq('id', user.id);
    }
  }
  return data;
}

export async function signIn({ email, password }) {
  if (!supabase) throw new Error('App is not connected to Supabase yet.');
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

// Lets an already-signed-up user change their username, avatar, and/or
// photo later, not just pick them once at signup. RLS already allows
// this (see the "Users can update their own profile" policy in
// schema.sql), so no schema change is needed for this to work.
//
// `username` and `avatarUrl` are optional -- pass them only when
// they're actually changing. `avatarUrl` specifically distinguishes
// "leave it alone" (undefined, the default) from "clear it back to the
// emoji+color badge" (null) -- both are meaningfully different from
// "set it to this photo" (a string), so all three states need to
// survive being passed through here. Usernames are enforced unique by
// the database (`username text not null unique`), so if someone else
// already has the requested name, Postgres rejects the update with a
// unique-violation (error code 23505) -- translated here into a
// friendly message instead of letting a raw database error reach the UI.
export async function updateProfile(userId, { username, avatarEmoji, avatarColor, avatarUrl } = {}) {
  if (!supabase) throw new Error('App is not connected to Supabase yet.');
  const patch = { avatar_emoji: avatarEmoji, avatar_color: avatarColor };
  if (username !== undefined) patch.username = username;
  if (avatarUrl !== undefined) patch.avatar_url = avatarUrl;
  const { error } = await supabase
    .from('profiles')
    .update(patch)
    .eq('id', userId);
  if (error) {
    if (error.code === '23505') {
      throw new Error('That username is already taken. Try another.');
    }
    throw error;
  }
}

// Uploads a user's chosen photo to Supabase Storage (the public
// "avatars" bucket created in schema.sql) and returns its public URL.
// `blob` is expected to already be a reasonably small, browser-decoded
// image (see the client-side resize step in authUI.js) -- this
// function just handles getting bytes into Storage and reading back a
// URL for them, not any image processing.
//
// Each upload goes to its own timestamped path under the user's own
// "<user id>/" folder (never a fixed, always-overwritten path) so that
// picking a new photo in the editor and then hitting Cancel can't
// silently clobber whatever photo is actually still saved on the
// profile -- nothing about an existing, already-saved photo changes
// until updateProfile() above actually persists the new avatar_url.
export async function uploadAvatarImage(userId, blob) {
  if (!supabase) throw new Error('App is not connected to Supabase yet.');
  const path = `${userId}/${Date.now()}.jpg`;
  const { error } = await supabase.storage.from('avatars').upload(path, blob, {
    upsert: true,
    cacheControl: '3600',
    contentType: blob.type || 'image/jpeg',
  });
  if (error) throw error;
  const { data } = supabase.storage.from('avatars').getPublicUrl(path);
  return data.publicUrl;
}

// ---- Address privacy (see "HIDDEN ADDRESSES" in supabase/schema.sql) ----
// The saved address of ONE of the signed-in person's own SPAC3s (only the owner can read it), or ''.
export async function fetchRoomPrivateAddress(spac3Id) {
  if (!supabase || !spac3Id) return '';
  const { data } = await supabase.from('spac3_private_addresses').select('address').eq('spac3_id', spac3Id).maybeSingle();
  return data?.address || '';
}
// Show or hide the address of one SPAC3 (its Room settings). Returns the address now shown ('' when hidden).
export async function setRoomAddressShown(spac3Id, show) {
  if (!supabase) throw new Error('App is not connected to Supabase yet.');
  const { data, error } = await supabase.rpc(show ? 'spac3_share_room_address' : 'spac3_hide_room_address', { p_spac3_id: spac3Id });
  if (error) throw new Error(error.message);
  return show ? (data || '') : '';
}

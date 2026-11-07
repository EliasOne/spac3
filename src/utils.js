export function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Chat text -> safe HTML where web addresses (https://..., http://..., www...., spac3.app/...) are clickable links that open in a new tab.
// Everything else is escaped exactly as before; only http/https links are ever made (never javascript: and the like).
export function linkifyHtml(text = '') {
  const src = String(text);
  const re = /(?<![\w@/.-])((?:https?:\/\/|www\.|spac3\.app\/)[^\s<>"'`]+)/gi;
  let out = ''; let last = 0; let m;
  while ((m = re.exec(src))) {
    let url = m[1]; let tail = '';
    // trailing punctuation belongs to the sentence, not the address (and an unmatched closing bracket too)
    for (;;) {
      const c = url[url.length - 1];
      if (/[.,!?;:'")\]}]/.test(c) && !(c === ')' && (url.match(/\(/g) || []).length >= (url.match(/\)/g) || []).length)) { tail = c + tail; url = url.slice(0, -1); } else break;
    }
    if (!/^https?:\/\/./i.test(url) && !/^(www\.|spac3\.app\/)./i.test(url)) continue;
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    out += escapeHtml(src.slice(last, m.index)) + `<a class="chat-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(url)}</a>` + escapeHtml(tail);
    last = m.index + m[1].length;
  }
  return out + escapeHtml(src.slice(last));
}

export function timeLabel(iso) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

// Heading for a day's worth of chat: "Today", "Yesterday", otherwise
// "Sat, Oct 3" (plus the year when it isn't this year). Also returns a
// stable local-calendar-day key so callers can tell when the day changes.
export function chatDayInfo(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { key: '', label: '' };
  const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const isSame = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  let label;
  if (isSame(d, now)) label = 'Today';
  else if (isSame(d, yesterday)) label = 'Yesterday';
  else {
    label = d.toLocaleDateString([], d.getFullYear() === now.getFullYear()
      ? { weekday: 'short', month: 'short', day: 'numeric' }
      : { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }
  return { key, label };
}

// Shared rules for rendering a user's "avatar badge" (the little
// circular avatar shown in the top bar, the avatar picker's preview,
// each room's floating avatars, and the members list) -- kept in one
// place so all of them treat an uploaded photo (avatar_url) the same
// way: it always wins over the emoji+color badge when present, and the
// emoji+color pair is the fallback (used automatically once more if a
// photo is removed, or hasn't finished loading).
//
// avatarBackground() returns a `style` attribute VALUE (no surrounding
// quotes) meant to be dropped straight into a `style="${...}"` HTML
// template string -- which is exactly why the url(...) below uses
// SINGLE quotes: the attribute itself is double-quoted at every call
// site, so a literal `"` here would end that attribute early and
// corrupt the rest of the tag. Anywhere building a real DOM element
// directly should set the equivalent el.style.* properties instead
// rather than parsing this string back out. avatarGlyph() returns the
// emoji to show as text content -- '' when a photo is in play, since
// the photo itself is the visual there.
export function avatarBackground(p) {
  const color = (p && p.avatar_color) || '#7dd3fc';
  const url = p && p.avatar_url;
  return url
    ? `background-image:url('${escapeHtml(url)}');background-size:cover;background-position:center;background-color:${color};`
    : `background:${color};`;
}
export function avatarGlyph(p) {
  return (p && p.avatar_url) ? '' : ((p && p.avatar_emoji) || '🙂');
}

// ---- tiny shared helpers (one copy for the whole app) ----
/** Keeps `v` between `lo` and `hi`. */
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/** `document.querySelector` shorthand (optionally inside `root`). */
export const $ = (sel, root = document) => root.querySelector(sel);
// A picture sent from the Sketchpad lives at .../sketches/<id>.png or .webp; chat and direct messages show only these as pictures.
export const SKETCH_URL_RE = /\/sketches\/[\w-]+\.(png|webp)$/;

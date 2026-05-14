// Tiny SVG icon library — inline so there are no extra HTTP requests
// and icons inherit `color` via `fill="currentColor"`.
//
// Paths are 24x24 Material-Symbols-style outlines. Single-source so
// every emoji in the UI can be swapped for a proper vector glyph.
//
// Usage:
//   icon('inbox')                 // 24x24 default
//   icon('search', { size: 20 })  // override pixel size
//   icon('star', { class: 'starred' })  // extra class on the <svg>

const PATHS = {
  // ─── Navigation / chrome ─────────────────────────────────────────
  menu:    'M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z',
  search:  'M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z',
  refresh: 'M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6a5.88 5.88 0 0 1 4.22 1.78L13 11h7V4l-2.35 2.35z',
  close:   'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z',
  back:    'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
  caret:   'M7 10l5 5 5-5H7z',

  // ─── Actions ────────────────────────────────────────────────────
  compose:    'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
  send:       'M2.01 21 23 12 2.01 3 2 10l15 2-15 2z',
  reply:      'M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z',
  replyAll:   'M7 8V5l-7 7 7 7v-3l-4-4 4-4zm6 1V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z',
  mailUnread: 'M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z',
  attachment: 'M16.5 6v11.5a4 4 0 0 1-8 0V5a2.5 2.5 0 0 1 5 0v10.5a1 1 0 0 1-2 0V6H10v9.5a2.5 2.5 0 0 0 5 0V5a4 4 0 0 0-8 0v12.5a5.5 5.5 0 0 0 11 0V6h-1.5z',

  // ─── Stars ──────────────────────────────────────────────────────
  starOutline: 'M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.64-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z',
  starFilled:  'M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27z',

  // ─── Sidebar folders ────────────────────────────────────────────
  inbox:   'M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 12h-4c0 1.66-1.35 3-3 3s-3-1.34-3-3H5V5h14v10z',
  // Material-style archive: lidded box with horizontal slot.
  archive: 'M20.54 5.23l-1.39-1.68A1.45 1.45 0 0 0 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23A2 2 0 0 0 3 6.5V19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.5c0-.5-.18-.96-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.82-1h12l.93 1H5.12z',
  sent:    'M2.01 21 23 12 2.01 3 2 10l15 2-15 2z',
  drafts:  'M19 3H4.99c-1.11 0-1.98.9-1.98 2L3 19a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7l-8 5-8-5V5l8 5 8-5v2h2V5a2 2 0 0 0-2-2z',
  allMail: 'M22 4h-2v9.38l-2.79-2.79L16 12l4 4 4-4-1.21-1.21L22 13.38V4zM4 4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8h-2v10H4V6h12V4H4z',
  spam:    'M12 2 1 21h22L12 2zm1 14h-2v-2h2v2zm0-4h-2V8h2v4z',
  trash:   'M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',

  // ─── Branding glyph (bow) ───────────────────────────────────────
  // Stylised pink bow, used in place of the 🎀 emoji.
  bow:     'M12 12c-2-3-5-5-8-5-1 0-2 1-2 2s1 2 2 2c2 0 4 1 5 2-1 1-3 2-5 2-1 0-2 1-2 2s1 2 2 2c3 0 6-2 8-5 2 3 5 5 8 5 1 0 2-1 2-2s-1-2-2-2c-2 0-4-1-5-2 1-1 3-2 5-2 1 0 2-1 2-2s-1-2-2-2c-3 0-6 2-8 5zm0 2a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z',

  // ─── Status / dots ──────────────────────────────────────────────
  dot:     'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  check:   'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z',
};

export function icon(name, opts = {}) {
  const path = PATHS[name];
  if (!path) return '';
  const size = opts.size ?? 20;
  const cls = `icon-svg ${opts.class ?? ''}`.trim();
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${path}"/></svg>`;
}

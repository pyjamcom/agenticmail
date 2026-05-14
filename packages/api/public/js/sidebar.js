// Gmail-style folder sidebar.
//
// AgenticMail's mail store is IMAP-backed (Stalwart), so "folders"
// here are IMAP mailbox names. We expose the same shortlist Gmail's
// sidebar shows. The "All Mail" entry is a convenience that maps to
// the inbox endpoint until per-mailbox listing is wired through the
// public API.
import { state } from './state.js';
import { icon } from './icons.js';

// `All Mail` is a Gmail-only concept (a virtual folder that
// aggregates every message regardless of mailbox). Stalwart and most
// other IMAP servers don't expose anything equivalent, so we ship
// the link but hide it at render time when the discovery cache
// didn't find a real folder name — see `renderSidebar`. The
// flag below is what the renderer keys off.
export const FOLDERS = [
  { id: 'inbox',   label: 'Inbox',    icon: 'inbox' },
  { id: 'starred', label: 'Starred',  icon: 'starOutline' },
  { id: 'sent',    label: 'Sent',     icon: 'sent' },
  { id: 'drafts',  label: 'Drafts',   icon: 'drafts' },
  { id: 'archive', label: 'Archive',  icon: 'archive' },
  { id: 'all',     label: 'All Mail', icon: 'allMail', requiresDiscovery: true },
  { id: 'spam',    label: 'Spam',     icon: 'spam' },
  { id: 'trash',   label: 'Trash',    icon: 'trash' },
];

export function renderSidebar(onSelect) {
  const root = document.getElementById('folder-list');
  if (!root) return;
  const active = state.selectedFolder ?? 'inbox';
  const unread = state.unread?.[state.selectedAgent?.id] ?? 0;
  // Hide folders that need discovery but didn't get a real IMAP
  // name from the per-agent folder cache. Saves the user from
  // clicking "All Mail" and getting an empty-state error on
  // servers that don't have an equivalent (Stalwart, most non-
  // Gmail providers).
  const visible = FOLDERS.filter(f => !f.requiresDiscovery || state.folderNames?.[f.id]);
  root.innerHTML = visible.map(f => {
    const isActive = f.id === active;
    const showCount = f.id === 'inbox' && unread > 0;
    return `
      <div class="folder-row ${isActive ? 'active' : ''}" data-folder="${f.id}">
        <span class="icon">${icon(f.icon, { size: 20 })}</span>
        <span class="label">${f.label}</span>
        <span class="count" ${showCount ? '' : 'data-zero'}>${showCount ? unread : ''}</span>
      </div>
    `;
  }).join('');
  root.querySelectorAll('.folder-row').forEach(el => {
    el.addEventListener('click', () => onSelect(el.dataset.folder));
  });
}

// Main entry — wires the modules, runs auth, and drives the
// hash-based router.
//
// Routes:
//   #/inbox    → folder list view (active folder lives in state)
//   #/m/:uid   → single-message view
import { state, API_URL } from './state.js';
import { toast } from './utils.js';
import { apiGet } from './api.js';
import { isBridgeAgent } from './avatar.js';
import { renderProfile, toggleProfileMenu, closeProfileMenu } from './profile.js';
import { renderSidebar } from './sidebar.js';
import { loadList, renderList, clearSearch, ensureFolderCache } from './list-view.js';
import { openMessage } from './message-view.js';
import { populateComposeFrom, openCompose, openDraft, closeCompose, discardCompose, sendCompose } from './compose.js';
import { subscribeToAllAgents, maybeRequestNotificationPermission } from './sse.js';
import { icon } from './icons.js';

// Hydrate every `data-icon="name"` placeholder in the static HTML
// with the corresponding inline SVG. Done once on load so we don't
// keep emojis around as fallback.
function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    const name = el.dataset.icon;
    const size = el.dataset.iconSize ? Number(el.dataset.iconSize) : undefined;
    el.innerHTML = icon(name, size ? { size } : {});
  });
}
hydrateIcons();

// ─── Auth ────────────────────────────────────────────────────────────
const authApiUrl = document.getElementById('auth-api-url');
if (authApiUrl) authApiUrl.textContent = API_URL;

async function signIn() {
  const key = document.getElementById('auth-key').value.trim();
  if (!key) return showAuthErr('Master key is required.');
  try {
    const resp = await fetch(`${API_URL}/api/agenticmail/accounts`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    localStorage.setItem('agenticmail.masterKey', key);
    state.masterKey = key;
    document.getElementById('auth').style.display = 'none';
    document.getElementById('app').style.display = 'grid';
    await bootstrap();
  } catch (err) {
    showAuthErr(`Sign-in failed: ${err.message}. Check the key and that the API is running on ${API_URL}.`);
  }
}
function showAuthErr(msg) {
  const e = document.getElementById('auth-err');
  e.textContent = msg; e.style.display = 'block';
}
function signOut() {
  localStorage.removeItem('agenticmail.masterKey');
  location.reload();
}

document.getElementById('auth-submit').addEventListener('click', signIn);
document.getElementById('auth-key').addEventListener('keydown', e => {
  if (e.key === 'Enter') signIn();
});
document.getElementById('signout-link').addEventListener('click', signOut);

// ─── Bootstrap ───────────────────────────────────────────────────────
async function bootstrap() {
  try {
    const data = await apiGet('/accounts');
    const all = (data.agents ?? data ?? []);
    // Bridge agent pinned to top of switcher; everyone else alphabetical.
    all.sort((a, b) => {
      const aBridge = isBridgeAgent(a) ? 0 : 1;
      const bBridge = isBridgeAgent(b) ? 0 : 1;
      if (aBridge !== bBridge) return aBridge - bBridge;
      return a.name.localeCompare(b.name);
    });
    state.agents = all;
    const initial = state.agents.find(isBridgeAgent) ?? state.agents[0];
    if (initial) await selectAgent(initial);
    renderProfile();
    populateComposeFrom();
    subscribeToAllAgents();
    maybeRequestNotificationPermission();
    // Initial route: if the URL already has a hash (e.g. a refresh
    // on /#/folder/sent), respect it; otherwise default to inbox.
    if (!location.hash) location.hash = '#/folder/inbox';
    else route();
  } catch (err) {
    toast(`Failed to load agents: ${err.message}`, true);
  }
}

async function selectAgent(agent) {
  state.selectedAgent = agent;
  state.selectedUid = null;
  state.currentMessage = null;
  // Reset the per-agent folder cache so a fresh discovery runs
  // against the new agent's IMAP. Otherwise switching to an
  // account that uses different folder names (e.g. Gmail relay
  // vs vanilla Stalwart) keeps the previous cache.
  state.folderNames = {};
  // Discover folders BEFORE the first sidebar render so the
  // `requiresDiscovery` hide-rule (All Mail on non-Gmail servers)
  // has the cache to consult. Falls back to defaults on failure.
  await ensureFolderCache(agent);
  renderSidebar(onFolderSelect);
  renderProfile();
  await loadList(agent, state.selectedFolder);
}

function onFolderSelect(folder) {
  // URL drives state — set the hash and let the router do the work.
  // This is what makes browser back / forward / shareable URLs work,
  // and it stops the previous bug where every folder click stayed on
  // #/inbox in the address bar.
  location.hash = `#/folder/${folder}`;
  // On mobile (the only viewport where the sidebar is over-canvas),
  // close it after a folder pick so the user sees the list.
  document.getElementById('main')?.classList.remove('sidebar-open');
}

// ─── Hash router ─────────────────────────────────────────────────────
// Routes:
//   #/inbox            → inbox (back-compat shortcut for #/folder/inbox)
//   #/folder/<id>      → folder list view (sent, drafts, starred, …)
//   #/m/<uid>          → single-message detail
//
// Folder switches go through here too so the URL is the source of truth
// for "what's on screen". If you bookmark or copy-paste a URL like
// http://127.0.0.1:3829/#/folder/sent, opening it lands you on Sent.
function route() {
  const hash = location.hash || '#/inbox';
  const msgMatch = hash.match(/^#\/m\/(\d+)$/);
  if (msgMatch) {
    openMessage(Number(msgMatch[1]));
    return;
  }
  // Drafts use UUIDs as ids and open the compose modal pre-
  // populated rather than the read-only message view. The list
  // row click handler emits #/d/<uuid> for draft rows.
  const draftMatch = hash.match(/^#\/d\/([a-zA-Z0-9-]+)$/);
  if (draftMatch) {
    openDraft(draftMatch[1]);
    return;
  }
  const folderMatch = hash.match(/^#\/folder\/([a-z]+)$/);
  const folder = folderMatch ? folderMatch[1] : 'inbox';
  if (state.selectedFolder !== folder) {
    state.selectedFolder = folder;
    renderSidebar(onFolderSelect);
  }
  if (state.selectedAgent) loadList(state.selectedAgent, folder);
}
window.addEventListener('hashchange', route);

// ─── Top bar wiring ──────────────────────────────────────────────────
// Hamburger toggles the sidebar on mobile. On desktop the sidebar
// is always visible; the class only changes anything below 800 px,
// where the CSS slides it off-canvas by default.
function toggleSidebar() {
  const main = document.getElementById('main');
  main?.classList.toggle('sidebar-open');
}
document.getElementById('menu-btn').addEventListener('click', toggleSidebar);
document.getElementById('sidebar-backdrop').addEventListener('click', () => {
  document.getElementById('main')?.classList.remove('sidebar-open');
});

document.getElementById('refresh-btn').addEventListener('click', async () => {
  if (state.selectedAgent) {
    await loadList(state.selectedAgent, state.selectedFolder);
    toast('Refreshed.');
  }
});
document.getElementById('compose-btn').addEventListener('click', openCompose);
document.getElementById('profile-btn').addEventListener('click', toggleProfileMenu);
document.getElementById('profile-menu').addEventListener('click', e => {
  e.stopPropagation();
  const item = e.target.closest('.profile-menu-item');
  if (!item) return;
  const agent = state.agents.find(a => a.id === item.dataset.id);
  if (agent && agent.id !== state.selectedAgent?.id) selectAgent(agent);
  closeProfileMenu();
});
document.addEventListener('click', e => {
  const menu = document.getElementById('profile-menu');
  const btn = document.getElementById('profile-btn');
  if (!menu || !btn) return;
  if (!menu.contains(e.target) && !btn.contains(e.target)) closeProfileMenu();
});

// ─── Compose modal wiring ────────────────────────────────────────────
document.getElementById('compose-close').addEventListener('click', closeCompose);
document.getElementById('compose-cancel').addEventListener('click', discardCompose);
document.getElementById('compose-send').addEventListener('click', sendCompose);
document.getElementById('compose-bg').addEventListener('click', e => {
  if (e.target.id === 'compose-bg') closeCompose();
});

// ─── Search (debounced, Esc clears) ─────────────────────────────────
let searchDebounce = null;
const searchInput = document.getElementById('search-input');
searchInput.addEventListener('input', e => {
  const v = e.target.value;
  e.target.classList.toggle('has-query', v.length > 0);
  document.getElementById('search-clear').classList.toggle('show', v.length > 0);
  if (searchDebounce) clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    state.searchQuery = v;
    renderList();
  }, 80);
});
searchInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); clearSearch(); }
});
document.getElementById('search-clear').addEventListener('click', clearSearch);

// ─── Keyboard shortcuts (Gmail-style) ───────────────────────────────
//   r  refresh current inbox
//   c  compose new
//   /  focus the search box
//
// IMPORTANT: every shortcut bails when ANY modifier key is held
// (Cmd / Ctrl / Alt / Meta) — otherwise Cmd+C "copy" was opening
// the compose modal, Cmd+R was overriding browser refresh, etc.
// Plain unmodified single-key shortcuts only.
document.addEventListener('keydown', e => {
  if (document.getElementById('compose-bg').style.display !== 'none') return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;  // never hijack OS shortcuts
  if (e.key === 'r') document.getElementById('refresh-btn').click();
  else if (e.key === 'c') openCompose();
  else if (e.key === '/') {
    e.preventDefault();
    searchInput.focus();
  }
});

// ─── Boot ───────────────────────────────────────────────────────────
(() => {
  // Accept `?key=...` from the CLI's `agenticmail web` command, then
  // strip it from the URL so it doesn't leak via Referer / history /
  // screen shares. Safe because the URL is loopback-only.
  try {
    const params = new URL(location.href).searchParams;
    const urlKey = params.get('key');
    if (urlKey) {
      localStorage.setItem('agenticmail.masterKey', urlKey);
      history.replaceState({}, '', location.pathname + location.hash);
    }
  } catch {}

  const saved = localStorage.getItem('agenticmail.masterKey');
  if (saved) {
    state.masterKey = saved;
    document.getElementById('auth').style.display = 'none';
    document.getElementById('app').style.display = 'grid';
    bootstrap();
  }
})();

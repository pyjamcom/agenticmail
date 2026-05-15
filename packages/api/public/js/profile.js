// Top-right Gmail-style account switcher. Lists every AgenticMail
// agent the master key can see; clicking switches the active inbox.
//
// ──────────────────────────────────────────────────────────────────
// Host-switcher (the Airbnb "switch to hosting" pattern)
// ──────────────────────────────────────────────────────────────────
//
// Above the inbox list we render a segmented pill toggle showing each
// known host (Claude / Codex / All). Clicking a pill flips the inbox
// list with a 3D Y-axis rotation, swapping the content at the exact
// orthogonal midpoint of the rotation so the "front" and "back" of
// the card appear to carry different rosters — same trick Airbnb's
// Host Passport uses for its book-flip illusion. (See the Airbnb
// engineering blog: "Animations: Bringing the Host Passport to Life".)
//
// The selected host persists in localStorage so the operator's view
// preference survives reloads and across browser tabs.
import { state } from './state.js';
import { escapeHtml } from './utils.js';
import { avatarHtml, isBridgeAgent } from './avatar.js';
import { icon } from './icons.js';

/**
 * Host registry mirrors the one in avatar.js. Kept duplicated rather
 * than imported because that file's HOST_BRANDING table is concerned
 * with logo paths; here we care about display labels + filter
 * semantics. Adding a new host = one row in both places.
 */
const HOST_FILTERS = [
  {
    id: 'claudecode',
    label: 'Claude',
    logoUrl: '/branding/claude-color.svg',
    aliases: ['claude'],
  },
  {
    id: 'codex',
    label: 'Codex',
    logoUrl: '/branding/openai-mark.svg',
    aliases: ['openai', 'chatgpt'],
  },
];

/**
 * The "All" pill is always present — it's the original behavior of
 * showing every account regardless of host, useful for operators who
 * want a global view (the same way Airbnb's host switcher always
 * lets you fall back to the unified profile).
 */
const ALL_FILTER = { id: 'all', label: 'All', logoUrl: null };

/**
 * Return the host id this agent belongs to, lowercased and normalised
 * against the host filter table. Returns `null` when the agent has no
 * host stamp at all (legacy / unclaimed accounts).
 */
function hostIdForAgent(agent) {
  const meta = agent.metadata ?? {};
  const raw = typeof meta.host === 'string' ? meta.host.toLowerCase().trim() : '';
  if (!raw) return null;
  for (const h of HOST_FILTERS) {
    if (h.id === raw) return h.id;
    if (h.aliases?.includes(raw)) return h.id;
  }
  return raw;  // unknown future host — still let the user filter by it
}

/**
 * Compute the visible inbox list for the current `state.activeHost`.
 *
 *   'all'        → every account, no filtering
 *   '<host id>'  → only the matching bridge + sub-agents owned by it
 *
 * The bridge is forced to the top of the list within its host's view
 * (it's the host's own identity — "you, the operator" — analogous to
 * Airbnb pinning your own account row above your sub-listings).
 */
function visibleAgents() {
  if (state.activeHost === 'all') return state.agents;
  const wanted = state.activeHost.toLowerCase();
  return state.agents.filter(a => hostIdForAgent(a) === wanted);
}

/**
 * Build the host-switcher pill bar. Only renders pills for hosts that
 * have at least one agent (bridge OR sub-agent) so the UI doesn't
 * show a "Codex" pill if codex isn't installed yet.
 */
function renderHostSwitcher() {
  const presentHosts = new Set(
    state.agents
      .map(a => hostIdForAgent(a))
      .filter(Boolean),
  );
  const filters = [
    ALL_FILTER,
    ...HOST_FILTERS.filter(h => presentHosts.has(h.id)),
  ];
  // Single-host installs don't need a switcher — degrades to nothing.
  if (filters.length <= 1) return '';
  return `
    <div class="host-switcher" role="tablist" aria-label="Filter inboxes by host">
      ${filters.map(f => {
        const active = state.activeHost === f.id;
        const logo = f.logoUrl
          ? `<img src="${f.logoUrl}" alt="" class="host-switcher-logo" />`
          : `<span class="host-switcher-dot">${icon('dot', { size: 8 })}</span>`;
        return `
          <button
            type="button"
            class="host-switcher-pill ${active ? 'is-active' : ''}"
            data-host="${escapeHtml(f.id)}"
            role="tab"
            aria-selected="${active}"
            title="Show only ${escapeHtml(f.label)} agents"
          >
            ${logo}
            <span>${escapeHtml(f.label)}</span>
          </button>
        `;
      }).join('')}
    </div>
  `;
}

/**
 * Build the actual inbox-list HTML (a sibling-by-sibling string of
 * `.profile-menu-item` divs). Factored out so we can pre-render BOTH
 * the current view and the next view when animating a host switch.
 */
function renderInboxListHtml(agents) {
  if (agents.length === 0) {
    return `
      <div class="profile-menu-empty">
        <div class="empty-icon">${icon('inbox', { size: 28 })}</div>
        <div class="empty-text">No agents in this view yet.</div>
        <div class="empty-hint">
          Switch to <strong>All</strong> above, or use<br/>
          <code>agenticmail-&lt;host&gt; claim &lt;name&gt;</code><br/>
          to assign agents to this host.
        </div>
      </div>
    `;
  }
  return agents.map(agent => {
    const selected = state.selectedAgent?.id === agent.id;
    const badge = isBridgeAgent(agent)
      ? '<span class="role-badge role-badge-host">Host</span>'
      : '<span class="role-badge role-badge-sub">Sub-agent</span>';
    // Host-ownership badge — shows which LLM the agent rides on.
    // Populated by the MCP server's create_account from
    // AGENTICMAIL_MCP_HOST in the host install's MCP env block.
    // Bridges already show "Host" so we skip the extra chip there.
    const hostTag = !isBridgeAgent(agent) ? hostBadge(agent) : '';
    const check = selected ? `<span class="selected-check">${icon('check', { size: 20 })}</span>` : '';
    const unread = state.unread?.[agent.id] ?? 0;
    const unreadDot = unread > 0
      ? `<span class="role-badge" style="background:var(--pink);color:white;">${unread} new</span>`
      : '';
    return `
      <div class="profile-menu-item" data-id="${agent.id}">
        ${avatarHtml(agent, 'avatar-md')}
        <div class="meta">
          <div class="name">${escapeHtml(agent.name)} ${badge} ${hostTag} ${unreadDot}</div>
          <div class="email">${escapeHtml(agent.email ?? '')}</div>
        </div>
        ${check}
      </div>
    `;
  }).join('');
}

export function renderProfile() {
  const a = state.selectedAgent;
  const totalOtherUnread = Object.entries(state.unread ?? {})
    .filter(([id]) => id !== a?.id)
    .reduce((sum, [, n]) => sum + n, 0);

  const avatarEl = document.getElementById('profile-avatar');
  if (avatarEl) {
    avatarEl.innerHTML = a
      ? avatarHtml(a) + (totalOtherUnread > 0 ? `<span class="avatar-check" style="background:#dc2626">${icon('dot', { size: 8 })}</span>` : '')
      : '';
  }

  const switcherSlot = document.getElementById('profile-menu-switcher');
  if (switcherSlot) switcherSlot.innerHTML = renderHostSwitcher();

  const list = document.getElementById('profile-menu-list');
  if (!list) return;
  // Render into the .flip-face-front pane. The .flip-face-back pane
  // exists for the in-flight animation only and gets populated on
  // demand by `flipToHost`. After every plain re-render we also
  // reset the wrapper so a stale rotation can't strand us mid-flip.
  const front = list.querySelector('.flip-face-front');
  if (front) {
    front.innerHTML = renderInboxListHtml(visibleAgents());
  } else {
    list.innerHTML = `
      <div class="flip-card">
        <div class="flip-face flip-face-front">${renderInboxListHtml(visibleAgents())}</div>
        <div class="flip-face flip-face-back"></div>
      </div>
    `;
  }
}

/**
 * Render a host-ownership badge for an agent. The host name comes from
 * `metadata.host` on the account. Three states:
 *
 *   - "Claude" (purple) — owned by the Claude Code dispatcher
 *   - "Codex" (orange) — owned by the OpenAI Codex dispatcher
 *   - "Unclaimed" (gray) — no host tag yet; legacy or pre-MCP-tagging.
 *     Both dispatchers (if both running) will wake on this account.
 *     User can claim with `agenticmail-<host> claim <name>`.
 *
 * Returns an empty string when metadata is genuinely absent and we
 * don't want to clutter the row (e.g. the bridge account itself,
 * which already shows "Host").
 */
function hostBadge(agent) {
  const meta = agent.metadata ?? {};
  const host = typeof meta.host === 'string' ? meta.host.toLowerCase() : '';
  if (host === 'claudecode' || host === 'claude') {
    return '<span class="role-badge role-badge-claude" title="Owned by the Claude Code dispatcher (runs on Anthropic via @anthropic-ai/claude-agent-sdk)">Claude</span>';
  }
  if (host === 'codex') {
    return '<span class="role-badge role-badge-codex" title="Owned by the OpenAI Codex dispatcher (runs on OpenAI via @openai/codex-sdk)">Codex</span>';
  }
  if (host) {
    // Unknown host (forward-compat with Grok / Hermes when they land).
    return `<span class="role-badge role-badge-host-other" title="Owned by the ${escapeHtml(host)} dispatcher">${escapeHtml(host)}</span>`;
  }
  // No host tag — surface the "unclaimed" state explicitly so the user
  // notices and runs `agenticmail-<host> claim` if they have multiple
  // dispatchers running.
  return '<span class="role-badge role-badge-unclaimed" title="No host owner — any dispatcher will wake on this account. Run `agenticmail-<host> claim <name>` to settle ownership.">Unclaimed</span>';
}

/**
 * Animate a switch from the current `state.activeHost` to `nextHost`.
 *
 * Trick borrowed from Airbnb's Host Passport flip and the classic CSS
 * "flip-card" pattern: the inbox-list wrapper has TWO stacked faces
 * with `backface-visibility: hidden`. The front face shows the current
 * roster; we pre-populate the back face with the next roster, then
 * rotate the wrapper 180deg on the Y axis. CSS handles the rest — the
 * front face is visible for the first 90deg, fades to edge-on (and
 * thus invisible) at the midpoint, then the back face takes over for
 * the second 90deg.
 *
 * After the transition completes, we swap the contents (so the
 * now-visible "back" face becomes the new "front") and reset the
 * rotation without animation, leaving the card ready for the next
 * flip. This avoids ever-accumulating rotation values.
 *
 * Honors `prefers-reduced-motion`: skips the rotation entirely and
 * just updates the roster in place.
 */
function flipToHost(nextHost) {
  if (nextHost === state.activeHost) return;
  state.activeHost = nextHost;
  try { localStorage.setItem('agenticmail.activeHost', nextHost); } catch { /* private mode */ }

  // Re-render the switcher pill highlights up front so the pressed
  // pill flips highlighted state immediately. Visual feedback first,
  // animation second.
  const switcherSlot = document.getElementById('profile-menu-switcher');
  if (switcherSlot) switcherSlot.innerHTML = renderHostSwitcher();

  const list = document.getElementById('profile-menu-list');
  if (!list) return;
  const card = list.querySelector('.flip-card');
  const front = list.querySelector('.flip-face-front');
  const back = list.querySelector('.flip-face-back');
  if (!card || !front || !back) {
    // No flip scaffold (first render shouldn't hit this). Plain render.
    renderProfile();
    return;
  }

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const nextHtml = renderInboxListHtml(visibleAgents());

  if (reduceMotion) {
    front.innerHTML = nextHtml;
    return;
  }

  // Pre-populate the back face with the destination roster so it's
  // ready to be revealed past the 90deg midpoint.
  back.innerHTML = nextHtml;

  // Kick the flip. The transition is defined in CSS; we just toggle
  // the .flipped class to start the rotation.
  // requestAnimationFrame ensures the back-face innerHTML update has
  // committed to the layout before the rotation begins, otherwise
  // Safari can show the old back-face content briefly.
  requestAnimationFrame(() => {
    card.classList.add('flipped');
  });

  // After the animation completes, swap the faces so the "back" face
  // becomes the new "front" and reset the rotation. This avoids the
  // angle drifting to 360deg, 540deg, etc on repeated flips.
  const onEnd = (event) => {
    if (event.target !== card) return;  // child transitions can fire too
    card.removeEventListener('transitionend', onEnd);
    front.innerHTML = nextHtml;
    back.innerHTML = '';
    // Disable transitions for the reset so it's an instant snap.
    card.style.transition = 'none';
    card.classList.remove('flipped');
    // Force layout flush so the next .flipped toggle re-engages the transition.
    // eslint-disable-next-line no-unused-expressions
    card.offsetWidth;
    card.style.transition = '';
  };
  card.addEventListener('transitionend', onEnd);
}

/**
 * Wire the pill buttons up to `flipToHost`. We use event delegation
 * on the switcher slot so the listener doesn't need re-binding after
 * every `renderHostSwitcher()` re-write (the buttons inside the slot
 * are replaced wholesale on each render).
 */
export function bindHostSwitcher() {
  const slot = document.getElementById('profile-menu-switcher');
  if (!slot || slot.dataset.bound === '1') return;
  slot.dataset.bound = '1';
  slot.addEventListener('click', (e) => {
    const pill = e.target.closest('.host-switcher-pill');
    if (!pill) return;
    e.stopPropagation();
    const host = pill.dataset.host;
    if (host) flipToHost(host);
  });
}

export function toggleProfileMenu(e) {
  if (e) e.stopPropagation();
  document.getElementById('profile-menu').classList.toggle('open');
}
export function closeProfileMenu() {
  document.getElementById('profile-menu').classList.remove('open');
}

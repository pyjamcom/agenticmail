// Real-time worker activity badges in the topbar.
//
// The dispatcher posts worker_started / worker_heartbeat /
// worker_finished events to /system/events. This module
// subscribes (master-key auth), maintains a map of active
// workers, and paints a small badge per active worker
// between the search bar and the notification bell.
//
// Each badge shows: agent avatar/initial · friendly status
// derived from the last tool the worker invoked. Updates
// arrive at the heartbeat cadence (30 s) so the badge text
// reflects what the agent is doing right now.

import { onSystemEvent } from './system-stream.js';
import { state, API_URL } from './state.js';

const BADGE_CONTAINER_ID = 'activity-badges';
const SHELL_ID = 'activity-badges-shell';
const COUNT_ID = 'activity-badges-count';

/**
 * Map of workerId → { agentName, kind, lastTool, turnCount,
 * startedAtMs }. Maintained off the SSE stream; rendered into
 * the badge container on every event.
 */
const workers = new Map();
let unsubWorkerStarted = null;
let unsubWorkerHeartbeat = null;
let unsubWorkerFinished = null;

/**
 * Map an SDK tool name (or the truncated head we capture in
 * dispatcher logs) to a short verb. Falls back to "working"
 * when we don't recognise the tool. The mapping is intentionally
 * generic — exotic tools default to "working" rather than
 * leaking the raw tool name to a user-facing badge.
 */
function statusFor(lastTool) {
  if (!lastTool) return 'starting';
  const t = lastTool.toLowerCase();
  if (t.startsWith('read'))         return 'reading';
  if (t.startsWith('write'))        return 'writing code';
  if (t.startsWith('edit'))         return 'editing code';
  if (t.startsWith('bash'))         return 'running shell';
  if (t.startsWith('grep'))         return 'searching';
  if (t.startsWith('glob'))         return 'searching';
  if (t.startsWith('webfetch'))     return 'fetching web';
  if (t.startsWith('websearch'))    return 'searching web';
  if (t.startsWith('notebookedit')) return 'editing notebook';
  if (t.includes('send_email'))     return 'sending mail';
  if (t.includes('reply_email'))    return 'replying';
  if (t.includes('read_email'))     return 'reading mail';
  if (t.includes('list_inbox'))     return 'checking inbox';
  if (t.includes('search_emails'))  return 'searching mail';
  if (t.includes('call_agent'))     return 'delegating';
  if (t.includes('submit_result'))  return 'finishing';
  if (t.includes('save_thread_memory')) return 'saving memory';
  if (t.startsWith('mcp__'))        return 'using tool';
  return 'working';
}

function render() {
  const root = document.getElementById(BADGE_CONTAINER_ID);
  const shell = document.getElementById(SHELL_ID);
  const countEl = document.getElementById(COUNT_ID);
  if (!root) return;
  const list = Array.from(workers.values()).sort((a, b) => (a.startedAtMs ?? 0) - (b.startedAtMs ?? 0));
  // Drive the shell + count pill so users see "3 active" even when only
  // 2 badges fit in the scroll viewport. Empty state hides the whole
  // shell so the topbar doesn't carry a dangling "0" pill.
  if (shell) shell.hidden = list.length === 0;
  if (countEl) {
    countEl.textContent = String(list.length);
    countEl.title = list.length === 1
      ? '1 agent active'
      : `${list.length} agents active`;
  }
  if (list.length === 0) { root.innerHTML = ''; return; }
  root.innerHTML = list.map(w => {
    const initial = (w.agentName ?? '?').slice(0, 1).toUpperCase();
    const status = statusFor(w.lastTool);
    const tooltip = `${w.agentName} — ${status}${w.turnCount ? ` · ${w.turnCount} tool calls` : ''}${w.lastTool ? `\nlast tool: ${w.lastTool}` : ''}`;
    return `
      <div class="activity-badge" title="${escapeAttr(tooltip)}" data-worker-id="${escapeAttr(w.workerId ?? '')}">
        <span class="badge-dot"></span>
        <span class="badge-initial">${escapeHtml(initial)}</span>
        <span class="badge-name">${escapeHtml(w.agentName ?? '?')}</span>
        <span class="badge-status">${escapeHtml(status)}</span>
      </div>
    `;
  }).join('');
}

function handleEvent(event) {
  if (!event || typeof event !== 'object') return;
  const w = event.worker;
  if (!w?.workerId) return;
  if (event.type === 'worker_started' || event.type === 'worker_heartbeat') {
    // Merge so a heartbeat-after-started preserves the start
    // metadata without re-fetching.
    const existing = workers.get(w.workerId) ?? {};
    workers.set(w.workerId, { ...existing, ...w });
    render();
  } else if (event.type === 'worker_finished') {
    workers.delete(w.workerId);
    render();
  }
}

/**
 * One-shot backfill: pull the dispatcher's currently-active workers
 * so the badges appear IMMEDIATELY on page load if anything is in
 * flight. Without this, the user only sees badges when the next
 * worker_heartbeat / worker_started event fires — which can be up
 * to 30 s away (heartbeat cadence), or never if the worker happens
 * to finish first.
 *
 * Failures here are silent — the SSE stream is the source of truth
 * for subsequent updates and will paint badges as events arrive.
 */
async function backfillActiveWorkers() {
  try {
    const res = await fetch(`${API_URL}/api/agenticmail/dispatcher/activity`, {
      headers: { Authorization: `Bearer ${state.masterKey}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    const active = Array.isArray(data?.active) ? data.active : [];
    for (const w of active) {
      if (w?.workerId) workers.set(w.workerId, w);
    }
    render();
  } catch { /* silent — SSE will repaint as events come in */ }
}

/**
 * Subscribe to worker_* events on the shared /system/events stream.
 * Idempotent — safe to call after agent-list refresh.
 */
export function subscribeToActivity() {
  if (unsubWorkerStarted) { try { unsubWorkerStarted(); } catch {} }
  if (unsubWorkerHeartbeat) { try { unsubWorkerHeartbeat(); } catch {} }
  if (unsubWorkerFinished) { try { unsubWorkerFinished(); } catch {} }
  unsubWorkerStarted   = onSystemEvent('worker_started',   handleEvent);
  unsubWorkerHeartbeat = onSystemEvent('worker_heartbeat', handleEvent);
  unsubWorkerFinished  = onSystemEvent('worker_finished',  handleEvent);
  // Paint whatever's already running BEFORE the first SSE event
  // arrives. Without this, an in-flight worker stays invisible
  // until its next heartbeat (~30 s) or until it finishes (which
  // then never paints since worker_finished just removes the
  // badge that never showed up).
  backfillActiveWorkers();
}

// Tiny HTML escapers (kept local to avoid an import cycle).
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }

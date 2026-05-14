// New-mail notifications for the web UI.
//
// Listens for `new_mail` events on the shared /system/events stream
// (one connection for the whole UI; see system-stream.js for why).
// Fans the event out to:
//   1. List view — silent in-place refresh (no flicker / scroll jump)
//      if it's the active inbox.
//   2. Profile dropdown — bump the per-agent unread counter.
//   3. Browser notification when tab isn't focused.
//   4. Soft chime (toggleable) when sound is enabled.

import { state } from './state.js';
import { toast } from './utils.js';
import { renderProfile } from './profile.js';
import { silentRefresh } from './list-view.js';
import { playNotificationSound } from './sound.js';
import { onSystemEvent } from './system-stream.js';

let unsubscribe = null;

/**
 * Wire the new-mail listener onto the shared system stream.
 * Idempotent — safe to call after agent-list refreshes.
 */
export function subscribeToAllAgents() {
  if (unsubscribe) { try { unsubscribe(); } catch {} }
  unsubscribe = onSystemEvent('new_mail', payload => {
    // payload shape: { type: 'new_mail', agentId, agentName, event }
    const agent = state.agents.find(a => a.id === payload.agentId);
    if (!agent) return;  // unknown agent (account_deleted race)
    handleSseEvent(agent, payload.event);
  });
}

async function handleSseEvent(agent, event) {
  if (event.type !== 'new') return;
  state.unread = state.unread ?? {};
  state.unread[agent.id] = (state.unread[agent.id] ?? 0) + 1;
  renderProfile();

  const isOpen = state.selectedAgent?.id === agent.id;
  if (isOpen) {
    await silentRefresh(agent, state.selectedFolder);
    state.unread[agent.id] = 0;
    renderProfile();
  }

  playNotificationSound();
  fireBrowserNotification(agent, event, isOpen);

  if (!isOpen) {
    const fromAddr = event.from?.address ?? event.from ?? 'someone';
    const subject = event.subject ?? '(no subject)';
    toast(`${agent.name}: ${subject} — from ${fromAddr}`);
  }
}

export function maybeRequestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted' || Notification.permission === 'denied') return;
  if (localStorage.getItem('agenticmail.notif.asked')) return;
  setTimeout(() => {
    Notification.requestPermission().finally(() => {
      localStorage.setItem('agenticmail.notif.asked', '1');
    });
  }, 2000);
}

function fireBrowserNotification(agent, event, isOpen) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (isOpen && document.visibilityState === 'visible') return;
  const fromAddr = event.from?.address ?? event.from ?? 'unknown sender';
  const subject = event.subject ?? '(no subject)';
  try {
    const n = new Notification(subject, {
      body: `${agent.name} — from ${fromAddr}`,
      icon: '/favicon.ico',
      tag: `agenticmail-${agent.id}-${event.uid}`,
      silent: false,
    });
    n.onclick = () => {
      window.focus();
      if (event.uid) location.hash = `#/m/${event.uid}`;
      n.close();
    };
  } catch {}
}

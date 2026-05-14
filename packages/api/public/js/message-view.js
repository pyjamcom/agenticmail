// Single-message detail view, opened when the user clicks a list row.
import { state } from './state.js';
import { escapeHtml, stripHtml, toast } from './utils.js';
import { formatDateFull } from './time.js';
import { renderMarkdown } from './markdown.js';
import { avatarHtml } from './avatar.js';
import { apiGet, apiPost } from './api.js';
import { openReply } from './compose.js';
import { loadList } from './list-view.js';
import { icon } from './icons.js';

export async function openMessage(uid) {
  if (!state.selectedAgent) return;
  state.selectedUid = uid;
  const root = document.getElementById('content');
  root.innerHTML = `
    <div class="message-toolbar">
      <button class="icon-btn" id="msg-back" title="Back to list">${icon('back')}</button>
      <button class="icon-btn" id="msg-reply" title="Reply">${icon('reply')}</button>
      <button class="icon-btn" id="msg-reply-all" title="Reply all">${icon('replyAll')}</button>
      <button class="icon-btn" id="msg-unread" title="Mark unread">${icon('mailUnread')}</button>
      <div class="toolbar-spacer"></div>
    </div>
    <div class="message-view"><div class="empty">Loading…</div></div>
  `;
  document.getElementById('msg-back').addEventListener('click', () => { location.hash = `#/folder/${state.selectedFolder ?? 'inbox'}`; });
  document.getElementById('msg-reply').addEventListener('click', () => openReply(false));
  document.getElementById('msg-reply-all').addEventListener('click', () => openReply(true));
  document.getElementById('msg-unread').addEventListener('click', () => markUnread());

  try {
    const msg = await apiGet(`/mail/messages/${uid}`, { agentKey: state.selectedAgent.apiKey });
    state.currentMessage = msg;
    renderMessage(msg);
  } catch (err) {
    root.querySelector('.message-view').innerHTML =
      `<div class="empty">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

function renderMessage(msg) {
  const view = document.querySelector('.message-view');
  if (!view) return;
  const fromAddr = msg.from?.[0]?.address ?? '?';
  const fromName = msg.from?.[0]?.name || fromAddr;
  const toStr = (msg.to ?? []).map(a => a.name ? `${a.name} <${a.address}>` : a.address).join(', ') || '?';
  const ccStr = (msg.cc ?? []).map(a => a.address).join(', ');
  const senderPseudo = { name: fromName };  // for avatar generation
  const bodyText = msg.text ?? stripHtml(msg.html ?? '');

  const attachmentsHtml = (msg.attachments ?? []).length > 0
    ? `<div class="message-attachments">${msg.attachments.map(a =>
        `<span class="message-attachment"><span class="att-icon">${icon('attachment', { size: 18 })}</span>${escapeHtml(a.filename ?? '(unnamed)')}${a.size ? ` · ${Math.round(a.size/1024)}KB` : ''}</span>`
      ).join('')}</div>`
    : '';

  view.innerHTML = `
    <div class="message-header">
      <h1 class="message-subject">${escapeHtml(msg.subject ?? '(no subject)')}</h1>
      <div class="message-sender-row">
        ${avatarHtml(senderPseudo, 'avatar-md')}
        <div class="message-meta">
          <div class="message-from">
            <span class="name">${escapeHtml(fromName)}</span>
            <span class="addr">&lt;${escapeHtml(fromAddr)}&gt;</span>
          </div>
          <div class="message-to">to ${escapeHtml(toStr)}${ccStr ? `, cc ${escapeHtml(ccStr)}` : ''}</div>
        </div>
        <div class="message-date">${escapeHtml(formatDateFull(msg.date))}</div>
      </div>
    </div>
    <div class="message-body">${renderMarkdown(bodyText)}</div>
    ${attachmentsHtml}
  `;
}

async function markUnread() {
  if (!state.currentMessage || !state.selectedAgent) return;
  try {
    await apiPost(`/mail/messages/${state.currentMessage.uid}/unseen`, {}, { agentKey: state.selectedAgent.apiKey });
    toast('Marked unread.');
    location.hash = `#/folder/${state.selectedFolder ?? 'inbox'}`;
    await loadList(state.selectedAgent, state.selectedFolder);
  } catch (err) {
    toast(`Failed: ${err.message}`, true);
  }
}

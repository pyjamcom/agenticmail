// Single-message detail view, opened when the user clicks a list row.
import { state } from './state.js';
import { escapeHtml, stripHtml, toast } from './utils.js';
import { formatDateFull } from './time.js';
import { renderMarkdown } from './markdown.js';
import { avatarHtml } from './avatar.js';
import { apiGet, apiPost, apiDelete, downloadAttachment } from './api.js';
import { openReply } from './compose.js';
import { loadList } from './list-view.js';
import { icon } from './icons.js';
import { confirmModal } from './modal.js';

/**
 * Render the per-message toolbar based on which folder the operator
 * is viewing the message in. The default (Inbox / Sent / Starred /
 * Drafts / All) shows the Gmail-style row: Reply, Reply all, Archive,
 * Mark unread, Report spam, Delete (= move to Trash).
 *
 * Three folders override that row because the default actions don't
 * make sense once the message is already at its destination:
 *
 *   - **Archive**: replace Archive with **Move to Inbox** (unarchive).
 *     Spam + Delete still apply.
 *   - **Spam**:    replace Report-spam with **Not spam** (move to Inbox).
 *     The Archive action is hidden — moving spam to Archive bypasses
 *     the regular spam-train workflow; if the operator decides it's
 *     not spam, they want it in Inbox.
 *   - **Trash**:   replace Archive with **Restore** (move to Inbox).
 *     Report-spam is hidden — moving trash to Spam is a confusing
 *     no-op (it's already deleted). Delete now means "delete forever"
 *     and gets a red title; deleteMessage() already detects the trash
 *     folder and switches to permanent expunge.
 *
 * Reply / Reply-all stay visible everywhere because operators
 * legitimately reply to messages they've already archived or
 * triaged into spam.
 */
function renderToolbar(folder) {
  const isArchive = folder === 'archive';
  const isSpam    = folder === 'spam';
  const isTrash   = folder === 'trash';

  const buttons = [
    `<button class="icon-btn" id="msg-back" title="Back to list">${icon('back')}</button>`,
    `<button class="icon-btn" id="msg-reply" title="Reply">${icon('reply')}</button>`,
    `<button class="icon-btn" id="msg-reply-all" title="Reply all">${icon('replyAll')}</button>`,
  ];

  if (isArchive) {
    buttons.push(`<button class="icon-btn" id="msg-unarchive" title="Move to Inbox">${icon('inbox')}</button>`);
  } else if (isTrash) {
    buttons.push(`<button class="icon-btn" id="msg-restore" title="Restore to Inbox">${icon('inbox')}</button>`);
  } else if (isSpam) {
    buttons.push(`<button class="icon-btn" id="msg-not-spam" title="Not spam — move to Inbox">${icon('inbox')}</button>`);
  } else {
    buttons.push(`<button class="icon-btn" id="msg-archive" title="Archive">${icon('archive')}</button>`);
  }

  buttons.push(`<button class="icon-btn" id="msg-unread" title="Mark unread">${icon('mailUnread')}</button>`);

  if (!isSpam && !isTrash) {
    buttons.push(`<button class="icon-btn" id="msg-spam" title="Report spam">${icon('spam')}</button>`);
  }

  buttons.push(
    `<button class="icon-btn" id="msg-delete" title="${isTrash ? 'Delete forever' : 'Delete'}">${icon('trash')}</button>`
  );

  return `<div class="message-toolbar">${buttons.join('\n      ')}<div class="toolbar-spacer"></div></div>`;
}

/**
 * Attach a click handler to a toolbar button if (and only if) the
 * button is currently rendered. Folder-aware toolbars elide some
 * buttons; calling `addEventListener` on a missing element would
 * throw and abort the rest of the wiring.
 */
function bindIf(id, handler) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', handler);
}

export async function openMessage(uid) {
  if (!state.selectedAgent) return;
  state.selectedUid = uid;
  const folder = state.selectedFolder ?? 'inbox';
  const root = document.getElementById('content');
  root.innerHTML = `
    ${renderToolbar(folder)}
    <div class="message-view"><div class="empty">Loading…</div></div>
  `;
  bindIf('msg-back',      () => { location.hash = `#/folder/${folder}`; });
  bindIf('msg-reply',     () => openReply(false));
  bindIf('msg-reply-all', () => openReply(true));
  bindIf('msg-archive',   () => archiveMessage());
  bindIf('msg-unarchive', () => moveToInbox('unarchive'));
  bindIf('msg-restore',   () => moveToInbox('restore'));
  bindIf('msg-not-spam',  () => moveToInbox('not-spam'));
  bindIf('msg-unread',    () => markUnread());
  bindIf('msg-spam',      () => markSpam());
  bindIf('msg-delete',    () => deleteMessage());

  try {
    // Pass the current folder so the API fetches from the right
    // mailbox — Spam / Archive / Trash UIDs don't exist in INBOX,
    // and the API defaults `folder` to INBOX when omitted. Without
    // this, opening a message from any non-Inbox folder 404'd
    // with `MESSAGE_NOT_FOUND` because UID N existed in (say) Junk
    // Mail but the API looked in INBOX.
    //
    // We resolve the IMAP folder name via state.folderNames (the
    // map populated by /mail/folders auto-discovery) so renames
    // like Stalwart's "Junk Mail" vs "Spam" are handled in one
    // place. "inbox" maps to "INBOX" by convention.
    const imap = state.folderNames?.[state.selectedFolder] ?? 'INBOX';
    const qs = imap && imap !== 'INBOX' ? `?folder=${encodeURIComponent(imap)}` : '';
    const msg = await apiGet(`/mail/messages/${uid}${qs}`, { agentKey: state.selectedAgent.apiKey });
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
  const senderPseudo = { name: fromName };  // for avatar generation
  const bodyText = msg.text ?? stripHtml(msg.html ?? '');

  // Build separate To / Cc / Bcc lines so the user can actually
  // tell who was on the action list vs CC'd for awareness. The
  // previous renderer concatenated everything onto one "to" line.
  const formatAddr = (a) => a?.name && a.name !== a.address
    ? `${a.name} <${a.address}>`
    : (a?.address ?? '');
  const renderAddrRow = (label, list, cls) => {
    if (!Array.isArray(list) || list.length === 0) return '';
    const rendered = list.map(formatAddr).filter(Boolean).map(escapeHtml).join(', ');
    if (!rendered) return '';
    return `<div class="message-recipient-row ${cls}"><span class="message-recipient-label">${label}</span><span class="message-recipient-list">${rendered}</span></div>`;
  };

  const attachmentsHtml = (msg.attachments ?? []).length > 0
    ? `<div class="message-attachments">${msg.attachments.map((a, i) =>
        `<button class="message-attachment" data-att-index="${i}" data-att-filename="${escapeHtml(a.filename ?? 'attachment')}" title="Click to download">
          <span class="att-icon">${icon('attachment', { size: 18 })}</span>
          <span class="att-name">${escapeHtml(a.filename ?? '(unnamed)')}</span>
          ${a.size ? `<span class="att-size">${formatBytes(a.size)}</span>` : ''}
        </button>`
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
          ${renderAddrRow('To', msg.to, 'message-to')}
          ${renderAddrRow('Cc', msg.cc, 'message-cc')}
          ${renderAddrRow('Bcc', msg.bcc, 'message-bcc')}
        </div>
        <div class="message-date">${escapeHtml(formatDateFull(msg.date))}</div>
      </div>
    </div>
    <div class="message-body">${renderBodyWithThreading(bodyText)}</div>
    ${attachmentsHtml}
  `;

  // Wire attachment download clicks. Browsers don't pass our auth
  // header on a plain <a href>, so we fetch+blob+synthesise the
  // click in api.js → downloadAttachment.
  view.querySelectorAll('.message-attachment').forEach((el) => {
    el.addEventListener('click', async () => {
      const idx = Number(el.dataset.attIndex);
      const filename = el.dataset.attFilename;
      el.classList.add('downloading');
      try {
        await downloadAttachment(state.selectedUid, idx, filename, { agentKey: state.selectedAgent.apiKey });
      } catch (err) {
        toast(`Download failed: ${err.message}`, true);
      } finally {
        el.classList.remove('downloading');
      }
    });
  });
}

/** Pretty-print byte counts (KB / MB) for attachment size display. */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Render a message body with proper email-thread chrome around
 * quoted replies.
 *
 * Most clients (including ours, via `openReply` in compose.js)
 * prefix a quoted-reply block with the canonical header line:
 *
 *   On 2026-05-13T22:50:24.000Z, claudecode@localhost wrote:
 *   > original body line 1
 *   > original body line 2
 *
 * Rendered with our plain markdown that becomes raw text + a
 * blockquote of `>` lines — visible but ugly: ISO timestamp, no
 * avatar, no nice formatting. This function detects the pattern,
 * extracts (date, sender, quoted body), and renders each quoted
 * chunk as a styled "thread-quote" card with the right chrome:
 * sender avatar, name, friendly date, and the quoted body
 * recursively threaded (for replies-to-replies).
 *
 * Non-matching prose flows through untouched via `renderMarkdown`.
 */
function renderBodyWithThreading(src) {
  if (!src) return '<div class="empty">(no body)</div>';
  const lines = src.split('\n');
  const out = [];
  let prose = [];
  let i = 0;

  const flushProse = () => {
    if (prose.length === 0) return;
    out.push(renderMarkdown(prose.join('\n')));
    prose = [];
  };

  // Header pattern: `On <date>, <addr> wrote:` with optional
  // angle-bracket form `<addr@host>`. Date is anything up to the
  // comma; addr is anything not whitespace + an @.
  const headerRe = /^On (.+?), <?([^\s<>]+@[^\s<>]+)>? wrote:\s*$/;
  // Optional follow-up address lines emitted by AgenticMail's
  // reply builders: `To: a@x, b@y` / `Cc: …` / `Bcc: …`. These
  // sit between the `wrote:` line and the first `> ` quoted body
  // line; the parser collects them so the rendered thread-quote
  // header can show the previous round's full audience, not just
  // the sender. Optional — older replies (pre-0.9.32) won't have
  // them and degrade to sender-only.
  const audienceRe = /^(To|Cc|Bcc):\s*(.+)$/i;

  while (i < lines.length) {
    const m = lines[i].match(headerRe);
    if (!m) {
      prose.push(lines[i]);
      i++;
      continue;
    }
    flushProse();
    const dateRaw = m[1];
    const sender = m[2];
    i++;
    // Collect optional audience lines (To/Cc/Bcc) immediately
    // after the wrote: header. Stop at the first line that
    // doesn't match; non-matching content falls through to the
    // body-quote collection loop below.
    let toAddrs = '';
    let ccAddrs = '';
    let bccAddrs = '';
    while (i < lines.length) {
      const a = lines[i].match(audienceRe);
      if (!a) break;
      const field = a[1].toLowerCase();
      const value = a[2].trim();
      if (field === 'to') toAddrs = value;
      else if (field === 'cc') ccAddrs = value;
      else if (field === 'bcc') bccAddrs = value;
      i++;
    }
    // Collect contiguous `>` lines (with possible blank-line gaps
    // inside the quote, which most clients tolerate). Stop at the
    // first non-quote, non-blank line.
    const quoted = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.startsWith('>')) { quoted.push(l.replace(/^>\s?/, '')); i++; continue; }
      if (l.trim() === '') {
        // Peek ahead — if the next non-blank is another `>`, the
        // blank line is part of the quote; otherwise we're done.
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j++;
        if (j < lines.length && lines[j].startsWith('>')) { quoted.push(''); i++; continue; }
      }
      break;
    }
    out.push(renderThreadQuote(dateRaw, sender, quoted.join('\n'), { to: toAddrs, cc: ccAddrs, bcc: bccAddrs }));
  }
  flushProse();
  return out.join('');
}

function renderThreadQuote(dateRaw, sender, quotedBody, audience = {}) {
  // Try to format the ISO date through the same helper the
  // message header uses; fall back to the raw string on parse fail.
  const friendlyDate = (() => {
    const d = new Date(dateRaw);
    if (!Number.isNaN(d.getTime())) return formatDateFull(d.toISOString());
    return dateRaw;
  })();
  const sub = renderBodyWithThreading(quotedBody);  // recurse for nested threads
  // Render the optional audience lines (To/Cc/Bcc) inside the
  // thread-quote header so the reader can see who was on the
  // previous round. Missing values are simply omitted — a quote
  // from an older email that didn't include them degrades cleanly
  // to the sender + date line.
  const audienceRow = (label, value) => value
    ? `<div class="thread-quote-audience-row"><span class="thread-quote-audience-label">${label}:</span> <span class="thread-quote-audience-value">${escapeHtml(value)}</span></div>`
    : '';
  const audienceBlock = (audience.to || audience.cc || audience.bcc)
    ? `<div class="thread-quote-audience">${audienceRow('To', audience.to)}${audienceRow('Cc', audience.cc)}${audienceRow('Bcc', audience.bcc)}</div>`
    : '';
  return `
    <div class="thread-quote">
      <div class="thread-quote-head">
        ${avatarHtml({ name: sender }, 'avatar-sm')}
        <span class="thread-quote-from">${escapeHtml(sender)}</span>
        <span class="thread-quote-dot">·</span>
        <span class="thread-quote-date">${escapeHtml(friendlyDate)}</span>
      </div>
      ${audienceBlock}
      <div class="thread-quote-body">${sub}</div>
    </div>
  `;
}

/**
 * Move the open message back to INBOX from Archive / Spam / Trash.
 * Three triggers:
 *
 *   - 'unarchive' (from Archive): generic move via /mail/messages/:uid/move
 *   - 'not-spam'  (from Spam):    /mail/messages/:uid/not-spam (server-side
 *                                  also clears the spam-train flag)
 *   - 'restore'   (from Trash):   generic move via /mail/messages/:uid/move
 *
 * All three navigate back to the originating folder list afterwards so
 * the operator sees the row vanish from the view they triggered the
 * action from. The list refresh is what makes the affordance feel real.
 */
async function moveToInbox(reason) {
  if (!state.currentMessage || !state.selectedAgent) return;
  try {
    const imap = state.folderNames?.[state.selectedFolder] ?? 'INBOX';
    if (reason === 'not-spam') {
      await apiPost(`/mail/messages/${state.selectedUid}/not-spam`, {}, { agentKey: state.selectedAgent.apiKey });
      toast('Marked as not spam.');
    } else {
      await apiPost(`/mail/messages/${state.selectedUid}/move`, { from: imap, to: 'INBOX' }, { agentKey: state.selectedAgent.apiKey });
      toast(reason === 'restore' ? 'Restored to Inbox.' : 'Moved to Inbox.');
    }
    location.hash = `#/folder/${state.selectedFolder ?? 'inbox'}`;
    await loadList(state.selectedAgent, state.selectedFolder);
  } catch (err) {
    toast(`Move failed: ${err.message}`, true);
  }
}

async function markUnread() {
  if (!state.currentMessage || !state.selectedAgent) return;
  try {
    const imap = state.folderNames?.[state.selectedFolder] ?? 'INBOX';
    await apiPost(`/mail/messages/${state.selectedUid}/unseen`, { folder: imap }, { agentKey: state.selectedAgent.apiKey });
    toast('Marked unread.');
    location.hash = `#/folder/${state.selectedFolder ?? 'inbox'}`;
    await loadList(state.selectedAgent, state.selectedFolder);
  } catch (err) {
    toast(`Failed: ${err.message}`, true);
  }
}

/**
 * Move the open message to the Junk Mail folder (IMAP). The API
 * route is POST /mail/messages/:uid/spam — it does the move +
 * flags the message so future scans treat it as known spam.
 */
/**
 * Archive the open message — move it to the Archive folder.
 * No confirm dialog; archive is non-destructive (Gmail UX) so
 * the user can always go to Archive and move things back.
 */
async function archiveMessage() {
  if (!state.currentMessage || !state.selectedAgent) return;
  try {
    const imap = state.folderNames?.[state.selectedFolder] ?? 'INBOX';
    await apiPost(`/mail/messages/${state.selectedUid}/archive`, { folder: imap }, { agentKey: state.selectedAgent.apiKey });
    toast('Archived.');
    location.hash = `#/folder/${state.selectedFolder ?? 'inbox'}`;
    await loadList(state.selectedAgent, state.selectedFolder);
  } catch (err) {
    toast(`Archive failed: ${err.message}`, true);
  }
}

async function markSpam() {
  if (!state.currentMessage || !state.selectedAgent) return;
  const ok = await confirmModal({
    title: 'Report this message as spam?',
    body: 'It will be moved to the Junk folder and used to train the spam filter.',
    confirm: 'Report spam',
    danger: true,
  });
  if (!ok) return;
  try {
    const imap = state.folderNames?.[state.selectedFolder] ?? 'INBOX';
    await apiPost(`/mail/messages/${state.selectedUid}/spam`, { folder: imap }, { agentKey: state.selectedAgent.apiKey });
    toast('Reported as spam.');
    location.hash = `#/folder/${state.selectedFolder ?? 'inbox'}`;
    await loadList(state.selectedAgent, state.selectedFolder);
  } catch (err) {
    toast(`Spam failed: ${err.message}`, true);
  }
}

/**
 * Delete the open message. DELETE /mail/messages/:uid moves it
 * to the IMAP \Deleted state (Stalwart auto-expunges on server
 * config, otherwise it stays in Trash). Confirm before firing
 * since this is destructive.
 */
async function deleteMessage() {
  if (!state.currentMessage || !state.selectedAgent) return;
  const subject = state.currentMessage.subject ?? '(no subject)';
  // From Trash, delete is permanent (no further fallback). From
  // every other folder it's a move-to-trash, recoverable.
  const isTrash = state.selectedFolder === 'trash';
  const ok = await confirmModal({
    title: isTrash ? 'Delete this message forever?' : 'Delete this message?',
    body: isTrash
      ? `"${subject}" will be permanently removed. This can't be undone.`
      : `"${subject}" will be moved to Trash. You can recover it from there.`,
    confirm: isTrash ? 'Delete forever' : 'Move to Trash',
    danger: true,
  });
  if (!ok) return;
  try {
    // Pass the real IMAP folder name + permanent flag. The API
    // uses the folder for the IMAP source mailbox and decides
    // move-to-trash vs expunge based on `permanent`.
    const imap = state.folderNames?.[state.selectedFolder] ?? 'INBOX';
    const qs = `?folder=${encodeURIComponent(imap)}${isTrash ? '&permanent=true' : ''}`;
    await apiDelete(`/mail/messages/${state.selectedUid}${qs}`, { agentKey: state.selectedAgent.apiKey });
    toast('Deleted.');
    location.hash = `#/folder/${state.selectedFolder ?? 'inbox'}`;
    await loadList(state.selectedAgent, state.selectedFolder);
  } catch (err) {
    toast(`Delete failed: ${err.message}`, true);
  }
}

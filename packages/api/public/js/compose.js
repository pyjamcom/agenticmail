// Gmail-style bottom-right compose popup. Handles both new-message
// and reply flows. `wake` is the AgenticMail selective-wake hint.
//
// Draft autosave: every keystroke on the to / cc / subject / body
// fields schedules a 2s-debounced save to `/drafts`. First save
// POSTs and stores the returned id; subsequent saves PUT to that
// id. On Send, the draft (if any) is deleted after the send
// succeeds — otherwise it stays around so the user can find it
// in the Drafts folder.
import { state } from './state.js';
import { escapeHtml, toast } from './utils.js';
import { apiGet, apiPost, apiPut, apiDelete } from './api.js';
import { loadList } from './list-view.js';

const AUTOSAVE_DEBOUNCE_MS = 2000;
let autosaveTimer = null;
let autosaveInFlight = false;

/**
 * In-memory attachment buffer for the current compose. Each entry
 * is `{ filename, contentType, content (base64), encoding }` —
 * the same shape the API's `/mail/send` accepts. We don't persist
 * attachments to the draft store (the drafts table doesn't have
 * a binary column); a draft round-trip loses them by design.
 */
let pendingAttachments = [];

export function populateComposeFrom() {
  const sel = document.getElementById('compose-from');
  sel.innerHTML = state.agents
    .map(a => `<option value="${a.id}">${escapeHtml(a.name)} &lt;${escapeHtml(a.email)}&gt;</option>`)
    .join('');
}

export function openCompose() {
  state.composeReplyContext = null;
  state.composeDraftId = null;
  pendingAttachments = [];
  document.getElementById('compose-title').textContent = 'New message';
  if (state.selectedAgent) document.getElementById('compose-from').value = state.selectedAgent.id;
  ['compose-to', 'compose-cc', 'compose-wake', 'compose-subject', 'compose-body']
    .forEach(id => { document.getElementById(id).value = ''; });
  renderAttachmentChips();
  setComposeStatus('');
  showModal();
  wireAutosave();
  wireAttachmentPicker();
  setTimeout(() => document.getElementById('compose-to').focus(), 50);
}

export function openReply(replyAll) {
  if (!state.currentMessage) return;
  const msg = state.currentMessage;
  state.composeReplyContext = { uid: msg.uid, agent: state.selectedAgent, replyAll };
  state.composeDraftId = null;
  document.getElementById('compose-title').textContent =
    `Reply${replyAll ? ' all' : ''}: ${msg.subject ?? '(no subject)'}`;
  document.getElementById('compose-from').value = state.selectedAgent.id;
  const fromAddr = msg.from?.[0]?.address ?? '';
  let toAddr = fromAddr;
  if (replyAll) {
    const all = [fromAddr, ...(msg.to ?? []).map(a => a.address), ...(msg.cc ?? []).map(a => a.address)]
      .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i)
      .filter(addr => addr !== state.selectedAgent.email);
    toAddr = all.join(', ');
  }
  document.getElementById('compose-to').value = toAddr;
  document.getElementById('compose-cc').value = '';
  document.getElementById('compose-wake').value = '';
  document.getElementById('compose-subject').value =
    (msg.subject ?? '').startsWith('Re:') ? msg.subject : `Re: ${msg.subject ?? ''}`;
  const quoted = (msg.text ?? '').split('\n').map(l => `> ${l}`).join('\n');
  const stub = `\n\nOn ${msg.date}, ${fromAddr} wrote:\n${quoted}`;
  document.getElementById('compose-body').value = stub;
  pendingAttachments = [];
  renderAttachmentChips();
  setComposeStatus('');
  showModal();
  wireAutosave();
  wireAttachmentPicker();
  setTimeout(() => document.getElementById('compose-body').focus(), 50);
}

/**
 * Open an existing autosaved draft for further editing. Pulls the
 * SQL row, populates every field, and arms `composeDraftId` so
 * subsequent autosaves PUT to the same row instead of creating a
 * second draft. The user can resume right where they left off.
 */
export async function openDraft(draftId) {
  state.composeReplyContext = null;
  state.composeDraftId = draftId;
  pendingAttachments = [];
  document.getElementById('compose-title').textContent = 'Draft';
  if (state.selectedAgent) document.getElementById('compose-from').value = state.selectedAgent.id;
  // Clear first so we don't leak data from a previous compose if
  // the fetch fails halfway.
  ['compose-to', 'compose-cc', 'compose-wake', 'compose-subject', 'compose-body']
    .forEach(id => { document.getElementById(id).value = ''; });
  setComposeStatus('Loading…');
  showModal();
  wireAutosave();
  wireAttachmentPicker();
  try {
    // Use the single-draft endpoint, which returns attachment
    // content in full (the list endpoint only sends metadata to
    // keep the sidebar payload small).
    const draft = await apiGet(`/drafts/${encodeURIComponent(draftId)}`, { agentKey: state.selectedAgent.apiKey });
    if (!draft) throw new Error('Draft not found');
    document.getElementById('compose-to').value = draft.to_addr ?? '';
    document.getElementById('compose-cc').value = draft.cc ?? '';
    document.getElementById('compose-subject').value = draft.subject ?? '';
    document.getElementById('compose-body').value = draft.text_body ?? '';
    document.getElementById('compose-title').textContent =
      `Draft: ${draft.subject || '(no subject)'}`;
    // Rehydrate attachment chips with the persisted blobs. Map
    // the server-side `size` field back into the in-memory
    // `sizeBytes` alias the rest of the compose code uses for
    // the UI-side 20 MB cap.
    pendingAttachments = Array.isArray(draft.attachments)
      ? draft.attachments.map(a => ({
          filename: a.filename,
          contentType: a.contentType,
          content: a.content,
          encoding: 'base64',
          sizeBytes: typeof a.size === 'number' ? a.size : 0,
        }))
      : [];
    renderAttachmentChips();
    setComposeStatus('Loaded from Drafts');
    setTimeout(() => document.getElementById('compose-body').focus(), 50);
  } catch (err) {
    setComposeStatus(`Couldn't load draft: ${err.message}`);
  }
}

export function closeCompose() {
  document.getElementById('compose-bg').style.display = 'none';
  // Flush a final save synchronously-ish on close so a quick
  // "type → close" doesn't lose work. We only fire if there's a
  // pending debounce — if the user already saved or never typed,
  // skip the network call.
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
    void runAutosave();
  }
}

/**
 * Discard the in-progress compose — delete the autosaved draft
 * (if any) and close the modal. Distinct from `closeCompose`
 * which just hides the modal and lets the draft persist for
 * later resumption from the Drafts folder. Bound to the
 * "Discard" button in the compose footer.
 */
export async function discardCompose() {
  // Cancel any pending autosave so it doesn't race the delete.
  if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
  const draftId = state.composeDraftId;
  const agent = state.agents.find(a => a.id === document.getElementById('compose-from').value) ?? state.selectedAgent;
  // Close UI first so the user gets immediate feedback even if
  // the delete is slow / fails.
  document.getElementById('compose-bg').style.display = 'none';
  state.composeDraftId = null;
  pendingAttachments = [];
  if (draftId && agent) {
    try { await apiDelete(`/drafts/${draftId}`, { agentKey: agent.apiKey }); }
    catch { /* draft already gone or transient failure — fine */ }
    // If the user is currently looking at the Drafts list, refresh
    // so the deleted draft disappears from the visible rows.
    if (state.selectedAgent && state.selectedFolder === 'drafts') {
      try { await loadList(state.selectedAgent, 'drafts'); } catch { /* ignore */ }
    }
  }
}

function showModal() {
  document.getElementById('compose-bg').style.display = 'flex';
}

/**
 * Build the field set the drafts API expects from current modal
 * state. Returns null when the draft is empty (no point persisting
 * a blank shell).
 */
function readComposeFields() {
  const to = document.getElementById('compose-to').value.trim();
  const subject = document.getElementById('compose-subject').value.trim();
  const text = document.getElementById('compose-body').value;
  const cc = document.getElementById('compose-cc').value.trim();
  if (!to && !subject && !text.trim() && !cc && pendingAttachments.length === 0) return null;
  // The API expects `{ filename, contentType, content (base64),
  // size }` per attachment. Drop the local-only sizeBytes alias
  // and the redundant encoding field — the server defaults to
  // base64 anyway.
  const attachments = pendingAttachments.map(a => ({
    filename: a.filename,
    contentType: a.contentType,
    content: a.content,
    size: a.sizeBytes,
  }));
  return {
    to: to || null,
    subject: subject || null,
    text: text || null,
    cc: cc || null,
    // Always send `attachments` (even empty) so the server clears
    // the stored blob when the user removes every chip. The PUT
    // route uses `hasOwnProperty('attachments')` to distinguish
    // "leave alone" from "set to empty".
    attachments,
  };
}

/**
 * Wire the autosave debounce to every input/textarea in the modal.
 * Re-wires on every open() so removed/replaced DOM nodes don't
 * accumulate listeners.
 */
function wireAutosave() {
  ['compose-to', 'compose-cc', 'compose-subject', 'compose-body'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    // Marker prevents double-binding.
    if (el._autosaveBound) return;
    el._autosaveBound = true;
    el.addEventListener('input', scheduleAutosave);
  });
}

function scheduleAutosave() {
  setComposeStatus('Saving…');
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(runAutosave, AUTOSAVE_DEBOUNCE_MS);
}

async function runAutosave() {
  autosaveTimer = null;
  if (autosaveInFlight) {
    // Coalesce: re-schedule one more pass after the current
    // request lands so we don't lose the latest keystroke.
    autosaveTimer = setTimeout(runAutosave, AUTOSAVE_DEBOUNCE_MS);
    return;
  }
  const fields = readComposeFields();
  if (!fields) { setComposeStatus(''); return; }
  const agentId = document.getElementById('compose-from').value;
  const agent = state.agents.find(a => a.id === agentId) ?? state.selectedAgent;
  if (!agent) return;
  autosaveInFlight = true;
  try {
    if (state.composeDraftId) {
      await apiPut(`/drafts/${state.composeDraftId}`, fields, { agentKey: agent.apiKey });
    } else {
      const r = await apiPost('/drafts', fields, { agentKey: agent.apiKey });
      state.composeDraftId = r?.id ?? null;
    }
    setComposeStatus('Saved to Drafts');
  } catch (err) {
    setComposeStatus(`Save failed: ${err.message}`);
  } finally {
    autosaveInFlight = false;
  }
}

function setComposeStatus(text) {
  const el = document.getElementById('compose-status');
  if (el) el.textContent = text;
}

/**
 * Wire the paperclip button + hidden file input. Reads files as
 * base64 (FileReader → ArrayBuffer → btoa) and appends them to
 * `pendingAttachments`. We cap total payload at 20 MB because
 * Stalwart's default SMTP message-size limit is in that range —
 * larger and the send would silently fail on the wire.
 */
const ATTACHMENT_TOTAL_CAP_BYTES = 20 * 1024 * 1024;

function wireAttachmentPicker() {
  const btn = document.getElementById('compose-attach-btn');
  const input = document.getElementById('compose-file-input');
  if (!btn || !input) return;
  if (btn._attachBound) return;
  btn._attachBound = true;
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const files = Array.from(input.files ?? []);
    input.value = '';  // allow re-picking the same file later
    for (const f of files) {
      const currentBytes = pendingAttachments.reduce((s, a) => s + a.sizeBytes, 0);
      if (currentBytes + f.size > ATTACHMENT_TOTAL_CAP_BYTES) {
        toast(`Skipped ${f.name}: total attachments would exceed 20 MB.`, true);
        continue;
      }
      try {
        const content = await fileToBase64(f);
        pendingAttachments.push({
          filename: f.name,
          contentType: f.type || 'application/octet-stream',
          content,
          encoding: 'base64',
          sizeBytes: f.size,
        });
      } catch (err) {
        toast(`Couldn't read ${f.name}: ${err.message}`, true);
      }
    }
    renderAttachmentChips();
    // Persist the new attachments to the draft so a "close and
    // reopen" round-trip keeps them. Without this, attachments
    // only ever lived in memory until the user typed in another
    // field and triggered autosave organically.
    scheduleAutosave();
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // result is `data:<mime>;base64,<payload>` — strip the prefix.
      const r = String(reader.result ?? '');
      const i = r.indexOf(',');
      resolve(i >= 0 ? r.slice(i + 1) : r);
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

function renderAttachmentChips() {
  const root = document.getElementById('compose-attachments');
  if (!root) return;
  if (pendingAttachments.length === 0) { root.innerHTML = ''; return; }
  root.innerHTML = pendingAttachments.map((a, i) => `
    <span class="attachment-chip" data-att-index="${i}">
      <span class="chip-name" title="${escapeHtml(a.filename)}">${escapeHtml(a.filename)}</span>
      <span class="chip-size">${formatBytes(a.sizeBytes)}</span>
      <button class="chip-remove" data-att-remove="${i}" title="Remove">×</button>
    </span>
  `).join('');
  root.querySelectorAll('[data-att-remove]').forEach(el => {
    el.addEventListener('click', () => {
      pendingAttachments.splice(Number(el.dataset.attRemove), 1);
      renderAttachmentChips();
      // Same reason as the picker: removing a chip needs to
      // persist or the draft round-trip will resurrect the file.
      scheduleAutosave();
    });
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function sendCompose() {
  const agentId = document.getElementById('compose-from').value;
  const agent = state.agents.find(a => a.id === agentId);
  if (!agent) return toast('Pick an agent to send from.', true);
  const to = document.getElementById('compose-to').value.trim();
  const subject = document.getElementById('compose-subject').value.trim();
  const text = document.getElementById('compose-body').value;
  const cc = document.getElementById('compose-cc').value.trim();
  const wakeRaw = document.getElementById('compose-wake').value.trim();
  if (!to || !subject) return toast('To and Subject are required.', true);
  const body = { to, subject, text };
  if (cc) body.cc = cc;
  if (wakeRaw) body.wake = wakeRaw.split(',').map(s => s.trim()).filter(Boolean);
  if (pendingAttachments.length > 0) {
    // Strip the local-only `sizeBytes` field — the API expects
    // only filename/contentType/content/encoding. Keeping the
    // extra field works (it's ignored) but is noise on the wire.
    body.attachments = pendingAttachments.map(a => ({
      filename: a.filename,
      contentType: a.contentType,
      content: a.content,
      encoding: a.encoding,
    }));
  }
  try {
    await apiPost('/mail/send', body, { agentKey: agent.apiKey });
    // Clean up the autosaved draft (if any) — the message is in
    // the real Sent folder now, no need to keep a Drafts entry.
    if (state.composeDraftId) {
      try { await apiDelete(`/drafts/${state.composeDraftId}`, { agentKey: agent.apiKey }); } catch { /* ignore */ }
      state.composeDraftId = null;
    }
    pendingAttachments = [];
    closeCompose();
    toast('Sent.');
    if (state.selectedAgent?.id === agent.id) await loadList(agent, state.selectedFolder);
  } catch (err) {
    toast(`Send failed: ${err.message}`, true);
  }
}

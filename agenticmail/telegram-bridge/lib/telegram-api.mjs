/**
 * Telegram Bot API helpers shared across the bridge and the telegram-mcp
 * stdio server. Adapted from enterprise/src/agent-tools/tools/messaging/telegram.ts.
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { mkdirSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { TELEGRAM_MEDIA_DIR } from './paths.mjs';

/**
 * Telegram Bot API base URL.
 * Uses local Bot API server (no file size limits) if running, falls back to official.
 */
const LOCAL_API = 'http://localhost:8081';
const OFFICIAL_API = 'https://api.telegram.org';

async function getApiBase() {
  try {
    const r = await fetch(`${LOCAL_API}/`, { signal: AbortSignal.timeout(1000) });
    return LOCAL_API; // local server is up
  } catch {
    return OFFICIAL_API; // fall back to official
  }
}

// Cache the base URL (re-check every 60s)
let _apiBase = null;
let _apiBaseTs = 0;
async function apiBase() {
  if (_apiBase && Date.now() - _apiBaseTs < 60000) return _apiBase;
  _apiBase = await getApiBase();
  _apiBaseTs = Date.now();
  return _apiBase;
}

/**
 * POST to a Telegram Bot API method with JSON body.
 * Long-polling automatically gets a longer HTTP timeout than the poll window.
 */
export async function tgApi(token, method, body, { longPoll = false } = {}) {
  const base = await apiBase();
  const timeoutMs = longPoll && body?.timeout ? (body.timeout + 15) * 1000 : 30000;
  const opts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${base}/bot${token}/${method}`, opts);
  const json = await r.json();
  if (!json.ok) throw new Error(`${method}: ${json.description || 'Telegram API error'}`);
  return json.result;
}

/**
 * Multipart upload for sendPhoto/sendVideo/sendDocument.
 */
export async function tgUpload(token, method, chatId, fieldName, filePath, extra) {
  const base = await apiBase();
  const buf = await readFile(filePath);
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append(fieldName, new Blob([buf]), basename(filePath));
  if (extra) {
    for (const [k, v] of Object.entries(extra)) form.append(k, String(v));
  }
  const r = await fetch(`${base}/bot${token}/${method}`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(120000), // 2 min for large files
  });
  const json = await r.json();
  if (!json.ok) throw new Error(`${method}: ${json.description || 'Telegram upload error'}`);
  return json.result;
}

/**
 * Strip markdown — Telegram plain-text messages look better without it,
 * and we bypass Markdown parse_mode entirely to avoid formatting collisions.
 */
export function stripMarkdown(text) {
  if (!text) return text;
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/```[\s\S]*?```/g, m => m.replace(/```\w*\n?/g, '').trim())
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();
}

/**
 * Send a message to a Telegram chat. Auto-splits messages over the 4096
 * character limit at newline boundaries when possible.
 */
export async function sendMessage(token, chatId, text, { replyToMessageId } = {}) {
  const clean = stripMarkdown(text);
  const chunks = splitIntoChunks(clean, 4000);
  let lastMessageId;
  for (let i = 0; i < chunks.length; i++) {
    const body = { chat_id: chatId, text: chunks[i] };
    if (i === 0 && replyToMessageId) {
      body.reply_parameters = { message_id: replyToMessageId };
    }
    const r = await tgApi(token, 'sendMessage', body);
    lastMessageId = r.message_id;
  }
  return lastMessageId;
}

function splitIntoChunks(text, maxLen) {
  const chunks = [];
  let rest = text || '';
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('\n', maxLen);
    if (cut < maxLen / 2) cut = maxLen;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export async function sendChatAction(token, chatId, action = 'typing') {
  try {
    await tgApi(token, 'sendChatAction', { chat_id: chatId, action });
  } catch {
    // sending action is best-effort
  }
}

/**
 * Download a file referenced by a Telegram file_id. Returns local path.
 */
export async function downloadMedia(token, fileId, preferredName, logFn = () => {}) {
  try {
    const fileMeta = await tgApi(token, 'getFile', { file_id: fileId });
    if (!fileMeta.file_path) return null;

    mkdirSync(TELEGRAM_MEDIA_DIR, { recursive: true });
    const ext = fileMeta.file_path.split('.').pop() || 'bin';
    const localName = preferredName || `tg-${Date.now()}.${ext}`;
    const localPath = join(TELEGRAM_MEDIA_DIR, localName);

    // Local Bot API server returns absolute file paths — just copy the file
    if (existsSync(fileMeta.file_path)) {
      copyFileSync(fileMeta.file_path, localPath);
      logFn(`copied local file: ${fileMeta.file_path}`);
      return localPath;
    }

    // Otherwise download via HTTP (official API or local server's /file/ endpoint)
    const base = await apiBase();
    const downloadUrl = `${base}/file/bot${token}/${fileMeta.file_path}`;
    const resp = await fetch(downloadUrl, { signal: AbortSignal.timeout(300000) }); // 5 min for large files
    if (!resp.ok) {
      logFn(`media download HTTP ${resp.status}`);
      return null;
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    writeFileSync(localPath, buffer);
    return localPath;
  } catch (err) {
    logFn(`downloadMedia error: ${err.message}`);
    return null;
  }
}

/**
 * Send a photo/video/document file from local disk.
 */
export async function sendMedia(token, chatId, filePath, { type, caption } = {}) {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const detectedType = type || (['mp4', 'mov', 'webm'].includes(ext)
    ? 'video'
    : ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)
      ? 'photo'
      : ['ogg', 'oga'].includes(ext)
        ? 'voice'
        : ['mp3', 'wav', 'flac', 'm4a', 'aac'].includes(ext)
          ? 'audio'
          : 'document');
  const methodMap = { photo: 'sendPhoto', video: 'sendVideo', voice: 'sendVoice', audio: 'sendAudio', document: 'sendDocument' };
  const fieldMap = { photo: 'photo', video: 'video', voice: 'voice', audio: 'audio', document: 'document' };
  const method = methodMap[detectedType] || 'sendDocument';
  const field = fieldMap[detectedType] || 'document';
  const extra = caption ? { caption: stripMarkdown(caption) } : undefined;
  const r = await tgUpload(token, method, chatId, field, filePath, extra);
  return { type: detectedType, messageId: r.message_id };
}

// ── Webhook mgmt ────────────────────────────────────────────────────────────

export async function setWebhook(token, url, { secretToken, dropPending = false } = {}) {
  return tgApi(token, 'setWebhook', {
    url,
    secret_token: secretToken,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: dropPending,
  });
}

export async function deleteWebhook(token) {
  return tgApi(token, 'deleteWebhook', {});
}

export async function getWebhookInfo(token) {
  return tgApi(token, 'getWebhookInfo');
}

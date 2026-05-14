import { ImapFlow } from 'imapflow';
import type { EmailEnvelope, MailboxInfo, SearchCriteria } from './types.js';

export interface MailReceiverOptions {
  host: string;
  port: number;
  email: string;
  password: string;
  secure?: boolean;
}

export class MailReceiver {
  private client: ImapFlow;
  private connected = false;

  constructor(private options: MailReceiverOptions) {
    this.client = new ImapFlow({
      host: options.host,
      port: options.port,
      secure: options.secure ?? false,
      auth: {
        user: options.email,
        pass: options.password,
      },
      logger: false,
      tls: {
        rejectUnauthorized: false,
      },
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect();
    this.connected = true;

    // Keep connected flag in sync with actual IMAP state
    this.client.on('close', () => { this.connected = false; });
    this.client.on('error', () => { this.connected = false; });
  }

  /** Check if the IMAP client is actually usable */
  get usable(): boolean {
    return this.connected && (this.client as any).usable !== false;
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.client.logout();
    this.connected = false;
  }

  async getMailboxInfo(mailbox = 'INBOX'): Promise<MailboxInfo> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      // NOOP forces the server to flush any pending untagged responses
      // (EXISTS, RECENT, EXPUNGE). Without this, `client.mailbox.exists` can
      // be stale for pooled receivers that don't run IDLE — e.g. a message
      // delivered between `getReceiver()` calls won't be visible until the
      // next SELECT. See receiver pool in packages/api/src/routes/mail.ts.
      try { await this.client.noop(); } catch { /* mailbox state best-effort */ }
      const status = this.client.mailbox;
      if (!status) {
        return { name: mailbox, exists: 0, recent: 0, unseen: 0 };
      }
      return {
        name: mailbox,
        exists: status.exists ?? 0,
        recent: (status as any).recent ?? 0,
        unseen: (status as any).unseen ?? 0,
      };
    } finally {
      lock.release();
    }
  }

  async listEnvelopes(mailbox = 'INBOX', options?: { limit?: number; offset?: number }): Promise<EmailEnvelope[]> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const envelopes: EmailEnvelope[] = [];
      const limit = Math.min(Math.max(options?.limit ?? 20, 1), 1000);
      const offset = Math.max(options?.offset ?? 0, 0);

      // Use UID-based search + sort for stable pagination that isn't
      // affected by message deletions between pages.
      //
      // NOTE: We deliberately do NOT early-return based on
      // `client.mailbox.exists`. That value is the cached count from the
      // last SELECT / EXISTS push, and for pooled receivers (no IDLE) it
      // can lag behind reality — causing `list_inbox` to return empty
      // immediately after `send_email` even though the message is in the
      // mailbox. SEARCH is authoritative; let it run.
      const allUids = await this.client.search({ all: true }, { uid: true });
      if (!allUids || allUids.length === 0) return envelopes;

      // Sort UIDs descending (highest UID = newest message)
      const sortedUids = Array.from(allUids).sort((a, b) => b - a);

      // Apply offset and limit
      const pageUids = sortedUids.slice(offset, offset + limit);
      if (pageUids.length === 0) return envelopes;

      // Fetch metadata for the selected UIDs
      const uidRange = pageUids.join(',');
      for await (const msg of this.client.fetch(uidRange, {
        uid: true,
        envelope: true,
        flags: true,
        size: true,
      })) {
        const env = msg.envelope;
        if (!env) continue;
        envelopes.push({
          uid: msg.uid,
          seq: msg.seq,
          messageId: env.messageId ?? '',
          subject: env.subject ?? '',
          from: (env.from ?? []).map((a: any) => ({
            name: a.name,
            address: a.address ?? '',
          })),
          to: (env.to ?? []).map((a: any) => ({
            name: a.name,
            address: a.address ?? '',
          })),
          date: env.date ?? new Date(),
          flags: msg.flags ?? new Set<string>(),
          size: msg.size ?? 0,
        });
      }

      // Sort by UID descending (newest first) since IMAP fetch order may vary
      envelopes.sort((a, b) => b.uid - a.uid);
      return envelopes;
    } finally {
      lock.release();
    }
  }

  async fetchMessage(uid: number, mailbox = 'INBOX'): Promise<Buffer> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const { content } = await this.client.download(String(uid), undefined, { uid: true });
      const chunks: Buffer[] = [];
      for await (const chunk of content) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } finally {
      lock.release();
    }
  }

  async search(criteria: SearchCriteria, mailbox = 'INBOX'): Promise<number[]> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const query: any = {};

      if (criteria.from) query.from = criteria.from;
      if (criteria.to) query.to = criteria.to;
      if (criteria.subject) query.subject = criteria.subject;
      if (criteria.since) query.since = criteria.since;
      if (criteria.before) query.before = criteria.before;
      if (criteria.seen !== undefined) query.seen = criteria.seen;
      if (criteria.text) query.body = criteria.text;

      const results = await this.client.search(query, { uid: true });
      return Array.isArray(results) ? results : [];
    } finally {
      lock.release();
    }
  }

  async markSeen(uid: number, mailbox = 'INBOX'): Promise<void> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      await this.client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    } finally {
      lock.release();
    }
  }

  /**
   * Permanently remove a single message via IMAP EXPUNGE.
   *
   * DANGEROUS — EXPUNGE is mailbox-wide. The IMAP semantics are:
   *
   *   1. STORE +FLAGS (\Deleted) on the target UID
   *   2. EXPUNGE → removes EVERY message in the mailbox that has
   *      \Deleted set, not just the one we just flagged
   *
   * If any other messages in the mailbox already had \Deleted
   * (from a previous half-completed delete, an agent operation,
   * an external client) they all vanish too. This is the IMAP
   * spec, not an ImapFlow quirk.
   *
   * Callers that just want "delete this email" — i.e. the Gmail
   * UX — should use `moveToTrash()` instead, which moves the
   * message to the trash mailbox without touching \Deleted.
   * Reserve `expungeMessage` for explicit "empty trash" /
   * permanent-delete UI paths.
   *
   * If the server supports UIDPLUS (RFC 4315), we use UID EXPUNGE
   * to limit the scope to the target UID — even then, callers
   * should treat this as the destructive option.
   */
  async expungeMessage(uid: number, mailbox = 'INBOX'): Promise<void> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      // Try UID EXPUNGE (RFC 4315) first — narrows scope to a
      // single UID instead of the mailbox-wide EXPUNGE that the
      // legacy IMAP4rev1 spec mandates. Falls through to
      // messageDelete if the server doesn't advertise UIDPLUS.
      const caps = (this.client as unknown as { capabilities?: Set<string> | string[] }).capabilities;
      const hasUidPlus = caps
        && (Array.isArray(caps) ? caps.includes('UIDPLUS') : caps.has('UIDPLUS'));
      if (hasUidPlus) {
        await this.client.messageFlagsAdd(String(uid), ['\\Deleted'], { uid: true });
        // ImapFlow doesn't expose UID EXPUNGE directly; run it raw.
        const exec = (this.client as unknown as { exec?: (cmd: string, args?: string[]) => Promise<unknown> }).exec;
        if (typeof exec === 'function') {
          await exec.call(this.client, 'UID EXPUNGE', [String(uid)]);
          return;
        }
      }
      // Fallback: mailbox-wide EXPUNGE via messageDelete.
      await this.client.messageDelete(String(uid), { uid: true });
    } finally {
      lock.release();
    }
  }

  /**
   * Move a single message to the trash mailbox.
   *
   * This is the Gmail / Outlook "delete" semantics — the user
   * still sees the message under Trash and can restore it. No
   * \Deleted flag is set, no EXPUNGE happens, so other messages
   * in the source mailbox are untouched.
   *
   * `trashMailbox` is the IMAP folder name (varies by server:
   * Stalwart uses "Deleted Items" by default; Gmail uses
   * "[Gmail]/Trash"; etc.). Callers should pass the discovered
   * name rather than hard-coding.
   */
  async moveToTrash(uid: number, fromMailbox: string, trashMailbox: string): Promise<void> {
    if (fromMailbox === trashMailbox) {
      throw new Error('source and trash mailbox are the same; use expungeMessage for permanent delete');
    }
    // Delegate to the hardened `moveMessage` so we inherit the
    // MOVE-extension detection + the safe COPY-only fallback.
    // Keeping the trash semantics in a named method makes call
    // sites read clearly ("move to trash" vs "move anywhere").
    return this.moveMessage(uid, fromMailbox, trashMailbox);
  }

  /**
   * Back-compat alias for callers that haven't migrated to the
   * explicit moveToTrash / expungeMessage split yet. Behaviour is
   * unchanged: this still EXPUNGES (mailbox-wide). New callers
   * should use moveToTrash() unless they specifically want the
   * destructive variant.
   *
   * @deprecated Use moveToTrash() or expungeMessage() instead.
   */
  async deleteMessage(uid: number, mailbox = 'INBOX'): Promise<void> {
    return this.expungeMessage(uid, mailbox);
  }

  /** Mark a message as unseen (unread) */
  async markUnseen(uid: number, mailbox = 'INBOX'): Promise<void> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      await this.client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
    } finally {
      lock.release();
    }
  }

  /**
   * Flag / unflag a message. IMAP uses `\Flagged` for what Gmail
   * calls "starred" — same on-disk bit, different vocabulary. We
   * expose it as `setStarred(uid, true|false)` so the web UI can
   * call a single endpoint with a boolean.
   */
  async setStarred(uid: number, starred: boolean, mailbox = 'INBOX'): Promise<void> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      if (starred) {
        await this.client.messageFlagsAdd(String(uid), ['\\Flagged'], { uid: true });
      } else {
        await this.client.messageFlagsRemove(String(uid), ['\\Flagged'], { uid: true });
      }
    } finally {
      lock.release();
    }
  }

  /** Move a message to another folder */
  /**
   * Move a single message from one mailbox to another.
   *
   * Uses the IMAP MOVE extension (RFC 6851) when the server
   * advertises it — that command is atomic and scoped: only the
   * named UID moves, no other mailbox state is touched.
   *
   * Falls back to **COPY + STORE +\Deleted on the source UID
   * ONLY (no EXPUNGE)** when the server doesn't support MOVE.
   * The source message is left in place with the `\Deleted`
   * flag; it disappears on the next expunge from a permanent-
   * delete action. This is intentional: a mailbox-wide EXPUNGE
   * here would wipe every previously-`\Deleted` message in the
   * source mailbox as a side effect, which was the bug that
   * cleared a user's inbox in 0.8.32. Leaving the flag set is
   * the safe fallback.
   */
  async moveMessage(uid: number, fromMailbox: string, toMailbox: string): Promise<void> {
    const lock = await this.client.getMailboxLock(fromMailbox);
    try {
      const caps = (this.client as unknown as { capabilities?: Set<string> | string[] }).capabilities;
      const hasMove = caps
        && (Array.isArray(caps) ? caps.includes('MOVE') : caps.has('MOVE'));
      if (hasMove) {
        await this.client.messageMove(String(uid), toMailbox, { uid: true });
        return;
      }
      // Pre-MOVE servers: copy then flag the original. We do NOT
      // call EXPUNGE — that would be mailbox-wide and could wipe
      // other messages with \Deleted set. The original survives
      // as a "hidden" entry until an explicit empty-trash flow
      // expunges the entire source mailbox.
      await this.client.messageCopy(String(uid), toMailbox, { uid: true });
      await this.client.messageFlagsAdd(String(uid), ['\\Deleted'], { uid: true });
    } finally {
      lock.release();
    }
  }

  /** List all IMAP folders/mailboxes */
  async listFolders(): Promise<FolderInfo[]> {
    const list = await this.client.list();
    return list.map((mb: any) => ({
      path: mb.path,
      name: mb.name,
      specialUse: mb.specialUse ?? undefined,
      flags: mb.flags ? [...mb.flags] : [],
    }));
  }

  /** Create a new IMAP folder */
  async createFolder(path: string): Promise<void> {
    await this.client.mailboxCreate(path);
  }

  /** Batch mark multiple messages as seen */
  async batchMarkSeen(uids: number[], mailbox = 'INBOX'): Promise<void> {
    if (uids.length === 0) return;
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      await this.client.messageFlagsAdd(uids.join(','), ['\\Seen'], { uid: true });
    } finally {
      lock.release();
    }
  }

  /** Batch mark multiple messages as unseen */
  async batchMarkUnseen(uids: number[], mailbox = 'INBOX'): Promise<void> {
    if (uids.length === 0) return;
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      await this.client.messageFlagsRemove(uids.join(','), ['\\Seen'], { uid: true });
    } finally {
      lock.release();
    }
  }

  /** Batch delete multiple messages */
  async batchDelete(uids: number[], mailbox = 'INBOX'): Promise<void> {
    if (uids.length === 0) return;
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      await this.client.messageDelete(uids.join(','), { uid: true });
    } finally {
      lock.release();
    }
  }

  /** Batch fetch raw message content for multiple UIDs */
  async batchFetch(uids: number[], mailbox = 'INBOX'): Promise<Map<number, Buffer>> {
    if (uids.length === 0) return new Map();
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const results = new Map<number, Buffer>();
      for await (const msg of this.client.fetch(uids.join(','), { source: true, uid: true })) {
        if (msg.source) {
          results.set(msg.uid, Buffer.isBuffer(msg.source) ? msg.source : Buffer.from(msg.source as any));
        }
      }
      return results;
    } finally {
      lock.release();
    }
  }

  /**
   * Batch move multiple messages to another folder.
   *
   * Same safety model as `moveMessage`: prefers the IMAP MOVE
   * extension (atomic, scoped per UID); falls back to
   * COPY + STORE \Deleted with NO mailbox-wide EXPUNGE so an
   * existing `\Deleted` flag on an unrelated message can't
   * be amplified into a full inbox wipe.
   */
  async batchMove(uids: number[], fromMailbox: string, toMailbox: string): Promise<void> {
    if (uids.length === 0) return;
    const range = uids.join(',');
    const lock = await this.client.getMailboxLock(fromMailbox);
    try {
      const caps = (this.client as unknown as { capabilities?: Set<string> | string[] }).capabilities;
      const hasMove = caps
        && (Array.isArray(caps) ? caps.includes('MOVE') : caps.has('MOVE'));
      if (hasMove) {
        await this.client.messageMove(range, toMailbox, { uid: true });
        return;
      }
      await this.client.messageCopy(range, toMailbox, { uid: true });
      await this.client.messageFlagsAdd(range, ['\\Deleted'], { uid: true });
    } finally {
      lock.release();
    }
  }

  /** Append a raw RFC822 message to a mailbox (e.g. "Sent") with given flags */
  async appendMessage(raw: Buffer, mailbox: string, flags?: string[]): Promise<void> {
    await this.client.append(mailbox, raw, flags ?? ['\\Seen'], new Date());
  }

  getImapClient(): ImapFlow {
    return this.client;
  }
}

export interface FolderInfo {
  path: string;
  name: string;
  specialUse?: string;
  flags: string[];
}

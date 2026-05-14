// Shared mutable state for the AgenticMail web UI.
// One module, imported wherever state is read or written.
export const state = {
  masterKey: null,
  agents: [],
  selectedAgent: null,
  selectedFolder: 'inbox',     // 'inbox' | 'sent' | 'drafts' | 'starred' | 'spam' | 'trash' | 'all'
  messages: [],
  selectedUid: null,
  currentMessage: null,
  composeReplyContext: null,
  searchQuery: '',
  sseControllers: [],
  unread: {},                  // { [agentId]: count }
  /**
   * Mapping from sidebar folder id ('sent', 'drafts', 'spam', etc.)
   * to the real IMAP folder name on the server.
   *
   * Auto-discovered per agent via `GET /mail/folders` because
   * Stalwart's default folder names differ from server to server
   * (`Sent Items` vs `Sent`, `Junk Mail` vs `Spam`, etc.). Without
   * this, hard-coded names like `Sent` returned empty for Stalwart
   * installs that use `Sent Items` — exactly what the bug report
   * showed.
   */
  folderNames: {},             // { [sidebarId]: imapFolderName }
};

export const API_URL = window.location.origin;

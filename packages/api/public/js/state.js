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
  /**
   * Pagination state for the currently-rendered list. `offset` is
   * the index of the FIRST message in the current view; `limit` is
   * the page size; `total` is the server-reported total count for
   * the folder (or the local row count for drafts). Reset to
   * offset=0 on folder switch + agent switch; preserved across
   * silent SSE refreshes so a new arrival doesn't yank the user
   * back to page 1.
   */
  pagination: { offset: 0, limit: 50, total: 0 },
  /**
   * Which host's inboxes the user wants visible in the account
   * switcher. Borrowed from Airbnb's "switch to hosting / switch to
   * traveling" mode toggle — same agent, two distinct contexts. We
   * stash it in localStorage so the choice survives reloads.
   *
   *   'all'        → every account regardless of host (the original view)
   *   'claudecode' → only the Claude bridge + Claude-owned sub-agents
   *   'codex'      → only the Codex bridge + Codex-owned sub-agents
   *
   * Future hosts (grok-build, hermes) plug in here by matching their
   * own bridge name. The dropdown self-discovers available hosts from
   * `state.agents` so no UI work is needed when a new bridge appears.
   */
  activeHost: localStorage.getItem('agenticmail.activeHost') || 'all',
};

export const API_URL = window.location.origin;

/**
 * Shared types for the @agenticmail/codex package.
 *
 * Kept in one file so install/uninstall/status/dispatcher can import a single
 * source of truth without circular deps.
 */

/** An AgenticMail account as returned by `GET /api/agenticmail/accounts`. */
export interface AgenticMailAccount {
  id: string;
  name: string;
  email: string;
  apiKey: string;
  role?: string;
  metadata?: Record<string, unknown>;
  /** Per-agent wake preference. When false, the dispatcher
   *  drops wakes where this agent was on Cc/Bcc but not To,
   *  regardless of the sender's wake list. Defaults to true. */
  wakeOnCc?: boolean;
  /** Soft-stop flag. When true, the dispatcher refuses to wake
   *  this agent for any reason. Mail still lands in the mailbox
   *  so the thread's audit trail is preserved. Toggle via the
   *  stop_agent / resume_agent MCP tools or the
   *  POST /accounts/:id/stop / POST /accounts/:id/resume API. */
  stopped?: boolean;
}

/** Resolved configuration for everything the package does. */
export interface CodexIntegrationConfig {
  /** AgenticMail master API URL. */
  apiUrl: string;
  /** AgenticMail master key (mk_…). */
  masterKey: string;
  /** Codex's home dir (CODEX_HOME env or ~/.codex). */
  codexHome: string;
  /** Path to ~/.codex/config.toml — MCP servers, feature flags. */
  codexConfigPath: string;
  /** Path to ~/.codex/hooks.json — lifecycle hooks (separate file from config.toml). */
  codexHooksPath: string;
  /** Directory where per-agent Codex agent .toml files live (~/.codex/agents). */
  agentsDir: string;
  /** Key under [mcp_servers.*] in config.toml. */
  mcpServerName: string;
  /** Name of the dedicated AgenticMail account that represents this Codex install. */
  bridgeAgentName: string;
  /** Prefix for generated agent names — produces e.g. `agenticmail-vesper`. */
  subagentPrefix: string;
  /**
   * Command used to invoke the AgenticMail MCP server.
   * Defaults to `npx -y @agenticmail/mcp` for portability.
   */
  mcpCommand: string;
  mcpArgs: string[];
}

/** Snapshot of the installation state — used by `status`. */
export interface InstallStatus {
  state: 'installed' | 'not_installed' | 'partial';
  /** Whether the MCP server block is present in ~/.codex/config.toml. */
  mcpInstalled: boolean;
  /** Whether the multi_agent_v2 feature flag is enabled (so `spawn_agent` is available). */
  multiAgentEnabled: boolean;
  /** Bridge agent (Codex's identity inside AgenticMail) exists. */
  bridgeAgentExists: boolean;
  /** Codex agent .toml files currently present, keyed by AgenticMail agent name. */
  subagents: string[];
  /** Path to Codex config.toml (so the user knows what we touched). */
  codexConfigPath: string;
  /** Path to Codex hooks.json. */
  codexHooksPath: string;
  /** Directory used for agent .toml files. */
  agentsDir: string;
  /** Free-form notes for the user (e.g. "API unreachable"). */
  notes: string[];
  /** Dispatcher PM2 status (null when PM2 isn't installed or entry absent). */
  dispatcher: {
    running: boolean;
    pid?: number;
    restartCount?: number;
    uptimeMs?: number;
  } | null;
}

/** Result returned by `install`. */
export interface InstallResult {
  /** AgenticMail agents that were turned into Codex subagents. */
  registeredAgents: AgenticMailAccount[];
  /** Where the MCP server block was written. */
  codexConfigPath: string;
  /** Where the hook entries were written. */
  codexHooksPath: string;
  /** Where the agent .toml files were written. */
  agentsDir: string;
  /** The bridge agent (Codex's identity inside AgenticMail). */
  bridgeAgent: AgenticMailAccount;
  /** True if the install changed any files (false on no-op re-runs). */
  changed: boolean;
  /** Dispatcher daemon launch status (best-effort; reason populated on failure). */
  dispatcher?: { started: boolean; reason?: string };
}

/** Result returned by `uninstall`. */
export interface UninstallResult {
  /** Whether anything was actually removed. */
  changed: boolean;
  /** Removed agent .toml files. */
  removedSubagents: string[];
  /** Whether the MCP server block was removed from config.toml. */
  mcpBlockRemoved: boolean;
  /** Whether the hooks block was removed from hooks.json. */
  hooksRemoved: boolean;
  /** Whether the bridge agent was deleted (only if `--purge-bridge` was set). */
  bridgeAgentDeleted: boolean;
  /** Whether the dispatcher PM2 entry was stopped. */
  dispatcherStopped: boolean;
}

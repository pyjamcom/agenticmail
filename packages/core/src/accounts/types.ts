/** Predefined agent roles.
 *
 * `bridge` is the host-bridge identity — the account that represents an
 * external LLM host (Claude Code, Codex, Hermes, …) inside AgenticMail.
 * It owns its own inbox + API key like any other account but is logically
 * special: it's not a teammate the user assigns work to, it's the host
 * itself acting on behalf of itself. The web UI / list_agents / wake
 * gating SHOULD treat bridge accounts distinctly (they aren't typically
 * spawned as subagents; they don't show up in coordination team pickers
 * by default). The host-integration packages (@agenticmail/claudecode,
 * @agenticmail/codex) use this role when provisioning their bridge.
 */
export type AgentRole = 'secretary' | 'assistant' | 'researcher' | 'writer' | 'custom' | 'bridge';

export const AGENT_ROLES: readonly AgentRole[] = ['secretary', 'assistant', 'researcher', 'writer', 'custom', 'bridge'] as const;
export const DEFAULT_AGENT_ROLE: AgentRole = 'secretary';
export const DEFAULT_AGENT_NAME = 'secretary';

export interface Agent {
  id: string;
  name: string;
  email: string;
  apiKey: string;
  stalwartPrincipal: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
  role: AgentRole;
  /** Per-agent wake preference. When false, the dispatcher SKIPS
   *  this agent on every CC-only delivery regardless of the
   *  sender's `wake` list. Coder/silent-observer agents register
   *  with `wake_on_cc: false` so a designer's `cc:` accidentally
   *  including them never wastes a host turn. Defaults to true
   *  (preserves the 0.9.0 wake-list-respecting behaviour). */
  wakeOnCc?: boolean;
  /** Soft-stop flag. When true, the dispatcher refuses to wake
   *  this agent for ANY reason (allowlist, To/Cc, task events).
   *  Mail still lands in the mailbox so the audit trail of the
   *  thread is preserved — only Claude/Codex turns are blocked.
   *  This is the non-destructive counterpart to delete_agent for
   *  stopping a churning agent mid-task without losing context. */
  stopped?: boolean;
  /** ISO timestamp of when `stopped` was set to true. NULL when
   *  the agent has never been stopped (or has since been resumed
   *  — `resume_agent` clears both `stopped` and the audit fields
   *  is a policy decision; the current implementation clears
   *  `stopped` only and leaves the timestamp / reason in place so
   *  operators can see the most-recent stop history). */
  stoppedAt?: string | null;
  /** Optional free-form reason supplied by the caller when the
   *  agent was stopped (e.g. "task superseded by new requirements"
   *  or "stop all sub-agents — user request 2025-12-09"). */
  stoppedReason?: string | null;
}

export interface CreateAgentOptions {
  name: string;
  domain?: string;
  password?: string;
  metadata?: Record<string, unknown>;
  gateway?: 'relay' | 'domain';
  role?: AgentRole;
}

export interface AgentRow {
  id: string;
  name: string;
  email: string;
  api_key: string;
  stalwart_principal: string;
  created_at: string;
  updated_at: string;
  metadata: string;
  role: string;
  wake_on_cc?: number;
  stopped?: number;
  stopped_at?: string | null;
  stopped_reason?: string | null;
}

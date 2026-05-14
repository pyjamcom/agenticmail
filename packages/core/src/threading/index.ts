/**
 * Layered wake-context system for AgenticMail's dispatcher.
 *
 * - `thread-id`: stable threadId from `(subject, root-from)`.
 * - `thread-cache`: dispatcher-owned ring buffer of recent
 *   envelopes per thread. Layer 1 (facts).
 * - `agent-memory`: per-agent narrative the worker writes at
 *   end-of-wake. Layer 2 (judgment).
 *
 * The dispatcher uses both together to give each wake a
 * "Thread context" block in the wake prompt, so the agent
 * doesn't re-read 12 emails on every reply.
 */
export { threadIdFor, normalizeSubject, normalizeAddress } from './thread-id.js';
export type { ThreadIdInput } from './thread-id.js';
export { ThreadCache } from './thread-cache.js';
export type { ThreadCacheEntry, CachedMessage, ThreadCacheOptions } from './thread-cache.js';
export { AgentMemoryStore } from './agent-memory.js';
export type { AgentMemoryFields, AgentMemoryRead, AgentMemoryOptions } from './agent-memory.js';

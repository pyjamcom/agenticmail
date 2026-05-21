/**
 * Voice-runtime provider plugin interface.
 *
 * Each backend (OpenAI Realtime, Grok Voice Agent, future Anthropic
 * realtime, Cartesia, ElevenLabs ConvAI, etc.) lives in its own file
 * under `packages/core/src/phone/voice-providers/` and registers
 * itself with the registry by calling {@link registerVoiceProvider}
 * at module load.
 *
 * Adding a new provider is meant to be a literal FILE DROP:
 *
 *   1. Create `voice-providers/<id>.ts` exporting a {@link VoiceProvider}.
 *   2. Add a single `import './<id>.js';` line to `voice-providers/index.ts`
 *      so the side-effect registration runs.
 *   3. (Optional) document the env var the provider expects.
 *
 * No other file in the codebase needs to know about the new provider —
 * the realtime bridge looks providers up by id through the registry.
 *
 * Currently every supported provider is an OpenAI-Realtime-compatible
 * WebSocket. If a future provider diverges enough to need its own wire
 * protocol (custom event shape, gRPC, WebRTC SDP, etc.), the seam to
 * extend is here: add `buildSessionUpdate` / `parseInboundEvent` /
 * etc. hooks to {@link VoiceProvider}, then make `realtime-bridge.ts`
 * route through them instead of speaking OpenAI Realtime directly.
 */

/**
 * One voice-runtime provider. Carries enough information for the
 * bridge to open the right WebSocket with the right auth + model.
 */
export interface VoiceProvider {
  /**
   * Stable identifier used in mission policy / config (`'openai'`,
   * `'grok'`, …). Keep lowercase, no spaces — this is what operators
   * type into `AGENTICMAIL_VOICE_RUNTIME=` or pass via mission policy.
   */
  id: string;

  /** Human-readable display name for logs + the web UI. */
  displayName: string;

  /** WebSocket base URL (the bridge appends `?model=…`). */
  websocketBaseUrl: string;

  /**
   * Default model when the caller doesn't pin one. Sent as the
   * `?model=…` query string AND echoed in the session.update.
   */
  defaultModel: string;

  /**
   * The env var the operator sets for this provider's API key
   * (`OPENAI_API_KEY`, `XAI_API_KEY`, …). The bootstrap / config
   * loader reads from this name and stores into
   * `AgenticMailConfig.voiceProviderKeys[<id>]`. Used in the
   * "you didn't set the key" error message too.
   */
  apiKeyEnvVar: string;

  /**
   * Optional fallback config-field name. When the provider's API key
   * has a long-standing dedicated config field (e.g. OpenAI's
   * `config.openaiApiKey`), this lets the resolver check that field
   * BEFORE looking in the generic `voiceProviderKeys` map — so
   * existing installs don't need to migrate. Leave undefined for
   * new providers.
   */
  apiKeyConfigField?: 'openaiApiKey';

  /**
   * Per-provider notes that surface in error / boot-log messages.
   * Optional — defaults are fine for the standard providers.
   */
  description?: string;
}

/**
 * The bridge needs all the inputs needed to open a session in one
 * resolved struct — URL with model encoded, the API key, the source
 * for logging. {@link resolveVoiceRuntime} produces this.
 */
export interface VoiceRuntimeConnection {
  providerId: string;
  providerDisplayName: string;
  /** Full WebSocket URL including `?model=…`. */
  url: string;
  /** Resolved model name (also passed in the URL). */
  model: string;
  /** Bearer token for the `Authorization` header. */
  apiKey: string;
  /** Human-readable source of the key, for boot logs only (e.g. `"env XAI_API_KEY"`). */
  apiKeySource: string;
}

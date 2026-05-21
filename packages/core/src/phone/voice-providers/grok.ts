/**
 * xAI Grok Voice Agent — second supported voice-runtime provider.
 *
 * Wire protocol: explicitly OpenAI-Realtime-compatible. xAI's docs say
 * "Most OpenAI client libraries and SDKs work with the xAI endpoint
 * by changing the base URL to wss://api.x.ai/v1/realtime" — so the
 * bridge speaks the same session.update / response.create /
 * input_audio_buffer.append events it does for OpenAI. The only
 * provider-specific bits live in this file: URL, default model, and
 * the API-key env var.
 *
 * Audio: supports linear PCM @ 24 kHz (matches our 46elks default)
 * and the G.711 codecs (matches Twilio).
 *
 * Voice options: 5 built-in voices + custom voice cloning.
 *
 * Docs: https://docs.x.ai/docs/guides/voice/agent
 *       https://docs.x.ai/developers/model-capabilities/audio/voice-agent
 *       https://x.ai/news/grok-voice-agent-api
 */

import { registerVoiceProvider } from './registry.js';

registerVoiceProvider({
  id: 'grok',
  displayName: 'xAI Grok Voice Agent',
  websocketBaseUrl: 'wss://api.x.ai/v1/realtime',
  defaultModel: 'grok-voice-latest',
  apiKeyEnvVar: 'XAI_API_KEY',
  description:
    'xAI Grok Voice Agent — OpenAI-Realtime-compatible WebSocket protocol; '
    + 'select via mission policy.voiceRuntime="grok" or env AGENTICMAIL_VOICE_RUNTIME=grok.',
});

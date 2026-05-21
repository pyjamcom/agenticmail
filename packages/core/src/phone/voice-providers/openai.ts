/**
 * OpenAI Realtime — the original, baseline voice-runtime provider.
 *
 * Wire protocol: the GA `gpt-realtime` WebSocket spec. session.update,
 * response.create, conversation.item.input_audio_transcription.completed,
 * input_audio_buffer.append, etc.
 *
 * Docs: https://platform.openai.com/docs/guides/realtime
 */

import { registerVoiceProvider } from './registry.js';

registerVoiceProvider({
  id: 'openai',
  displayName: 'OpenAI Realtime (gpt-realtime)',
  websocketBaseUrl: 'wss://api.openai.com/v1/realtime',
  defaultModel: 'gpt-realtime',
  apiKeyEnvVar: 'OPENAI_API_KEY',
  // Legacy: the original config.json schema used a dedicated
  // `openaiApiKey` field for this key. The resolver checks that field
  // before the generic voiceProviderKeys map so existing installs
  // continue to work without migration.
  apiKeyConfigField: 'openaiApiKey',
  description:
    'OpenAI Realtime (gpt-realtime). Default voice runtime; supports linear PCM @ 24 kHz '
    + '(46elks) and G.711 µ-law @ 8 kHz (Twilio) without transcoding.',
  // v0.9.95 — voice catalogue. Names match what the Realtime session
  // accepts under `audio.output.voice`. `marin` and `cedar` are the
  // GA gpt-realtime additions; the rest are the legacy roster carried
  // forward from gpt-4o-realtime-preview.
  voices: ['alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'marin', 'sage', 'shimmer', 'verse'],
  defaultVoice: 'marin',
});

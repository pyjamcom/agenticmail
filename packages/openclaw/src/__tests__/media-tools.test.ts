/**
 * OpenClaw media tool tests.
 *
 * Verifies the nine media tools register at runtime (so they match the
 * manifest), and that one dispatches to the right API route — the
 * tools are thin clients of the `/media/*` routes.
 */

import { describe, expect, it, vi } from 'vitest';
import { registerTools } from '../tools.js';

const MEDIA_TOOLS = [
  'agenticmail_media_capabilities',
  'agenticmail_media_tts',
  'agenticmail_media_tts_voices',
  'agenticmail_media_image_edit',
  'agenticmail_media_video_edit',
  'agenticmail_media_audio_edit',
  'agenticmail_media_info',
  'agenticmail_media_video_understand',
  'agenticmail_media_voice_clone',
];

function buildRegisteredTools(): Map<string, any> {
  const tools = new Map<string, any>();
  registerTools({
    registerTool(factory: any) {
      const tool = factory({ sessionKey: 'agent:main' });
      tools.set(tool.name, tool);
    },
  }, {
    config: { apiUrl: 'http://127.0.0.1:3199', apiKey: 'ak_test' },
  });
  return tools;
}

describe('OpenClaw media tools', () => {
  it('registers all nine media tools', () => {
    const tools = buildRegisteredTools();
    for (const name of MEDIA_TOOLS) {
      expect(tools.has(name), `${name} should be registered`).toBe(true);
    }
  });

  it('media tools expose a JSON-schema parameter object', () => {
    const tools = buildRegisteredTools();
    const imageEdit = tools.get('agenticmail_media_image_edit');
    expect(imageEdit.parameters.type).toBe('object');
    expect(imageEdit.parameters.properties.input).toBeTruthy();
    expect(imageEdit.parameters.required).toContain('input');
    expect(imageEdit.parameters.required).toContain('action');
  });

  it('media_info dispatches a POST to /media/info', async () => {
    const tools = buildRegisteredTools();
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, duration: '8.0' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await tools.get('agenticmail_media_info').execute('call-1', { input: '/tmp/in.mp4' });
      expect(result.details).toMatchObject({ ok: true, duration: '8.0' });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://127.0.0.1:3199/api/agenticmail/media/info');
      expect((init as RequestInit).method).toBe('POST');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a media tool returns a structured error rather than throwing on API failure', async () => {
    const tools = buildRegisteredTools();
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: 'ffmpeg is required … install it', capabilityMissing: true }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await tools.get('agenticmail_media_video_edit').execute('call-2', {
        input: '/tmp/in.mp4', action: 'trim',
      });
      expect(result.details.success).toBe(false);
      expect(result.details.error).toMatch(/ffmpeg is required/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

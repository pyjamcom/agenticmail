/**
 * MCP media tool-dispatch tests.
 *
 * The media tools are thin clients of the `/media/*` API routes —
 * these tests stub `fetch` and assert each tool dispatches to the
 * right method + path + body, and that an API "capability missing"
 * error (HTTP 503) surfaces as a normal tool error rather than a crash.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('MCP media tool dispatch', () => {
  let handleToolCall: (name: string, args: Record<string, unknown>) => Promise<string>;
  let toolDefinitions: Array<{ name: string }>;

  beforeAll(async () => {
    vi.resetModules();
    process.env.AGENTICMAIL_API_URL = 'http://api.test';
    process.env.AGENTICMAIL_API_KEY = 'ak_test';
    ({ handleToolCall, toolDefinitions } = await import('../tools.js'));
  }, 15_000);

  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exposes all nine media tools', () => {
    const names = new Set(toolDefinitions.map((t) => t.name));
    for (const name of [
      'media_capabilities', 'media_tts', 'media_tts_voices',
      'media_image_edit', 'media_video_edit', 'media_audio_edit',
      'media_info', 'media_video_understand', 'media_voice_clone',
    ]) {
      expect(names.has(name), `${name} should be defined`).toBe(true);
    }
  });

  it('media_capabilities GETs the capability report', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ready: true, capabilities: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = JSON.parse(await handleToolCall('media_capabilities', {}));
    expect(result).toEqual({ ready: true, capabilities: [] });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/api/agenticmail/media/capabilities',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('media_capabilities forwards refresh as a query param', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ready: false, capabilities: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await handleToolCall('media_capabilities', { refresh: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/api/agenticmail/media/capabilities?refresh=true',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('media_image_edit POSTs the edit options to /media/image', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, filePath: '/out/img.png' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = JSON.parse(await handleToolCall('media_image_edit', {
      input: '/tmp/in.png', action: 'resize', width: 640, height: 480,
    }));
    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://api.test/api/agenticmail/media/image');
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ input: '/tmp/in.png', action: 'resize', width: 640, height: 480 });
  });

  it('media_video_edit POSTs to /media/video', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, filePath: '/out/vid.mp4' }));
    vi.stubGlobal('fetch', fetchMock);

    await handleToolCall('media_video_edit', { input: '/tmp/in.mp4', action: 'trim', start: '5', end: '15' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://api.test/api/agenticmail/media/video');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ action: 'trim', start: '5', end: '15' });
  });

  it('media_info POSTs the input path to /media/info', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, duration: '12.0' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = JSON.parse(await handleToolCall('media_info', { input: '/tmp/in.mp4' }));
    expect(result.duration).toBe('12.0');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://api.test/api/agenticmail/media/info');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ input: '/tmp/in.mp4' });
  });

  it('media_tts_voices GETs /media/voices', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ presets: [], default: 'en-US-GuyNeural' }));
    vi.stubGlobal('fetch', fetchMock);

    await handleToolCall('media_tts_voices', {});
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/api/agenticmail/media/voices',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('media_voice_clone forwards the reference audio + transcript', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, filePath: '/out/clone.wav' }));
    vi.stubGlobal('fetch', fetchMock);

    await handleToolCall('media_voice_clone', {
      text: 'hello', refAudio: '/tmp/ref.wav', refText: 'a line', device: 'cpu',
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ text: 'hello', refAudio: '/tmp/ref.wav', refText: 'a line', device: 'cpu' });
  });

  it('a 503 "capability missing" API response surfaces as a tool error, not a crash', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(
      { error: 'ffmpeg is required for this media operation. Install ffmpeg …', capabilityMissing: true },
      503,
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(handleToolCall('media_video_edit', { input: '/tmp/in.mp4', action: 'trim' }))
      .rejects.toThrow(/ffmpeg is required/);
  });
});

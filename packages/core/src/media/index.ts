// @agenticmail/core — Media toolset
//
// A media / video-editing toolset for AgenticMail agents: text-to-speech,
// image / video / audio editing, media probing, video understanding, and
// reference-voice cloning. Ported and adapted from a local media MCP.
//
// The work is done by external system binaries (ffmpeg, ffprobe,
// ImageMagick, whisper.cpp, Python) invoked via execFile with argument
// arrays — never a shell. None are bundled; every operation
// feature-detects the binary it needs and degrades gracefully with an
// actionable install hint when it is absent. The HTTP transport lives
// in @agenticmail/api; this module is dependency-free (node-edge-tts is
// an optional peer, loaded only on demand).

export { MediaManager, type MediaManagerOptions } from './manager.js';

export {
  detectBinary,
  requireBinary,
  requireWhisperModel,
  getMediaCapabilities,
  clearMediaCapabilityCache,
} from './binaries.js';

export type {
  MediaBinary,
  MediaCapability,
  MediaCapabilityReport,
  MediaFileResult,
  MediaInfoResult,
  MediaStreamInfo,
  TtsGenerateOptions,
  ImageAction,
  ImageEditOptions,
  VideoAction,
  VideoEditOptions,
  AudioAction,
  AudioEditOptions,
  VideoUnderstandOptions,
  VideoTimelineEntry,
  VideoUnderstandResult,
  VoiceCloneOptions,
} from './types.js';

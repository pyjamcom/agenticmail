// @agenticmail/core — Media binary feature-detection.
//
// The media toolset drives external system binaries (ffmpeg, ffprobe,
// ImageMagick, whisper.cpp, Python). None are bundled and most users
// will not have all of them installed. This module probes for each
// one, caches the result, and produces an actionable install hint when
// a binary is missing — so a media tool can fail with a clear message
// instead of crashing the server.
//
// Detection runs `<bin> -version` (or `--version`) via execFileSync
// with a short timeout. Any failure — ENOENT, non-zero exit, timeout —
// is treated as "not available". Nothing here ever throws.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { MediaBinary, MediaCapability, MediaCapabilityReport } from './types.js';

/** Per-binary metadata: candidate commands, version probe, and hints. */
interface BinarySpec {
  binary: MediaBinary;
  description: string;
  installHint: string;
  /** Candidate command names / absolute paths to try, in order. */
  candidates: string[];
  /** Argument that prints a version string. */
  versionArg: string;
  /** Extract a version number from the probe's stdout. */
  versionRegex: RegExp;
}

const BINARY_SPECS: Record<MediaBinary, BinarySpec> = {
  ffmpeg: {
    binary: 'ffmpeg',
    description: 'Video and audio encoding/editing engine',
    installHint:
      'Install ffmpeg — macOS: `brew install ffmpeg`; Debian/Ubuntu: `sudo apt install ffmpeg`; Windows: `winget install ffmpeg` or download from https://ffmpeg.org/download.html',
    candidates: ['ffmpeg'],
    versionArg: '-version',
    versionRegex: /ffmpeg version (\S+)/i,
  },
  ffprobe: {
    binary: 'ffprobe',
    description: 'Media file metadata probe (ships with ffmpeg)',
    installHint:
      'Install ffmpeg (ffprobe ships with it) — macOS: `brew install ffmpeg`; Debian/Ubuntu: `sudo apt install ffmpeg`; Windows: `winget install ffmpeg`.',
    candidates: ['ffprobe'],
    versionArg: '-version',
    versionRegex: /ffprobe version (\S+)/i,
  },
  imagemagick: {
    binary: 'imagemagick',
    description: 'Image editing engine (resize, crop, overlays, …)',
    installHint:
      'Install ImageMagick — macOS: `brew install imagemagick`; Debian/Ubuntu: `sudo apt install imagemagick`; Windows: `winget install ImageMagick.ImageMagick` or download from https://imagemagick.org/script/download.php',
    // ImageMagick 7 ships `magick`; ImageMagick 6 ships `convert`.
    candidates: ['magick', 'convert'],
    versionArg: '-version',
    versionRegex: /Version: ImageMagick ([\d.]+)/i,
  },
  whisper: {
    binary: 'whisper',
    description: 'whisper.cpp speech-to-text CLI (auto-captions, transcripts)',
    installHint:
      'Install whisper.cpp — macOS: `brew install whisper-cpp`; or build from source at https://github.com/ggml-org/whisper.cpp. A model file (e.g. ggml-base.en.bin) must also be passed via the whisperModel option.',
    // Homebrew installs the CLI as `whisper-cli`; some builds name it `whisper`.
    candidates: ['whisper-cli', 'whisper'],
    versionArg: '--help',
    versionRegex: /(?:whisper|usage)/i,
  },
  python: {
    binary: 'python',
    description: 'Python interpreter (used by voice_clone / F5-TTS)',
    installHint:
      'Install Python 3 — macOS: `brew install python`; Debian/Ubuntu: `sudo apt install python3`; Windows: `winget install Python.Python.3`. The voice_clone tool also needs the f5-tts and soundfile packages in that interpreter.',
    candidates: ['python3', 'python'],
    versionArg: '--version',
    versionRegex: /Python ([\d.]+)/i,
  },
  'edge-tts': {
    binary: 'edge-tts',
    description: 'Edge text-to-speech engine (node-edge-tts npm package)',
    installHint:
      'Install the optional node-edge-tts package — `npm install node-edge-tts` in the AgenticMail install — to enable tts_generate.',
    // edge-tts is an npm package, not a binary; detection is handled
    // specially below via module resolution.
    candidates: [],
    versionArg: '',
    versionRegex: /.*/,
  },
};

/** Cached detection results — keyed by binary. Cleared by {@link clearMediaCapabilityCache}. */
const detectionCache = new Map<MediaBinary, MediaCapability>();

/**
 * Probe one candidate command. Returns its version string on success,
 * or `null` on any failure (ENOENT, non-zero exit, timeout). Never
 * throws — a missing binary is an expected, recoverable state.
 */
function probeCommand(command: string, spec: BinarySpec): string | null {
  try {
    const output = execFileSync(command, [spec.versionArg], {
      timeout: 4_000,
      // Cap stdout — `--help` output can be large; we only need the head.
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    const match = output.match(spec.versionRegex);
    // A matched regex confirms it is the real binary, not a same-named
    // shim. When the regex matched but captured no group, return a
    // non-empty sentinel so the caller still treats it as available.
    if (match) return match[1] ?? 'present';
    return null;
  } catch {
    return null;
  }
}

/**
 * Detect the node-edge-tts package by attempting module resolution.
 * It is an optional peer dependency, never bundled, so a plain
 * `require.resolve`-style check is the right probe.
 */
function detectEdgeTts(spec: BinarySpec): MediaCapability {
  try {
    // import.meta.resolve throws if the package is not installed.
    // Wrapped so the absence is a clean "not available" result.
    const resolved = import.meta.resolve?.('node-edge-tts');
    if (resolved) {
      return {
        binary: 'edge-tts',
        available: true,
        command: 'node-edge-tts',
        description: spec.description,
      };
    }
  } catch {
    /* not installed — fall through */
  }
  return {
    binary: 'edge-tts',
    available: false,
    description: spec.description,
    installHint: spec.installHint,
  };
}

/**
 * Detect whether a single binary is available. Result is cached; pass
 * `{ force: true }` to re-probe (e.g. after the operator installs it).
 */
export function detectBinary(binary: MediaBinary, opts: { force?: boolean } = {}): MediaCapability {
  if (!opts.force) {
    const cached = detectionCache.get(binary);
    if (cached) return cached;
  }

  const spec = BINARY_SPECS[binary];

  let capability: MediaCapability;
  if (binary === 'edge-tts') {
    capability = detectEdgeTts(spec);
  } else {
    capability = {
      binary,
      available: false,
      description: spec.description,
      installHint: spec.installHint,
    };
    for (const candidate of spec.candidates) {
      const version = probeCommand(candidate, spec);
      if (version !== null) {
        capability = {
          binary,
          available: true,
          version: version === 'present' ? undefined : version,
          command: candidate,
          description: spec.description,
        };
        break;
      }
    }
  }

  detectionCache.set(binary, capability);
  return capability;
}

/**
 * Resolve the command name to invoke for a binary. Throws a clear,
 * actionable error if the binary is not available — callers use this
 * at the top of every media operation so a missing dependency fails
 * fast with an install hint instead of an opaque ENOENT deep inside
 * an execFile call.
 */
export function requireBinary(binary: MediaBinary): string {
  const cap = detectBinary(binary);
  if (!cap.available || !cap.command) {
    const spec = BINARY_SPECS[binary];
    throw new Error(
      `${spec.binary} is required for this media operation but was not found. ${spec.installHint}`,
    );
  }
  return cap.command;
}

/**
 * Validate that a whisper.cpp model file exists on disk. whisper.cpp
 * needs an explicit model path; this surfaces a clear error rather
 * than letting the CLI fail cryptically.
 */
export function requireWhisperModel(modelPath: string | undefined): string {
  if (!modelPath) {
    throw new Error(
      'A whisper.cpp model file is required (whisperModel option). Download one, e.g. ggml-base.en.bin, from https://huggingface.co/ggerganov/whisper.cpp and pass its absolute path.',
    );
  }
  if (!existsSync(modelPath)) {
    throw new Error(`whisper model file not found: ${modelPath}`);
  }
  return modelPath;
}

/**
 * Build the full media capability report — one entry per binary, plus
 * a `ready` flag (true once ffmpeg + ffprobe, the baseline, are both
 * present). Used by the health surface and the `media_capabilities`
 * tool so an agent can see what is available before attempting an op.
 */
export function getMediaCapabilities(opts: { force?: boolean } = {}): MediaCapabilityReport {
  const order: MediaBinary[] = ['ffmpeg', 'ffprobe', 'imagemagick', 'whisper', 'python', 'edge-tts'];
  const capabilities = order.map((b) => detectBinary(b, opts));
  const has = (b: MediaBinary) => capabilities.find((c) => c.binary === b)?.available === true;
  return {
    capabilities,
    ready: has('ffmpeg') && has('ffprobe'),
    checkedAt: new Date().toISOString(),
  };
}

/** Clear the detection cache — used by tests and after a re-install. */
export function clearMediaCapabilityCache(): void {
  detectionCache.clear();
}

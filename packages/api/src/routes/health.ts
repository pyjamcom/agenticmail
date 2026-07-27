import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StalwartAdmin } from '@agenticmail/core';

const PKG_VERSION = (() => {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    // tsup bundles into dist/index.js, so ../package.json from dist/
    const pkg = JSON.parse(readFileSync(join(dir, '..', 'package.json'), 'utf-8'));
    return pkg.version;
  } catch { return '0.5.31'; }
})();

const ABOUT = {
  name: '🎀 AgenticMail',
  version: PKG_VERSION,
  description: '🎀 AgenticMail — Email infrastructure for AI agents. Send, receive, coordinate, and automate email with full DKIM/SPF/DMARC authentication.',
  author: {
    name: 'Ope Olatunji',
    github: 'https://github.com/agenticmail/agenticmail',
  },
  license: 'MIT',
  repository: 'https://github.com/agenticmail/agenticmail',
  contributing: 'Contributions and feature requests welcome! Visit the GitHub repo to open issues, suggest features, or submit pull requests.',
  tools: 63,
  features: {
    email: {
      summary: 'Full email lifecycle — send, receive, reply, forward, search, batch operations',
      highlights: [
        'DKIM/SPF/DMARC authentication out of the box',
        'Custom domain support via Cloudflare (agent@yourdomain.com)',
        'Gmail/Outlook relay mode for quick setup',
        'Batch operations for token-efficient bulk processing',
        'Server-side rules for auto-triage before the agent even sees the email',
      ],
    },
    coordination: {
      summary: 'Structured multi-agent coordination that replaces fire-and-forget session spawning',
      highlights: [
        'Task queue with assign → claim → submit lifecycle (persistent, survives crashes)',
        'Synchronous RPC — call another agent and wait for structured results',
        'Push notifications via SSE — no wasted polling cycles',
        'Agent discovery — agents find each other by name and role',
        'Email threading — agents naturally build conversation history',
      ],
      comparison: {
        without_agenticmail: {
          method: 'sessions_spawn + sessions_send + sessions_history',
          problems: [
            'No persistence — if a sub-agent crashes, all context is lost',
            'No structured results — just text messages, no schemas or status tracking',
            'No task lifecycle — no way to know if a task was claimed, in progress, or completed',
            'No agent discovery — agents cannot find or learn about each other',
            'Polling required — must repeatedly check sessions_history to see if work is done',
            'No async handoff — parent must stay alive waiting for the child to finish',
          ],
        },
        with_agenticmail: {
          method: 'call_agent (preferred) or claim_task → submit_result for manual workflows',
          benefits: [
            'Persistent task state — tasks survive agent crashes and restarts',
            'Structured results — JSON payloads with status tracking (pending → claimed → completed)',
            'Push-based — agents get notified instantly when tasks complete (SSE + email)',
            'Agent discovery — list_agents shows all available agents by name and role',
            'Async capable — assign a task and check results later, no blocking required',
            'Audit trail — every coordination action is an email, naturally logged',
          ],
        },
      },
    },
    security: {
      summary: 'Enterprise-grade email security for autonomous agents',
      highlights: [
        'Outbound PII/credential scanning (SSN, credit cards, API keys, passwords — including attachments)',
        'Human-in-the-loop approval for blocked emails — owner gets notified, agent cannot self-approve',
        'Inbound spam filtering with scoring (phishing, lottery scams, social engineering detection)',
        'Agent cannot bypass security guardrails — architectural enforcement, not just prompt rules',
      ],
    },
    media: {
      summary: 'Local, opt-in media toolset — text-to-speech, image / video / audio editing, probing, video understanding, voice cloning',
      highlights: [
        'Eight tools: tts_generate, tts_list_voices, image_edit, video_edit, audio_edit, media_info, video_understand, voice_clone',
        'Cinematic video ops — color grading, transitions, captions, picture-in-picture, Ken Burns, slow motion, watermarks',
        'Drives local binaries (ffmpeg, ImageMagick, whisper.cpp) — no API keys, no cloud upload',
        'Gracefully degrading — every tool feature-detects its binary and returns an actionable install hint when absent; the server never crashes',
        'Check availability any time with media_capabilities or the /health media block',
      ],
    },
  },
  impact: {
    tokenSavings: {
      estimate: '~60% fewer tokens on multi-agent coordination tasks',
      explanation: 'Without 🎀 AgenticMail, agents poll sessions_history repeatedly to check if sub-agents finished — each poll costs 500-2000 tokens and most return "still working." With push notifications and structured task results, the coordinator gets notified exactly once when work completes. For a 5-agent team doing 10 tasks, that eliminates roughly 40-80 redundant polling calls.',
    },
    reliability: {
      estimate: 'Near-zero lost work from agent crashes',
      explanation: 'Session-based coordination loses all context when a sub-agent times out or crashes. 🎀 AgenticMail tasks persist in the database — a crashed agent can be restarted and pick up exactly where it left off. The task queue acts as a durable work ledger.',
    },
    productivity: {
      estimate: '3-5x more effective multi-agent workflows',
      explanation: 'Agents can discover teammates, delegate structured tasks, get push notifications on completion, and build on each other\'s results through email threads. This turns a collection of isolated agents into an actual coordinated team. The difference is like going from passing sticky notes under a door to having a proper project management system.',
    },
  },
};

/**
 * Health must not execute external media binaries. Accurate detection stays
 * available through the dedicated media_capabilities tool.
 */
function mediaCapabilitySummary(): {
  ready: false;
  binaries: Record<string, boolean>;
  probeDeferred: true;
} {
  return { ready: false, binaries: {}, probeDeferred: true };
}

export function createHealthRoutes(stalwart: StalwartAdmin): Router {
  const router = Router();

  // Process liveness must stay independent of Stalwart and media probes so the
  // watchdog never restarts a healthy API because a downstream check is slow.
  router.get('/health/live', (_req, res) => {
    res.json({
      status: 'ok',
      version: ABOUT.version,
      services: { api: 'ok' },
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/health', async (_req, res) => {
    try {
      const stalwartOk = await stalwart.healthCheck();

      res.status(stalwartOk ? 200 : 503).json({
        status: stalwartOk ? 'ok' : 'degraded',
        version: ABOUT.version,
        services: {
          api: 'ok',
          stalwart: stalwartOk ? 'ok' : 'unreachable',
        },
        // Media readiness is intentionally deferred to keep health non-blocking.
        media: mediaCapabilitySummary(),
        timestamp: new Date().toISOString(),
      });
    } catch {
      res.status(500).json({
        status: 'error',
        version: ABOUT.version,
        services: { api: 'ok', stalwart: 'unreachable' },
        media: mediaCapabilitySummary(),
        timestamp: new Date().toISOString(),
      });
    }
  });

  router.get('/about', (_req, res) => {
    res.json(ABOUT);
  });

  return router;
}

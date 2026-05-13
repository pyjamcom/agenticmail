/**
 * HTTP routes for the Claude Code integration.
 *
 * Mounted by `@agenticmail/api` (see app.ts) under
 *   /api/agenticmail/integrations/claudecode
 *
 * Purpose: let an agent (Claude Code itself, a shell script, a CI job, …)
 * install the integration with a single POST request, no terminal interaction
 * required. The endpoints are deliberately registered BEFORE the master-key
 * auth middleware because they ARE the bootstrap — a Claude Code session that
 * doesn't yet have AgenticMail wired up has no way to know the master key,
 * so requiring it would defeat the purpose.
 *
 * SECURITY MODEL
 * --------------
 * The AgenticMail master API binds to 127.0.0.1 by default. Any process that
 * can reach this endpoint can already read ~/.agenticmail/config.json (same
 * file ownership), so leaving these endpoints unauthenticated does not widen
 * the attack surface. If the operator binds the API to a non-loopback
 * interface they MUST put auth or a firewall in front of it — same as every
 * other unauthenticated route on this server (e.g. /health).
 *
 * The install handler still reads the master key from disk before touching
 * AgenticMail, so the routes don't grant *new* powers — they just save the
 * agent the trouble of plumbing one in.
 */

import { Router, type Request, type Response } from 'express';
import { install } from './install.js';
import { uninstall, type UninstallOptions } from './uninstall.js';
import { status } from './status.js';
import { AgenticMailApiError } from './api.js';
import type { ResolveConfigOptions } from './config.js';

/** Body shape accepted by the install endpoint — every field is optional. */
interface InstallBody extends ResolveConfigOptions {
  // No additional fields; alias for clarity at call sites.
}

interface UninstallBody extends UninstallOptions {
  // No additional fields.
}

/** Coerce a request body into a safe options object. We accept the same
 * fields as `resolveConfig` plus uninstall-specific flags. Anything else
 * is ignored (defence-in-depth — the client cannot trick us into evaluating
 * a foreign config key). */
function sanitizeInstallBody(body: unknown): InstallBody {
  if (!body || typeof body !== 'object') return {};
  const b = body as Record<string, unknown>;
  const out: InstallBody = {};
  if (typeof b.apiUrl === 'string') out.apiUrl = b.apiUrl;
  if (typeof b.masterKey === 'string') out.masterKey = b.masterKey;
  if (typeof b.claudeConfigPath === 'string') out.claudeConfigPath = b.claudeConfigPath;
  if (typeof b.agentsDir === 'string') out.agentsDir = b.agentsDir;
  if (typeof b.mcpServerName === 'string') out.mcpServerName = b.mcpServerName;
  if (typeof b.bridgeAgentName === 'string') out.bridgeAgentName = b.bridgeAgentName;
  if (typeof b.subagentPrefix === 'string') out.subagentPrefix = b.subagentPrefix;
  if (typeof b.mcpCommand === 'string') out.mcpCommand = b.mcpCommand;
  if (Array.isArray(b.mcpArgs) && b.mcpArgs.every(a => typeof a === 'string')) {
    out.mcpArgs = b.mcpArgs as string[];
  }
  return out;
}

function sanitizeUninstallBody(body: unknown): UninstallBody {
  const base = sanitizeInstallBody(body) as UninstallBody;
  if (body && typeof body === 'object' && (body as Record<string, unknown>).purgeBridgeAgent === true) {
    base.purgeBridgeAgent = true;
  }
  return base;
}

/** Translate package errors into HTTP responses. */
function handleError(err: unknown, res: Response): void {
  if (err instanceof AgenticMailApiError) {
    // status=0 means we couldn't reach AgenticMail itself — that's a
    // 503 (Service Unavailable) rather than a 500. status>0 is a real
    // upstream HTTP error we can forward.
    const code = err.status === 0 ? 503 : err.status;
    res.status(code).json({ error: err.message });
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: msg });
}

/**
 * Build the Express router. Caller mounts at the prefix of its choosing
 * (typically `/api/agenticmail/integrations/claudecode`).
 */
export function createIntegrationRoutes(): Router {
  const router = Router();

  router.get('/integrations/claudecode/status', async (_req: Request, res: Response) => {
    try {
      const result = await status();
      res.json(result);
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post('/integrations/claudecode/install', async (req: Request, res: Response) => {
    try {
      const body = sanitizeInstallBody(req.body);
      const result = await install(body);
      // Redact EVERY api key on the way out. The caller is the AgenticMail
      // server itself; the bridge's key has already been written to
      // ~/.claude.json server-side and the other agents' keys belong to
      // those agents — neither needs to ride the response. Returning them
      // over HTTP would multiply their attack surface (logs, transcripts,
      // screenshots) without unlocking any feature the caller is asking
      // for.
      const safeRegisteredAgents = result.registeredAgents.map(a => ({
        ...a, apiKey: '***redacted***',
      }));
      const safeBridge = { ...result.bridgeAgent, apiKey: '***redacted***' };
      res.status(200).json({
        ...result,
        registeredAgents: safeRegisteredAgents,
        bridgeAgent: safeBridge,
      });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post('/integrations/claudecode/uninstall', async (req: Request, res: Response) => {
    try {
      const body = sanitizeUninstallBody(req.body);
      const result = await uninstall(body);
      res.status(200).json(result);
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

/**
 * HTTP routes for the Codex integration.
 *
 * Mounted by `@agenticmail/api` (see app.ts) under
 *   /api/agenticmail/integrations/codex
 *
 * Purpose: let an agent (Codex itself, a shell script, a CI job, …)
 * install the integration with a single POST request, no terminal
 * interaction required. The endpoints are deliberately registered
 * BEFORE the master-key auth middleware because they ARE the bootstrap
 * — a Codex session that doesn't yet have AgenticMail wired up has no
 * way to know the master key, so requiring it would defeat the purpose.
 *
 * Security model is identical to @agenticmail/claudecode's http-routes:
 * the master API binds to 127.0.0.1 by default; any process that can
 * reach this endpoint can already read ~/.agenticmail/config.json, so
 * leaving the routes unauthenticated does not widen the attack surface.
 */

import { Router, type Request, type Response } from 'express';
import { install } from './install.js';
import { uninstall, type UninstallOptions } from './uninstall.js';
import { status } from './status.js';
import { AgenticMailApiError } from './api.js';
import type { ResolveConfigOptions } from './config.js';

interface InstallBody extends ResolveConfigOptions {
  // No additional fields; alias for clarity at call sites.
}

interface UninstallBody extends UninstallOptions {
  // No additional fields.
}

/**
 * Coerce a request body into a safe options object. We accept the same
 * fields as `resolveConfig` plus uninstall-specific flags. Anything else
 * is ignored (defence-in-depth — the client cannot trick us into
 * evaluating a foreign config key).
 */
function sanitizeInstallBody(body: unknown): InstallBody {
  if (!body || typeof body !== 'object') return {};
  const b = body as Record<string, unknown>;
  const out: InstallBody = {};
  if (typeof b.apiUrl === 'string') out.apiUrl = b.apiUrl;
  if (typeof b.masterKey === 'string') out.masterKey = b.masterKey;
  if (typeof b.codexHome === 'string') out.codexHome = b.codexHome;
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

function handleError(err: unknown, res: Response): void {
  if (err instanceof AgenticMailApiError) {
    const code = err.status === 0 ? 503 : err.status;
    res.status(code).json({ error: err.message });
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: msg });
}

/**
 * Build the Express router. Caller mounts at the prefix of its choosing
 * (typically `/api/agenticmail`); endpoints land at:
 *
 *   GET  /integrations/codex/status
 *   POST /integrations/codex/install
 *   POST /integrations/codex/uninstall
 */
export function createIntegrationRoutes(): Router {
  const router = Router();

  router.get('/integrations/codex/status', async (_req: Request, res: Response) => {
    try {
      const result = await status();
      res.json(result);
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post('/integrations/codex/install', async (req: Request, res: Response) => {
    try {
      const body = sanitizeInstallBody(req.body);
      const result = await install(body);
      // Redact every api key on the way out. The bridge's key has already
      // been written to ~/.codex/config.toml server-side and the other
      // agents' keys belong to those agents — neither needs to ride the
      // response. Returning them over HTTP would multiply their attack
      // surface (logs, transcripts, screenshots).
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

  router.post('/integrations/codex/uninstall', async (req: Request, res: Response) => {
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

import { Router, type Request, type Response } from 'express';
import {
  PhoneManager,
  buildPhoneTransportConfig,
  redactPhoneTransportConfig,
  type AgenticMailConfig,
  type PhoneMissionState,
} from '@agenticmail/core';

function requestString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readWebhookSecret(req: Request): string {
  return requestString(req.get('x-agenticmail-webhook-secret'))
    || requestString(req.get('x-46elks-secret'))
    || requestString(req.query.secret)
    || requestString((req.body as Record<string, unknown> | undefined)?.secret);
}

function readMissionId(req: Request): string {
  return requestString(req.query.missionId)
    || requestString(req.query.mission)
    || requestString((req.body as Record<string, unknown> | undefined)?.missionId)
    || requestString((req.body as Record<string, unknown> | undefined)?.mission);
}

function getAgent(req: Request, res: Response): { id: string; email: string } | null {
  const agent = (req as any).agent;
  if (!agent) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  return agent;
}

function errorStatus(err: unknown): number {
  const msg = (err as Error)?.message ?? String(err);
  if (msg.includes('not found')) return 404;
  if (msg.includes('Invalid') || msg.includes('required') || msg.includes('not configured')) return 400;
  return 500;
}

export function createPhoneWebhookRoutes(
  db: ReturnType<typeof import('@agenticmail/core').getDatabase>,
  config: AgenticMailConfig,
): Router {
  const router = Router();
  const phoneManager = new PhoneManager(db as any, config.masterKey);

  router.post('/calls/webhook/46elks/voice-start', (req: Request, res: Response) => {
    try {
      const missionId = readMissionId(req);
      const secret = readWebhookSecret(req);
      if (!missionId) return res.status(400).json({ error: 'missionId is required' });

      const result = phoneManager.handleVoiceStartWebhook(missionId, secret, req.body ?? {});
      res.json(result.action);
    } catch (err) {
      const status = (err as Error).message.includes('secret') ? 403 : errorStatus(err);
      res.status(status).json({ error: (err as Error).message });
    }
  });

  router.post('/calls/webhook/46elks/hangup', (req: Request, res: Response) => {
    try {
      const missionId = readMissionId(req);
      const secret = readWebhookSecret(req);
      if (!missionId) return res.status(400).json({ error: 'missionId is required' });

      const mission = phoneManager.handleHangupWebhook(missionId, secret, req.body ?? {});
      res.json({ success: true, mission });
    } catch (err) {
      const status = (err as Error).message.includes('secret') ? 403 : errorStatus(err);
      res.status(status).json({ error: (err as Error).message });
    }
  });

  return router;
}

export function createPhoneRoutes(
  db: ReturnType<typeof import('@agenticmail/core').getDatabase>,
  config: AgenticMailConfig,
): Router {
  const router = Router();
  const phoneManager = new PhoneManager(db as any, config.masterKey);

  router.get('/phone/transport/config', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const cfg = phoneManager.getPhoneTransportConfig(agent.id);
      res.json({
        configured: !!cfg,
        transport: cfg ? redactPhoneTransportConfig(cfg) : null,
      });
    } catch (err) {
      res.status(errorStatus(err)).json({ error: (err as Error).message });
    }
  });

  router.post('/phone/transport/setup', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const cfg = buildPhoneTransportConfig(req.body ?? {});
      phoneManager.savePhoneTransportConfig(agent.id, cfg);
      res.json({
        success: true,
        transport: redactPhoneTransportConfig(cfg),
        nextSteps: [
          'Phone transport is configured for call_control.',
          'Calls can now be started with /calls/start or the phone tool surface.',
          'Realtime conversation is not connected in this slice; started calls remain mission-tracked call-control events.',
        ],
      });
    } catch (err) {
      res.status(errorStatus(err)).json({ error: (err as Error).message });
    }
  });

  router.get('/phone/capabilities', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const cfg = phoneManager.getPhoneTransportConfig(agent.id);
      res.json({
        configured: !!cfg,
        provider: cfg?.provider ?? null,
        phoneNumber: cfg?.phoneNumber ?? null,
        capabilities: cfg?.capabilities ?? [],
        supportedRegions: cfg?.supportedRegions ?? [],
        realtimeReady: !!cfg?.capabilities.includes('realtime_media'),
      });
    } catch (err) {
      res.status(errorStatus(err)).json({ error: (err as Error).message });
    }
  });

  router.post('/calls/start', async (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const result = await phoneManager.startMission(agent.id, {
        to: req.body?.to,
        task: req.body?.task,
        policy: req.body?.policy,
        voiceRuntimeRef: req.body?.voiceRuntimeRef,
      }, {
        dryRun: req.body?.dryRun === true,
      });

      res.json({
        success: true,
        mission: result.mission,
        providerRequest: result.providerRequest
          ? { ...result.providerRequest, body: { ...result.providerRequest.body, voice_start: '[redacted-url]', whenhangup: '[redacted-url]' } }
          : undefined,
        providerResponse: result.providerResponse,
      });
    } catch (err) {
      res.status(errorStatus(err)).json({ error: (err as Error).message });
    }
  });

  router.get('/calls', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '20'), 10) || 20, 1), 100);
      const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
      const status = requestString(req.query.status) as PhoneMissionState;
      const missions = phoneManager.listMissions(agent.id, { limit, offset, status });
      res.json({ missions, count: missions.length });
    } catch (err) {
      res.status(errorStatus(err)).json({ error: (err as Error).message });
    }
  });

  router.get('/calls/:id', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const mission = phoneManager.getMission(req.params.id, agent.id);
      if (!mission) return res.status(404).json({ error: 'Phone mission not found' });
      res.json({ mission });
    } catch (err) {
      res.status(errorStatus(err)).json({ error: (err as Error).message });
    }
  });

  router.get('/calls/:id/transcript', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const mission = phoneManager.getMission(req.params.id, agent.id);
      if (!mission) return res.status(404).json({ error: 'Phone mission not found' });
      res.json({ missionId: mission.id, transcript: mission.transcript });
    } catch (err) {
      res.status(errorStatus(err)).json({ error: (err as Error).message });
    }
  });

  router.post('/calls/:id/cancel', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const mission = phoneManager.cancelMission(agent.id, req.params.id);
      res.json({ success: true, mission });
    } catch (err) {
      res.status(errorStatus(err)).json({ error: (err as Error).message });
    }
  });

  return router;
}

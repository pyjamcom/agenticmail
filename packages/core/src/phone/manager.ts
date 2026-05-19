import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Database } from '../storage/db.js';
import { encryptSecret, decryptSecret, isEncryptedSecret } from '../crypto/secrets.js';
import { normalizePhoneNumber } from '../sms/manager.js';
import {
  PHONE_MISSION_STATES,
  validatePhoneMissionStart,
  validatePhoneTransportProfile,
  type OpenClawPhoneMissionPolicy,
  type PhoneMissionState,
  type PhoneTransportProfile,
  type StartPhoneMissionInput,
  type TelephonyTransportCapability,
} from './mission.js';

export type PhoneTransportProvider = '46elks';

export interface PhoneTransportConfig extends PhoneTransportProfile {
  provider: PhoneTransportProvider;
  username: string;
  password: string;
  webhookBaseUrl: string;
  webhookSecret: string;
  apiUrl?: string;
  configuredAt: string;
}

export interface PhoneMissionTranscriptEntry {
  at: string;
  source: 'system' | 'provider' | 'agent' | 'operator';
  text: string;
  metadata?: Record<string, unknown>;
}

export interface PhoneCallMission {
  id: string;
  agentId: string;
  status: PhoneMissionState;
  from: string;
  to: string;
  task: string;
  policy: OpenClawPhoneMissionPolicy;
  transport: PhoneTransportProfile;
  provider: PhoneTransportProvider;
  providerCallId?: string;
  transcript: PhoneMissionTranscriptEntry[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface StartPhoneCallOptions {
  dryRun?: boolean;
  fetchFn?: typeof fetch;
  now?: Date;
}

export interface StartPhoneCallResult {
  mission: PhoneCallMission;
  providerRequest?: {
    url: string;
    body: Record<string, string>;
  };
  providerResponse?: unknown;
}

export interface PhoneWebhookResult {
  mission: PhoneCallMission;
  action: Record<string, unknown>;
}

const PHONE_SECRET_FIELDS = ['password', 'webhookSecret'] as const;

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function defaultApiUrl(config: PhoneTransportConfig): string {
  const url = (config.apiUrl || 'https://api.46elks.com/a1').replace(/\/+$/, '');
  if (!/^https:\/\//i.test(url)) {
    throw new Error('46elks apiUrl must use https:// — refusing to send credentials over a non-TLS connection');
  }
  return url;
}

function basicAuth(username: string, password: string): string {
  return Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
}

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function apiBaseUrl(webhookBaseUrl: string): string {
  const root = webhookBaseUrl.replace(/\/+$/, '');
  return root.endsWith('/api/agenticmail') ? root : `${root}/api/agenticmail`;
}

function buildWebhookUrl(config: PhoneTransportConfig, path: string, missionId: string): string {
  const url = new URL(`${apiBaseUrl(config.webhookBaseUrl)}${path}`);
  url.searchParams.set('missionId', missionId);
  url.searchParams.set('secret', config.webhookSecret);
  return url.toString();
}

function redactWebhookUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.searchParams.has('secret')) url.searchParams.set('secret', '***');
    return url.toString();
  } catch {
    return '[redacted-url]';
  }
}

function redactProviderRequest(request: { url: string; body: Record<string, string> }): { url: string; body: Record<string, string> } {
  return {
    url: request.url,
    body: {
      ...request.body,
      voice_start: redactWebhookUrl(request.body.voice_start),
      whenhangup: redactWebhookUrl(request.body.whenhangup),
    },
  };
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToMission(row: any): PhoneCallMission {
  return {
    id: row.id,
    agentId: row.agent_id,
    status: row.status,
    from: row.from_phone,
    to: row.to_phone,
    task: row.task,
    policy: parseJson(row.policy_json, {} as OpenClawPhoneMissionPolicy),
    transport: parseJson(row.transport_json, {} as PhoneTransportProfile),
    provider: row.provider,
    providerCallId: row.provider_call_id ?? undefined,
    transcript: parseJson(row.transcript_json, []),
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function redactPhoneTransportConfig(config: PhoneTransportConfig): PhoneTransportConfig {
  return {
    ...config,
    password: config.password ? '***' : '',
    webhookSecret: config.webhookSecret ? '***' : '',
  };
}

export class PhoneManager {
  private initialized = false;

  constructor(private db: Database, private encryptionKey?: string) {
    this.ensureTables();
  }

  private encryptConfig(config: PhoneTransportConfig): PhoneTransportConfig {
    if (!this.encryptionKey) return config;
    const out: PhoneTransportConfig = { ...config };
    for (const field of PHONE_SECRET_FIELDS) {
      const value = out[field];
      if (typeof value === 'string' && value && !isEncryptedSecret(value)) {
        out[field] = encryptSecret(value, this.encryptionKey);
      }
    }
    return out;
  }

  private decryptConfig(config: PhoneTransportConfig): PhoneTransportConfig {
    if (!this.encryptionKey) return config;
    const out: PhoneTransportConfig = { ...config };
    for (const field of PHONE_SECRET_FIELDS) {
      const value = out[field];
      if (typeof value === 'string' && isEncryptedSecret(value)) {
        try {
          out[field] = decryptSecret(value, this.encryptionKey);
        } catch {
          // Leave ciphertext in place; downstream validation fails closed.
        }
      }
    }
    return out;
  }

  private ensureTables(): void {
    if (this.initialized) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS phone_missions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        from_phone TEXT NOT NULL,
        to_phone TEXT NOT NULL,
        task TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        transport_json TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_call_id TEXT,
        transcript_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_phone_missions_agent ON phone_missions(agent_id)'); } catch {}
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_phone_missions_status ON phone_missions(status)'); } catch {}
    this.initialized = true;
  }

  getPhoneTransportConfig(agentId: string): PhoneTransportConfig | null {
    const row = this.db.prepare('SELECT metadata FROM agents WHERE id = ?').get(agentId) as { metadata: string } | undefined;
    if (!row) return null;
    const meta = parseJson<Record<string, unknown>>(row.metadata, {});
    const config = meta.phoneTransport;
    if (!config || typeof config !== 'object') return null;
    return this.decryptConfig(config as PhoneTransportConfig);
  }

  savePhoneTransportConfig(agentId: string, config: PhoneTransportConfig): PhoneTransportConfig {
    const row = this.db.prepare('SELECT metadata FROM agents WHERE id = ?').get(agentId) as { metadata: string } | undefined;
    if (!row) throw new Error(`Agent ${agentId} not found`);

    const transportCheck = validatePhoneTransportProfile(config);
    if (!transportCheck.ok) {
      throw new Error(`Invalid phone transport config: ${transportCheck.issues.map((item) => `${item.field}: ${item.message}`).join('; ')}`);
    }

    const meta = parseJson<Record<string, unknown>>(row.metadata, {});
    meta.phoneTransport = this.encryptConfig({
      ...config,
      phoneNumber: transportCheck.transport.phoneNumber,
      capabilities: transportCheck.transport.capabilities,
      supportedRegions: transportCheck.transport.supportedRegions,
    });
    this.db.prepare("UPDATE agents SET metadata = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(meta), agentId);
    return config;
  }

  getMission(missionId: string, agentId?: string): PhoneCallMission | null {
    const row = agentId
      ? this.db.prepare('SELECT * FROM phone_missions WHERE id = ? AND agent_id = ?').get(missionId, agentId)
      : this.db.prepare('SELECT * FROM phone_missions WHERE id = ?').get(missionId);
    return row ? rowToMission(row) : null;
  }

  listMissions(agentId: string, opts: { limit?: number; offset?: number; status?: PhoneMissionState } = {}): PhoneCallMission[] {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);
    const params: (string | number)[] = [agentId];
    let sql = 'SELECT * FROM phone_missions WHERE agent_id = ?';
    if (opts.status && (PHONE_MISSION_STATES as readonly string[]).includes(opts.status)) {
      sql += ' AND status = ?';
      params.push(opts.status);
    }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    return (this.db.prepare(sql).all(...params) as any[]).map(rowToMission);
  }

  async startMission(
    agentId: string,
    input: StartPhoneMissionInput,
    options: StartPhoneCallOptions = {},
  ): Promise<StartPhoneCallResult> {
    const config = this.getPhoneTransportConfig(agentId);
    if (!config) {
      throw new Error('Phone transport is not configured. Use phone_transport_setup first.');
    }
    if (config.provider !== '46elks') {
      throw new Error(`Phone provider ${config.provider} does not support call_control yet`);
    }

    const validation = validatePhoneMissionStart(input, config);
    if (!validation.ok) {
      throw new Error(`Invalid phone mission: ${validation.issues.map((item) => `${item.code} (${item.field})`).join(', ')}`);
    }

    const now = options.now ?? new Date();
    const missionId = `call_${randomUUID()}`;
    const transcript: PhoneMissionTranscriptEntry[] = [{
      at: now.toISOString(),
      source: 'system',
      text: 'Phone mission created; outbound carrier call requested.',
    }];
    const metadata: Record<string, unknown> = {
      voiceRuntimeRef: validation.mission.voiceRuntimeRef,
      targetRegion: validation.mission.targetRegion,
      dryRun: !!options.dryRun,
    };

    const mission: PhoneCallMission = {
      id: missionId,
      agentId,
      status: 'dialing',
      from: config.phoneNumber,
      to: validation.mission.to,
      task: validation.mission.task,
      policy: validation.mission.policy,
      transport: validation.mission.transport,
      provider: config.provider,
      transcript,
      metadata,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    this.insertMission(mission);

    const providerRequest = this.build46ElksCallRequest(config, mission);
    if (options.dryRun) {
      const updated = this.updateProviderCall(missionId, 'dryrun-call', {
        dryRun: true,
        providerRequest: redactProviderRequest(providerRequest),
      });
      return { mission: updated, providerRequest };
    }

    const fetchFn = options.fetchFn ?? fetch;
    const response = await fetchFn(providerRequest.url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth(config.username, config.password)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(providerRequest.body),
      signal: AbortSignal.timeout(15_000),
    });

    const text = await response.text();
    let raw: unknown = text;
    try {
      raw = JSON.parse(text);
    } catch {
      // Keep provider response as raw text.
    }

    if (!response.ok) {
      const failed = this.updateMissionStatus(missionId, 'failed', {
        providerStatus: response.status,
        providerResponse: raw,
      }, [{
        at: new Date().toISOString(),
        source: 'provider',
        text: `46elks call start failed with HTTP ${response.status}.`,
        metadata: { providerResponse: raw },
      }]);
      throw new Error(`46elks call start failed (${response.status}) for mission ${failed.id}`);
    }

    const providerCallId = asRecord(raw).id ? String(asRecord(raw).id) : undefined;
    const updated = this.updateProviderCall(missionId, providerCallId, { providerResponse: raw });
    return { mission: updated, providerRequest, providerResponse: raw };
  }

  handleVoiceStartWebhook(missionId: string, providedSecret: string, payload: Record<string, unknown> = {}): PhoneWebhookResult {
    const mission = this.getMission(missionId);
    if (!mission) throw new Error('Phone mission not found');
    const config = this.getPhoneTransportConfig(mission.agentId);
    if (!config || !providedSecret || !secretMatches(providedSecret, config.webhookSecret)) {
      throw new Error('Invalid phone webhook secret');
    }

    const updated = this.updateMissionStatus(mission.id, 'connected', {
      lastVoiceStartPayload: payload,
    }, [{
      at: new Date().toISOString(),
      source: 'provider',
      text: '46elks voice_start webhook received. Realtime voice runtime is not connected in this slice.',
      metadata: { payload },
    }]);

    return {
      mission: updated,
      action: {
        play: 'AgenticMail has received this call mission. The live voice runtime is not connected yet; the operator will follow up.',
      },
    };
  }

  handleHangupWebhook(missionId: string, providedSecret: string, payload: Record<string, unknown> = {}): PhoneCallMission {
    const mission = this.getMission(missionId);
    if (!mission) throw new Error('Phone mission not found');
    const config = this.getPhoneTransportConfig(mission.agentId);
    if (!config || !providedSecret || !secretMatches(providedSecret, config.webhookSecret)) {
      throw new Error('Invalid phone webhook secret');
    }

    const terminal: PhoneMissionState[] = ['completed', 'failed', 'cancelled'];
    const nextStatus: PhoneMissionState = terminal.includes(mission.status) ? mission.status : 'failed';
    return this.updateMissionStatus(mission.id, nextStatus, {
      lastHangupPayload: payload,
      hangupReason: nextStatus === 'failed' ? 'call-ended-before-conversation-runtime' : undefined,
    }, [{
      at: new Date().toISOString(),
      source: 'provider',
      text: nextStatus === 'failed'
        ? '46elks hangup webhook received before a conversation runtime completed the mission.'
        : '46elks hangup webhook received.',
      metadata: { payload },
    }]);
  }

  cancelMission(agentId: string, missionId: string): PhoneCallMission {
    const mission = this.getMission(missionId, agentId);
    if (!mission) throw new Error('Phone mission not found');
    return this.updateMissionStatus(mission.id, 'cancelled', {}, [{
      at: new Date().toISOString(),
      source: 'operator',
      text: 'Phone mission cancelled.',
    }]);
  }

  private build46ElksCallRequest(config: PhoneTransportConfig, mission: PhoneCallMission): { url: string; body: Record<string, string> } {
    const timeout = Math.min(Math.max(mission.policy.maxCallDurationSeconds, 1), 86_400);
    return {
      url: `${defaultApiUrl(config)}/calls`,
      body: {
        from: config.phoneNumber,
        to: mission.to,
        voice_start: buildWebhookUrl(config, '/calls/webhook/46elks/voice-start', mission.id),
        whenhangup: buildWebhookUrl(config, '/calls/webhook/46elks/hangup', mission.id),
        timeout: String(timeout),
      },
    };
  }

  private insertMission(mission: PhoneCallMission): void {
    this.db.prepare(`
      INSERT INTO phone_missions (
        id, agent_id, status, from_phone, to_phone, task,
        policy_json, transport_json, provider, provider_call_id,
        transcript_json, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      mission.id,
      mission.agentId,
      mission.status,
      mission.from,
      mission.to,
      mission.task,
      JSON.stringify(mission.policy),
      JSON.stringify(mission.transport),
      mission.provider,
      mission.providerCallId ?? null,
      JSON.stringify(mission.transcript),
      JSON.stringify(mission.metadata),
      mission.createdAt,
      mission.updatedAt,
    );
  }

  private updateProviderCall(missionId: string, providerCallId: string | undefined, metadata: Record<string, unknown>): PhoneCallMission {
    const mission = this.getMission(missionId);
    if (!mission) throw new Error('Phone mission not found');
    const nextMetadata = { ...mission.metadata, ...metadata };
    this.db.prepare(`
      UPDATE phone_missions
      SET provider_call_id = ?, metadata_json = ?, updated_at = ?
      WHERE id = ?
    `).run(providerCallId ?? null, JSON.stringify(nextMetadata), new Date().toISOString(), missionId);
    return this.getMission(missionId)!;
  }

  private updateMissionStatus(
    missionId: string,
    status: PhoneMissionState,
    metadata: Record<string, unknown>,
    transcriptEntries: PhoneMissionTranscriptEntry[] = [],
  ): PhoneCallMission {
    const mission = this.getMission(missionId);
    if (!mission) throw new Error('Phone mission not found');
    const nextTranscript = [...mission.transcript, ...transcriptEntries];
    const nextMetadata = Object.fromEntries(
      Object.entries({ ...mission.metadata, ...metadata }).filter(([, value]) => value !== undefined),
    );
    this.db.prepare(`
      UPDATE phone_missions
      SET status = ?, transcript_json = ?, metadata_json = ?, updated_at = ?
      WHERE id = ?
    `).run(status, JSON.stringify(nextTranscript), JSON.stringify(nextMetadata), new Date().toISOString(), missionId);
    return this.getMission(missionId)!;
  }
}

export function buildPhoneTransportConfig(input: {
  provider?: unknown;
  phoneNumber?: unknown;
  username?: unknown;
  password?: unknown;
  webhookBaseUrl?: unknown;
  webhookSecret?: unknown;
  apiUrl?: unknown;
  capabilities?: unknown;
  supportedRegions?: unknown;
  configuredAt?: string;
}): PhoneTransportConfig {
  const provider = asString(input.provider) || '46elks';
  if (provider !== '46elks') throw new Error('provider must be "46elks"');

  const phoneNumber = normalizePhoneNumber(asString(input.phoneNumber));
  if (!phoneNumber) throw new Error('phoneNumber must be a valid E.164 phone number');

  const username = asString(input.username);
  const password = asString(input.password);
  const webhookBaseUrl = asString(input.webhookBaseUrl);
  const webhookSecret = asString(input.webhookSecret);
  if (!username || !password) throw new Error('username and password are required for provider "46elks"');
  if (!webhookBaseUrl) throw new Error('webhookBaseUrl is required');
  if (!webhookSecret) throw new Error('webhookSecret is required');

  const parsedWebhookBaseUrl = new URL(webhookBaseUrl);
  if (parsedWebhookBaseUrl.protocol !== 'https:' && parsedWebhookBaseUrl.hostname !== '127.0.0.1' && parsedWebhookBaseUrl.hostname !== 'localhost') {
    throw new Error('webhookBaseUrl must use https:// unless it points at localhost');
  }

  const apiUrl = asString(input.apiUrl);
  if (apiUrl) {
    const parsedApiUrl = new URL(apiUrl);
    if (parsedApiUrl.protocol !== 'https:') {
      throw new Error('apiUrl must use https:// — credentials are sent on every request');
    }
  }

  const capabilities: TelephonyTransportCapability[] = Array.isArray(input.capabilities)
    ? input.capabilities.filter((item): item is TelephonyTransportCapability => (
      typeof item === 'string' && ['sms', 'call_control', 'realtime_media', 'recording_supported'].includes(item)
    ))
    : ['call_control'];
  const supportedRegions: PhoneTransportConfig['supportedRegions'] = Array.isArray(input.supportedRegions)
    ? input.supportedRegions.filter((item): item is PhoneTransportConfig['supportedRegions'][number] => (
      typeof item === 'string' && ['AT', 'DE', 'EU', 'WORLD'].includes(item)
    ))
    : ['EU'];

  const config: PhoneTransportConfig = {
    provider,
    phoneNumber,
    username,
    password,
    webhookBaseUrl,
    webhookSecret,
    apiUrl: apiUrl || undefined,
    capabilities: Array.from(new Set<TelephonyTransportCapability>(['call_control', ...capabilities])),
    supportedRegions: supportedRegions.length ? Array.from(new Set<PhoneTransportConfig['supportedRegions'][number]>(supportedRegions)) : ['EU'],
    configuredAt: input.configuredAt ?? new Date().toISOString(),
  };

  const validation = validatePhoneTransportProfile(config);
  if (!validation.ok) {
    throw new Error(`Invalid phone transport config: ${validation.issues.map((item) => `${item.field}: ${item.message}`).join('; ')}`);
  }
  return config;
}

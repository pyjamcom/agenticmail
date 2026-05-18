import { normalizePhoneNumber } from '../sms/manager.js';

export const PHONE_REGION_SCOPES = ['AT', 'DE', 'EU', 'WORLD'] as const;
export type PhoneRegionScope = typeof PHONE_REGION_SCOPES[number];

export const TELEPHONY_TRANSPORT_CAPABILITIES = [
  'sms',
  'call_control',
  'realtime_media',
  'recording_supported',
] as const;
export type TelephonyTransportCapability = typeof TELEPHONY_TRANSPORT_CAPABILITIES[number];

export const PHONE_MISSION_STATES = [
  'draft',
  'approved',
  'dialing',
  'connected',
  'conversing',
  'needs_operator',
  'completed',
  'failed',
  'cancelled',
] as const;
export type PhoneMissionState = typeof PHONE_MISSION_STATES[number];

export type PhoneNumberRisk = 'invalid' | 'standard' | 'premium_or_special';

export interface PhoneConfirmPolicy {
  paymentDetails: 'never';
  contractCommitment: 'never';
  costOverLimit: 'needs_operator';
  sensitivePersonalData: 'needs_operator';
  unclearAlternative: 'needs_operator';
}

export interface PhoneAlternativePolicy {
  maxTimeShiftMinutes: number;
}

export interface OpenClawPhoneMissionPolicy {
  policyVersion: 1;
  regionAllowlist: PhoneRegionScope[];
  maxCallDurationSeconds: number;
  maxCostPerMission: number;
  maxAttempts: number;
  transcriptEnabled: boolean;
  recordingEnabled: boolean;
  confirmPolicy: PhoneConfirmPolicy;
  alternativePolicy: PhoneAlternativePolicy;
}

export interface StartPhoneMissionInput {
  to: string;
  task: string;
  policy: OpenClawPhoneMissionPolicy;
  voiceRuntimeRef?: string;
}

export interface PhoneTransportProfile {
  provider: string;
  phoneNumber: string;
  capabilities: TelephonyTransportCapability[];
  supportedRegions: PhoneRegionScope[];
}

export interface PhoneMissionValidationIssue {
  code: string;
  field: string;
  message: string;
}

export type PhoneMissionValidationResult =
  | { ok: true; policy: OpenClawPhoneMissionPolicy; issues: [] }
  | { ok: false; issues: PhoneMissionValidationIssue[] };

export type PhoneTransportValidationResult =
  | { ok: true; transport: PhoneTransportProfile; issues: [] }
  | { ok: false; issues: PhoneMissionValidationIssue[] };

export interface ValidatedPhoneMissionStart {
  to: string;
  task: string;
  policy: OpenClawPhoneMissionPolicy;
  targetRegion: PhoneRegionScope;
  transport: PhoneTransportProfile;
  voiceRuntimeRef?: string;
}

export type PhoneMissionStartValidationResult =
  | { ok: true; mission: ValidatedPhoneMissionStart; issues: [] }
  | { ok: false; issues: PhoneMissionValidationIssue[] };

const EU_DIAL_PREFIXES = [
  '+30', '+31', '+32', '+33', '+34', '+351', '+352', '+353', '+354', '+356',
  '+357', '+358', '+359', '+36', '+370', '+371', '+372', '+385', '+386', '+39',
  '+40', '+420', '+421', '+43', '+45', '+46', '+48', '+49',
] as const;

const PREMIUM_OR_SPECIAL_PREFIXES = [
  '+1900',
  '+1976',
  '+43810',
  '+43820',
  '+43821',
  '+43828',
  '+43900',
  '+43901',
  '+43930',
  '+43931',
  '+49190',
  '+49900',
] as const;

function issue(code: string, field: string, message: string): PhoneMissionValidationIssue {
  return { code, field, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPhoneRegionScope(value: unknown): value is PhoneRegionScope {
  return typeof value === 'string' && (PHONE_REGION_SCOPES as readonly string[]).includes(value);
}

function isTelephonyTransportCapability(value: unknown): value is TelephonyTransportCapability {
  return typeof value === 'string' && (TELEPHONY_TRANSPORT_CAPABILITIES as readonly string[]).includes(value);
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function readNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function readRegionList(value: unknown): PhoneRegionScope[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const regions = value.filter(isPhoneRegionScope);
  if (regions.length !== value.length) return null;
  return Array.from(new Set(regions));
}

function readCapabilityList(value: unknown): TelephonyTransportCapability[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const capabilities = value.filter(isTelephonyTransportCapability);
  if (capabilities.length !== value.length) return null;
  return Array.from(new Set(capabilities));
}

function validateConfirmPolicy(value: unknown): PhoneMissionValidationIssue[] {
  const issues: PhoneMissionValidationIssue[] = [];
  if (!isRecord(value)) {
    return [issue('confirm-policy-required', 'policy.confirmPolicy', 'confirmPolicy is required')];
  }

  const required: PhoneConfirmPolicy = {
    paymentDetails: 'never',
    contractCommitment: 'never',
    costOverLimit: 'needs_operator',
    sensitivePersonalData: 'needs_operator',
    unclearAlternative: 'needs_operator',
  };

  for (const [field, expected] of Object.entries(required)) {
    if (value[field] !== expected) {
      issues.push(issue(
        'unsafe-confirm-policy',
        `policy.confirmPolicy.${field}`,
        `${field} must be ${expected}`,
      ));
    }
  }

  return issues;
}

function validateAlternativePolicy(value: unknown): PhoneMissionValidationIssue[] {
  if (!isRecord(value)) {
    return [issue('alternative-policy-required', 'policy.alternativePolicy', 'alternativePolicy is required')];
  }
  const maxTimeShiftMinutes = readNonNegativeNumber(value.maxTimeShiftMinutes);
  if (maxTimeShiftMinutes === null || !Number.isInteger(maxTimeShiftMinutes)) {
    return [issue(
      'invalid-alternative-policy',
      'policy.alternativePolicy.maxTimeShiftMinutes',
      'maxTimeShiftMinutes must be a non-negative integer',
    )];
  }
  return [];
}

export function validatePhoneMissionPolicy(policy: unknown): PhoneMissionValidationResult {
  const issues: PhoneMissionValidationIssue[] = [];
  if (!isRecord(policy)) {
    return { ok: false, issues: [issue('policy-required', 'policy', 'policy is required')] };
  }

  if (policy.policyVersion !== 1) {
    issues.push(issue('unsupported-policy-version', 'policy.policyVersion', 'policyVersion must be 1'));
  }

  const regionAllowlist = readRegionList(policy.regionAllowlist);
  if (!regionAllowlist) {
    issues.push(issue('invalid-region-allowlist', 'policy.regionAllowlist', 'regionAllowlist must contain at least one supported region'));
  }

  const maxCallDurationSeconds = readPositiveInteger(policy.maxCallDurationSeconds);
  if (maxCallDurationSeconds === null) {
    issues.push(issue('invalid-max-duration', 'policy.maxCallDurationSeconds', 'maxCallDurationSeconds must be a positive integer'));
  }

  const maxCostPerMission = readNonNegativeNumber(policy.maxCostPerMission);
  if (maxCostPerMission === null) {
    issues.push(issue('invalid-max-cost', 'policy.maxCostPerMission', 'maxCostPerMission must be a non-negative number'));
  }

  const maxAttempts = readPositiveInteger(policy.maxAttempts);
  if (maxAttempts === null) {
    issues.push(issue('invalid-max-attempts', 'policy.maxAttempts', 'maxAttempts must be a positive integer'));
  }

  const transcriptEnabled = readBoolean(policy.transcriptEnabled);
  if (transcriptEnabled === null) {
    issues.push(issue('invalid-transcript-enabled', 'policy.transcriptEnabled', 'transcriptEnabled must be boolean'));
  }

  const recordingEnabled = readBoolean(policy.recordingEnabled);
  if (recordingEnabled === null) {
    issues.push(issue('invalid-recording-enabled', 'policy.recordingEnabled', 'recordingEnabled must be boolean'));
  }

  issues.push(...validateConfirmPolicy(policy.confirmPolicy));
  issues.push(...validateAlternativePolicy(policy.alternativePolicy));

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    policy: {
      policyVersion: 1,
      regionAllowlist: regionAllowlist!,
      maxCallDurationSeconds: maxCallDurationSeconds!,
      maxCostPerMission: maxCostPerMission!,
      maxAttempts: maxAttempts!,
      transcriptEnabled: transcriptEnabled!,
      recordingEnabled: recordingEnabled!,
      confirmPolicy: policy.confirmPolicy as unknown as PhoneConfirmPolicy,
      alternativePolicy: {
        maxTimeShiftMinutes: (policy.alternativePolicy as { maxTimeShiftMinutes: number }).maxTimeShiftMinutes,
      },
    },
    issues: [],
  };
}

export function validatePhoneTransportProfile(transport: unknown): PhoneTransportValidationResult {
  const issues: PhoneMissionValidationIssue[] = [];
  if (!isRecord(transport)) {
    return { ok: false, issues: [issue('transport-required', 'transport', 'transport profile is required')] };
  }

  const provider = typeof transport.provider === 'string' ? transport.provider.trim() : '';
  if (!provider) {
    issues.push(issue('invalid-provider', 'transport.provider', 'provider is required'));
  }

  const phoneNumber = typeof transport.phoneNumber === 'string' ? normalizePhoneNumber(transport.phoneNumber) : null;
  if (!phoneNumber) {
    issues.push(issue('invalid-transport-number', 'transport.phoneNumber', 'transport phoneNumber must be valid E.164'));
  }

  const capabilities = readCapabilityList(transport.capabilities);
  if (!capabilities) {
    issues.push(issue('invalid-capabilities', 'transport.capabilities', 'capabilities must contain supported transport capabilities'));
  } else if (!capabilities.includes('call_control')) {
    issues.push(issue('missing-call-control', 'transport.capabilities', 'transport must support call_control to start phone missions'));
  }

  const supportedRegions = readRegionList(transport.supportedRegions);
  if (!supportedRegions) {
    issues.push(issue('invalid-supported-regions', 'transport.supportedRegions', 'supportedRegions must contain at least one supported region'));
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    transport: {
      provider,
      phoneNumber: phoneNumber!,
      capabilities: capabilities!,
      supportedRegions: supportedRegions!,
    },
    issues: [],
  };
}

export function inferPhoneRegion(phoneNumber: string): PhoneRegionScope | null {
  const normalized = normalizePhoneNumber(phoneNumber);
  if (!normalized) return null;
  if (normalized.startsWith('+43')) return 'AT';
  if (normalized.startsWith('+49')) return 'DE';
  if (EU_DIAL_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return 'EU';
  return 'WORLD';
}

export function isPhoneRegionAllowed(region: PhoneRegionScope, allowlist: readonly PhoneRegionScope[]): boolean {
  if (allowlist.includes('WORLD')) return true;
  if (allowlist.includes(region)) return true;
  if ((region === 'AT' || region === 'DE' || region === 'EU') && allowlist.includes('EU')) return true;
  return false;
}

export function classifyPhoneNumberRisk(phoneNumber: string): PhoneNumberRisk {
  const normalized = normalizePhoneNumber(phoneNumber);
  if (!normalized) return 'invalid';
  if (PREMIUM_OR_SPECIAL_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return 'premium_or_special';
  }
  return 'standard';
}

export function validatePhoneMissionStart(
  input: unknown,
  transport: unknown,
  options: { allowPremiumOrSpecialNumbers?: boolean } = {},
): PhoneMissionStartValidationResult {
  const issues: PhoneMissionValidationIssue[] = [];
  if (!isRecord(input)) {
    return { ok: false, issues: [issue('start-input-required', 'input', 'start input is required')] };
  }

  const to = typeof input.to === 'string' ? normalizePhoneNumber(input.to) : null;
  if (!to) {
    issues.push(issue('invalid-target-number', 'input.to', 'target number must be valid E.164'));
  }

  const task = typeof input.task === 'string' ? input.task.trim() : '';
  if (!task) {
    issues.push(issue('task-required', 'input.task', 'task is required'));
  }

  const policyResult = validatePhoneMissionPolicy(input.policy);
  if (!policyResult.ok) issues.push(...policyResult.issues);

  const transportResult = validatePhoneTransportProfile(transport);
  if (!transportResult.ok) issues.push(...transportResult.issues);

  const risk = typeof input.to === 'string' ? classifyPhoneNumberRisk(input.to) : 'invalid';
  if (risk === 'premium_or_special' && !options.allowPremiumOrSpecialNumbers) {
    issues.push(issue('premium-number-blocked', 'input.to', 'premium or special-rate numbers require an explicit allowlist'));
  }

  const targetRegion = to ? inferPhoneRegion(to) : null;
  if (!targetRegion) {
    issues.push(issue('unknown-target-region', 'input.to', 'target region could not be inferred'));
  }

  if (policyResult.ok && targetRegion && !isPhoneRegionAllowed(targetRegion, policyResult.policy.regionAllowlist)) {
    issues.push(issue('region-not-allowed', 'input.to', 'target number is outside the mission policy regionAllowlist'));
  }

  if (transportResult.ok && targetRegion && !isPhoneRegionAllowed(targetRegion, transportResult.transport.supportedRegions)) {
    issues.push(issue('transport-region-unsupported', 'transport.supportedRegions', 'target number is outside the transport supportedRegions'));
  }

  const capabilities = transportResult.ok ? transportResult.transport.capabilities : [];
  if (policyResult.ok && policyResult.policy.recordingEnabled && !capabilities.includes('recording_supported')) {
    issues.push(issue('recording-unsupported', 'policy.recordingEnabled', 'recordingEnabled requires transport recording_supported capability'));
  }

  if (issues.length > 0 || !policyResult.ok || !transportResult.ok || !to || !targetRegion) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    mission: {
      to,
      task,
      policy: policyResult.policy,
      targetRegion,
      transport: transportResult.transport,
      voiceRuntimeRef: typeof input.voiceRuntimeRef === 'string' && input.voiceRuntimeRef.trim()
        ? input.voiceRuntimeRef.trim()
        : undefined,
    },
    issues: [],
  };
}

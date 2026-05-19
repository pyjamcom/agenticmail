import { describe, expect, it } from 'vitest';
import {
  classifyPhoneNumberRisk,
  inferPhoneRegion,
  isPhoneRegionAllowed,
  validatePhoneMissionPolicy,
  validatePhoneMissionStart,
  validatePhoneTransportProfile,
  type OpenClawPhoneMissionPolicy,
  type PhoneTransportProfile,
} from '../phone/index.js';

const policy: OpenClawPhoneMissionPolicy = {
  policyVersion: 1,
  regionAllowlist: ['AT', 'DE'],
  maxCallDurationSeconds: 900,
  maxCostPerMission: 10,
  maxAttempts: 2,
  transcriptEnabled: true,
  recordingEnabled: false,
  confirmPolicy: {
    paymentDetails: 'never',
    contractCommitment: 'never',
    costOverLimit: 'needs_operator',
    sensitivePersonalData: 'needs_operator',
    unclearAlternative: 'needs_operator',
  },
  alternativePolicy: {
    maxTimeShiftMinutes: 30,
  },
};

const transport: PhoneTransportProfile = {
  provider: '46elks',
  phoneNumber: '+43123456789',
  capabilities: ['sms', 'call_control'],
  supportedRegions: ['AT', 'DE'],
};

describe('phone mission policy validation', () => {
  it('accepts a complete OpenClaw-provided mission policy', () => {
    const result = validatePhoneMissionPolicy(policy);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.confirmPolicy.paymentDetails).toBe('never');
      expect(result.policy.alternativePolicy.maxTimeShiftMinutes).toBe(30);
    }
  });

  it('fails closed for missing or newer policy versions', () => {
    expect(validatePhoneMissionPolicy(null).ok).toBe(false);

    const result = validatePhoneMissionPolicy({ ...policy, policyVersion: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((item) => item.code)).toContain('unsupported-policy-version');
    }
  });

  it('rejects unsafe confirm policies', () => {
    const result = validatePhoneMissionPolicy({
      ...policy,
      confirmPolicy: {
        ...policy.confirmPolicy,
        paymentDetails: 'allowed',
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((item) => item.code)).toContain('unsafe-confirm-policy');
    }
  });
});

describe('phone transport validation', () => {
  it('requires call_control to start phone missions', () => {
    const result = validatePhoneTransportProfile({
      ...transport,
      capabilities: ['sms'],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((item) => item.code)).toContain('missing-call-control');
    }
  });

  it('infers target regions and allows EU umbrella policies', () => {
    expect(inferPhoneRegion('+436641234567')).toBe('AT');
    expect(inferPhoneRegion('+491711234567')).toBe('DE');
    expect(inferPhoneRegion('+46701234567')).toBe('EU');
    expect(inferPhoneRegion('+12125551234')).toBe('WORLD');
    expect(isPhoneRegionAllowed('AT', ['EU'])).toBe(true);
    expect(isPhoneRegionAllowed('WORLD', ['EU'])).toBe(false);
  });
});

describe('phone mission start validation', () => {
  it('normalizes a valid mission start request', () => {
    const result = validatePhoneMissionStart({
      to: '+43 664 1234567',
      task: 'Reserve dinner at 19:30',
      policy,
      voiceRuntimeRef: 'openclaw:voice-default',
    }, transport);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mission.to).toBe('+436641234567');
      expect(result.mission.targetRegion).toBe('AT');
      expect(result.mission.transport.provider).toBe('46elks');
      expect(result.mission.voiceRuntimeRef).toBe('openclaw:voice-default');
    }
  });

  it('rejects targets outside the mission policy region allowlist', () => {
    const result = validatePhoneMissionStart({
      to: '+46701234567',
      task: 'Call Sweden',
      policy,
    }, { ...transport, supportedRegions: ['EU'] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((item) => item.code)).toContain('region-not-allowed');
    }
  });

  it('blocks premium or special-rate numbers unless explicitly allowed', () => {
    expect(classifyPhoneNumberRisk('+491900123456')).toBe('premium_or_special');

    const blocked = validatePhoneMissionStart({
      to: '+491900123456',
      task: 'Call premium line',
      policy,
    }, transport);

    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.issues.map((item) => item.code)).toContain('premium-number-blocked');
    }
  });

  it('requires recording support when mission policy enables recording', () => {
    const result = validatePhoneMissionStart({
      to: '+436641234567',
      task: 'Record this call',
      policy: { ...policy, recordingEnabled: true },
    }, transport);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((item) => item.code)).toContain('recording-unsupported');
    }
  });
});

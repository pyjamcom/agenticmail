import { createHash } from 'node:crypto';

export const SALES_CALL_RELATIONSHIPS = [
  'new_customer',
  'existing_customer',
  'supplier',
  'carrier',
  'other',
] as const;
export type SalesCallRelationship = typeof SALES_CALL_RELATIONSHIPS[number];

export const SALES_CALL_REQUEST_TYPES = ['goods', 'freight', 'service', 'support', 'other'] as const;
export type SalesCallRequestType = typeof SALES_CALL_REQUEST_TYPES[number];

export const SALES_CALL_OUTCOMES = [
  'qualified',
  'needs_follow_up',
  'transferred',
  'not_a_fit',
  'caller_hung_up',
  'incomplete',
] as const;
export type SalesCallOutcome = typeof SALES_CALL_OUTCOMES[number];

export interface SalesCallIntake {
  schemaVersion: 1;
  relationship?: SalesCallRelationship;
  requestType?: SalesCallRequestType;
  language?: string;
  contactName?: string;
  company?: string;
  emailHash?: string;
  emailRedacted?: string;
  callbackPhoneHash?: string;
  callbackPhoneRedacted?: string;
  preferredChannel?: 'phone' | 'email' | 'whatsapp' | 'other';
  requestDescription?: string;
  existingReference?: string;
  issue?: string;
  urgency?: 'low' | 'normal' | 'high' | 'critical';
  goodsDescription?: string;
  manufacturerPartNumber?: string;
  specifications?: string;
  quantity?: number;
  unit?: string;
  deliveryLocation?: string;
  serviceScope?: string;
  serviceLocation?: string;
  freightMode?: 'ocean' | 'air' | 'rail' | 'road' | 'courier' | 'multimodal' | 'unknown';
  origin?: string;
  destination?: string;
  cargoDescription?: string;
  weightKg?: number;
  volumeCbm?: number;
  packageCount?: number;
  packaging?: string;
  equipment?: string;
  cargoReadyDate?: string;
  requiredByDate?: string;
  incoterm?: string;
  budgetAmount?: number;
  budgetCurrency?: string;
  targetRate?: number;
  objections?: string[];
  nextAction?: {
    type: 'manager_follow_up' | 'callback_request' | 'transfer' | 'send_information' | 'none';
    owner?: string;
    dueAt?: string;
    notes?: string;
  };
  summary?: string;
  outcome?: SalesCallOutcome;
  missingFields: string[];
  updatedAt: string;
}

function text(value: unknown, max = 500): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized ? normalized.slice(0, max) : undefined;
}

function number(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function oneOf<T extends readonly string[]>(value: unknown, allowed: T): T[number] | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? value as T[number]
    : undefined;
}

function contactFingerprint(value: string): { hash: string; redacted: string } {
  const normalized = value.trim().toLowerCase();
  const hash = `sha256:${createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
  if (normalized.includes('@')) {
    const [local, domain = ''] = normalized.split('@');
    return { hash, redacted: `${local.slice(0, 2)}***@${domain}` };
  }
  const digits = normalized.replace(/\D/g, '');
  return { hash, redacted: digits.length >= 4 ? `***${digits.slice(-4)}` : '<redacted>' };
}

/** Normalize an untrusted model-produced partial intake update. */
export function normalizeSalesCallIntakePatch(value: unknown): Partial<SalesCallIntake> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const out: Partial<SalesCallIntake> = {};
  out.relationship = oneOf(input.relationship, SALES_CALL_RELATIONSHIPS);
  out.requestType = oneOf(input.requestType, SALES_CALL_REQUEST_TYPES);
  out.language = text(input.language, 32);
  out.contactName = text(input.contactName, 200);
  out.company = text(input.company, 300);
  out.preferredChannel = oneOf(input.preferredChannel, ['phone', 'email', 'whatsapp', 'other'] as const);
  out.requestDescription = text(input.requestDescription, 2000);
  out.existingReference = text(input.existingReference, 300);
  out.issue = text(input.issue, 1500);
  out.urgency = oneOf(input.urgency, ['low', 'normal', 'high', 'critical'] as const);
  out.goodsDescription = text(input.goodsDescription, 1500);
  out.manufacturerPartNumber = text(input.manufacturerPartNumber, 300);
  out.specifications = text(input.specifications, 2000);
  out.quantity = number(input.quantity);
  out.unit = text(input.unit, 80);
  out.deliveryLocation = text(input.deliveryLocation, 500);
  out.serviceScope = text(input.serviceScope, 1500);
  out.serviceLocation = text(input.serviceLocation, 500);
  out.freightMode = oneOf(input.freightMode, ['ocean', 'air', 'rail', 'road', 'courier', 'multimodal', 'unknown'] as const);
  out.origin = text(input.origin, 500);
  out.destination = text(input.destination, 500);
  out.cargoDescription = text(input.cargoDescription, 1000);
  out.weightKg = number(input.weightKg);
  out.volumeCbm = number(input.volumeCbm);
  out.packageCount = number(input.packageCount);
  out.packaging = text(input.packaging, 300);
  out.equipment = text(input.equipment, 300);
  out.cargoReadyDate = text(input.cargoReadyDate, 64);
  out.requiredByDate = text(input.requiredByDate, 64);
  out.incoterm = text(input.incoterm, 32)?.toUpperCase();
  out.budgetAmount = number(input.budgetAmount);
  out.budgetCurrency = text(input.budgetCurrency, 12)?.toUpperCase();
  out.targetRate = number(input.targetRate);
  out.summary = text(input.summary, 3000);
  out.outcome = oneOf(input.outcome, SALES_CALL_OUTCOMES);

  const email = text(input.email, 320);
  if (email) {
    const fingerprint = contactFingerprint(email);
    out.emailHash = fingerprint.hash;
    out.emailRedacted = fingerprint.redacted;
  }
  const phone = text(input.callbackPhone, 64);
  if (phone) {
    const fingerprint = contactFingerprint(phone);
    out.callbackPhoneHash = fingerprint.hash;
    out.callbackPhoneRedacted = fingerprint.redacted;
  }

  if (Array.isArray(input.objections)) {
    out.objections = input.objections.map((item) => text(item, 500)).filter((item): item is string => !!item).slice(0, 20);
  }
  if (input.nextAction && typeof input.nextAction === 'object' && !Array.isArray(input.nextAction)) {
    const action = input.nextAction as Record<string, unknown>;
    const type = oneOf(action.type, ['manager_follow_up', 'callback_request', 'transfer', 'send_information', 'none'] as const);
    if (type) {
      out.nextAction = {
        type,
        owner: text(action.owner, 200),
        dueAt: text(action.dueAt, 64),
        notes: text(action.notes, 1000),
      };
    }
  }

  return Object.fromEntries(Object.entries(out).filter(([, item]) => item !== undefined)) as Partial<SalesCallIntake>;
}

export function getSalesCallIntakeMissingFields(intake: Partial<SalesCallIntake>): string[] {
  const missing: string[] = [];
  if (!intake.relationship) missing.push('relationship');
  if (!intake.requestType) missing.push('requestType');
  if (!intake.requestDescription) missing.push('requestDescription');
  if (!intake.contactName) missing.push('contactName');
  if (!intake.emailHash && !intake.callbackPhoneHash) missing.push('email_or_callbackPhone');

  if (intake.requestType === 'freight') {
    if (!intake.origin) missing.push('origin');
    if (!intake.destination) missing.push('destination');
    if (!intake.cargoDescription) missing.push('cargoDescription');
    if (intake.weightKg === undefined && intake.volumeCbm === undefined) missing.push('weightKg_or_volumeCbm');
    if (!intake.cargoReadyDate) missing.push('cargoReadyDate');
    if (!intake.requiredByDate) missing.push('requiredByDate');
  }
  if (intake.requestType === 'goods') {
    if (!intake.goodsDescription) missing.push('goodsDescription');
    if (intake.quantity === undefined) missing.push('quantity');
    if (!intake.deliveryLocation) missing.push('deliveryLocation');
    if (!intake.requiredByDate) missing.push('requiredByDate');
  }
  if (intake.requestType === 'service') {
    if (!intake.serviceScope) missing.push('serviceScope');
  }
  if (intake.relationship === 'existing_customer') {
    if (!intake.existingReference) missing.push('existingReference');
    if (!intake.issue) missing.push('issue');
  }
  if ((intake.relationship === 'supplier' || intake.relationship === 'carrier') && !intake.company) {
    missing.push('company');
  }
  if (!intake.nextAction) missing.push('nextAction');
  return missing;
}

export function mergeSalesCallIntake(
  current: unknown,
  patch: unknown,
  now = new Date(),
): SalesCallIntake {
  const existing = normalizeSalesCallIntakePatch(current);
  const update = normalizeSalesCallIntakePatch(patch);
  const objections = Array.from(new Set([...(existing.objections ?? []), ...(update.objections ?? [])])).slice(0, 20);
  const merged: Partial<SalesCallIntake> = {
    ...existing,
    ...update,
    ...(objections.length > 0 ? { objections } : {}),
  };
  return {
    ...merged,
    schemaVersion: 1,
    missingFields: getSalesCallIntakeMissingFields(merged),
    updatedAt: now.toISOString(),
  } as SalesCallIntake;
}

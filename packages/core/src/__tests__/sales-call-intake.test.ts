import { describe, expect, it } from 'vitest';
import { mergeSalesCallIntake } from '../phone/sales-intake.js';

describe('sales call intake', () => {
  it('normalizes freight qualification and keeps raw contacts out of metadata', () => {
    const intake = mergeSalesCallIntake({}, {
      relationship: 'new_customer',
      requestType: 'freight',
      serviceTopic: 'ocean_freight',
      contactName: 'Ivan',
      email: 'ivan@example.com',
      callbackPhone: '+7 999 123 4567',
      requestDescription: 'Need container transport',
      origin: 'Shanghai',
      destination: 'Saint Petersburg',
      cargoDescription: 'Machine parts',
      volumeCbm: 28,
      cargoReadyDate: '2026-07-20',
      requiredByDate: '2026-09-01',
      nextAction: { type: 'manager_follow_up' },
    }, new Date('2026-07-10T10:00:00.000Z'));

    expect(intake.missingFields).toEqual([]);
    expect(intake.emailHash).toMatch(/^sha256:/);
    expect(intake.emailRedacted).toBe('iv***@example.com');
    expect(intake.callbackPhoneRedacted).toBe('***4567');
    expect(intake.serviceTopic).toBe('ocean_freight');
    expect(JSON.stringify(intake)).not.toContain('ivan@example.com');
    expect(JSON.stringify(intake)).not.toContain('+7 999 123 4567');
  });

  it('reports branch-specific missing fields for an existing customer', () => {
    const intake = mergeSalesCallIntake({}, {
      relationship: 'existing_customer',
      requestType: 'support',
      serviceTopic: 'existing_case',
      requestDescription: 'Shipment is delayed',
      contactName: 'Client',
      email: 'client@example.com',
    });

    expect(intake.missingFields).toContain('existingReference');
    expect(intake.missingFields).toContain('issue');
    expect(intake.missingFields).toContain('nextAction');
  });

  it('merges objections across incremental updates without duplicates', () => {
    const first = mergeSalesCallIntake({}, { objections: ['Too expensive'] });
    const second = mergeSalesCallIntake(first, { objections: ['Too expensive', 'Long transit'] });
    expect(second.objections).toEqual(['Too expensive', 'Long transit']);
  });

  it('requires the commercial fields needed for a goods request', () => {
    const intake = mergeSalesCallIntake({}, {
      relationship: 'new_customer',
      requestType: 'goods',
      serviceTopic: 'supplier_sourcing',
      requestDescription: 'Needs electronic components',
      contactName: 'Buyer',
      email: 'buyer@example.com',
      goodsDescription: 'RF filters',
      quantity: 500,
      unit: 'pcs',
      deliveryLocation: 'Saint Petersburg',
      requiredByDate: '2026-08-20',
      nextAction: { type: 'manager_follow_up' },
    });
    expect(intake.missingFields).toEqual([]);
    expect(intake.quantity).toBe(500);
  });
});

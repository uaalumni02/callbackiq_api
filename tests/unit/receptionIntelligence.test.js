import { getTradeReceptionGuidance, normalizeReceptionTrade, TRADE_RECEPTION_GUIDANCE } from '../../src/services/trades/receptionIntelligence.service.js';

describe('Industry reception guidance (advisory and fail-closed)', () => {
  test('covers all 8 supported home-service trades', () => {
    expect(Object.keys(TRADE_RECEPTION_GUIDANCE).sort()).toEqual([
      'electrical', 'garage_door', 'hvac', 'landscaping', 'locksmith', 'plumbing', 'restoration', 'roofing',
    ]);
  });
  test('unknown categories do not authorize unsupported services', () => {
    expect(getTradeReceptionGuidance({ businessType: 'unknown' }).profiles).toEqual([]);
    expect(normalizeReceptionTrade('__proto__')).toBe('');
  });
  test('deduplicates configured trade and active service categories', () => {
    const guidance = getTradeReceptionGuidance({ businessType: 'plumber', services: [
      { active: true, category: 'plumbing' }, { active: true, category: 'roofing' }, { active: false, category: 'electrical' },
    ] });
    expect(guidance.profiles.map(item => item.trade)).toEqual(['plumbing', 'roofing']);
    expect(guidance.policy.booking).toMatch(/not a confirmed appointment/);
    expect(guidance.policy.staffFollowUp).toMatch(/do not offer a live phone transfer/i);
  });
  test('includes safety cautions but no made-up dispatch permission', () => {
    for (const profile of Object.values(TRADE_RECEPTION_GUIDANCE)) {
      expect(profile.intake.length).toBeGreaterThan(1);
      expect(profile.caution).toBeTruthy();
    }
    expect(getTradeReceptionGuidance({ businessType: 'hvac' }).allowedCommitments).toMatch(/None beyond/);
  });
});

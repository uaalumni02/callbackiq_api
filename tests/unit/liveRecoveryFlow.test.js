import { extractService } from '../../src/services/messaging/smsIntentClassifier.service.js';
import { ordinaryReview, serviceEligibilityReview } from '../../src/services/businessRequestWorkflow.service.js';

describe('Oct 27 real-customer missed-call recovery regression', () => {
  test('real equipment problem outranks an anaphoric capability question', () => {
    const message = 'Hey. I just called. My kitchen sink is backed up and draining really slow. Is this something you guys can fix?';
    const extracted = extractService(message);
    expect(extracted.toLowerCase()).toContain('kitchen sink');
    expect(extracted).not.toMatch(/^is this something/i);
  });

  test('customer agreement to previous work does not replace service', () => {
    const prior = { serviceNeeded: 'My kitchen sink is backed up and draining slowly' };
    expect(extractService('Okay please send my request to the office for Friday afternoon. I definitely want to get both sinks fixed.', { lead: prior })).toBe('');
  });

  test('a distinct second service can still be identified', () => {
    const prior = { serviceNeeded: 'My kitchen sink is backed up' };
    const next = extractService('Also, the upstairs bathroom sink is draining slowly. Could someone look at both while here?', { lead: prior });
    expect(next.toLowerCase()).toContain('bathroom sink');
  });

  test('an actionable service review participates in ordinary staff workflow', () => {
    const review = { type: 'system', actionRequired: true, dedupeKey: 'service-eligibility:conversation:hash',
      metadata: { serviceEligibilityReason: 'catalog_incomplete' } };
    expect(serviceEligibilityReview(review)).toBe(true);
    expect(ordinaryReview(review)).toBe(true);
    expect(ordinaryReview({ ...review, actionRequired: false })).toBe(false);
    expect(ordinaryReview({ ...review, metadata: { serviceEligibilityReason: 'catalog_incomplete', messageCategory: 'emergency' } })).toBe(false);
  });
});

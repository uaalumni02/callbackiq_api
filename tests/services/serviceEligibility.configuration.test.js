import { operationsSettingsSchema } from '../../src/validator/businessConfiguration.js';
import Operations from '../../src/models/businessOperationsSettings.js';
import Lead from '../../src/models/lead.js';
import Conversation from '../../src/models/conversation.js';
test('catalog completeness and business exclusions survive request validation and model serialization', async () => {
  const input = { serviceEligibilityPolicy: { catalogComplete: true, excludedServices: [' roof repair ', 'septic pumping'] } };
  const value = await operationsSettingsSchema.validateAsync(input, { stripUnknown: true });
  const doc = new Operations({ business: '507f1f77bcf86cd799439011', ...value });
  expect(doc.toObject().serviceEligibilityPolicy).toEqual({ catalogComplete: true, excludedServices: ['roof repair', 'septic pumping'] });
  expect(new Operations().serviceEligibilityPolicy.catalogComplete).toBe(false);
});
test('policy input is bounded and cannot smuggle tenant ownership', async () => {
  await expect(operationsSettingsSchema.validateAsync({ serviceEligibilityPolicy: { catalogComplete: true, excludedServices: Array(51).fill('roof') } })).rejects.toBeDefined();
  const value = await operationsSettingsSchema.validateAsync({ business: 'foreign', serviceEligibilityPolicy: { catalogComplete: false, excludedServices: [] } }, { stripUnknown: true });
  expect(value.business).toBeUndefined();
});
test('eligibility is persisted distinctly from customer lifecycle and appointment state', () => {
  const state = { decision: 'unsupported', reason: 'explicit_business_exclusion', request: 'roof repair' };
  expect(new Lead({ serviceEligibility: state }).toObject().serviceEligibility).toEqual(state);
  expect(new Conversation({ serviceEligibility: state }).toObject().serviceEligibility).toEqual(state);
});

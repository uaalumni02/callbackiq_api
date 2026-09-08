import { classifySmsIntent, extractService } from '../../src/services/messaging/smsIntentClassifier.service.js';
import { evaluateSmsTurnPolicy, pricingReply } from '../../src/services/messaging/smsTurnPolicy.service.js';

const business = { businessType: 'plumbing', timezone: 'America/New_York', features: { aiBookingEnabled: false } };

describe('customer service facts and contextual price response', () => {
  test.each([
    ['My bathtub needs resealing. How much is the cost', 'My bathtub needs resealing'],
    ['Bathtub needs resealing', 'Bathtub needs resealing'],
    ['How much to reseal my bathtub?', 'reseal my bathtub'],
    ['How much is bathtub resealing?', 'bathtub resealing'],
    ['Seal around tube needs to be replaced', 'Seal around tube needs to be replaced'],
    ['My awning keeps rattling. How much is a repair?', 'My awning keeps rattling'],
    ['I need the hedges trimmed', 'the hedges trimmed'],
    ['My thermostat stopped working and can you come tomorrow?', 'My thermostat stopped working'],
  ])('captures concrete facts without requiring a supported-service keyword: %s', (text, expected) => {
    expect(extractService(text)).toBe(expected);
  });

  test.each(['How much does it cost?', 'I have an appointment tomorrow', 'My address is 123 Main St', '30303', 'I need to reschedule my appointment', 'I have a quote', 'Where is my technician?', 'Tomorrow morning', 'I need to know the price', 'It is broken'])('does not turn another slot or intent into a service: %s', text => {
    expect(extractService(text)).toBe('');
  });

  test('preserves multiple intents and immediately uses the service in pricing', () => {
    const customerMessage = 'My bathtub needs resealing. How much is the cost';
    const classified = classifySmsIntent({ customerMessage, business });
    expect(classified.intents).toMatchObject({ service: true, pricing: true });
    const policy = evaluateSmsTurnPolicy({ customerMessage, business });
    expect(policy.directResult.serviceNeeded).toBe('bathtub needs resealing');
    expect(policy.directResult.reply).toMatch(/bathtub needs resealing/);
    expect(policy.directResult.reply).not.toMatch(/what service|overflowing|\$/i);
  });

  test('uses a known referent without silently guessing one', () => {
    const lead = { serviceNeeded: 'bathtub resealing' };
    expect(extractService('Seal around tube needs to be replaced', { lead })).toContain('around tub');
    expect(extractService('It is leaking', { lead })).toBe('bathtub resealing: It is leaking');
    expect(extractService('Seal around tube needs to be replaced')).toContain('tube');
  });

  test('non-plumbing pricing asks a relevant question without inventing a quote', () => {
    const reply = pricingReply({ business: { businessType: 'hvac', estimatedJobValue: 1200 }, lead: { serviceNeeded: 'thermostat not working' } });
    expect(reply).toMatch(/thermostat/);
    expect(reply).not.toMatch(/leak|overflow|fixture|1200|\$/i);
    expect(reply).toMatch(/usable/);
  });
});

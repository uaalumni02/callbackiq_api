import ServiceOffering from '../../src/models/serviceOffering.js';
import { getApprovedServiceEstimate } from '../../src/services/booking/approvedServiceEstimate.service.js';

jest.mock('../../src/models/serviceOffering.js', () => ({ __esModule: true, default: { find: jest.fn() } }));
const offering = overrides => ({ business: 'business-a', name: 'Bathtub resealing', keywords: ['recaulking'], excludedKeywords: ['fiberglass repair'], active: true, aiCanDiscuss: true, aiCanBook: false, disclosePriceEstimate: true, priceEstimateMin: 125, priceEstimateMax: 250, ...overrides });
const query = { businessId: 'business-a', serviceNeeded: 'My bathtub needs recaulking' };
let select;
let lean;
beforeEach(() => {
  lean = jest.fn().mockResolvedValue([offering()]);
  select = jest.fn().mockReturnValue({ lean });
  ServiceOffering.find.mockReturnValue({ select });
  ServiceOffering.find.mockClear();
});

test('quotes approved discussable service independently of bookability, with mandatory limitation', async () => {
  const reply = await getApprovedServiceEstimate(query);
  expect(reply).toContain('$125-$250');
  expect(reply).toContain('rough estimate');
  expect(reply).toContain('Final pricing depends');
  expect(ServiceOffering.find).toHaveBeenCalledWith({ business: 'business-a', active: true, aiCanDiscuss: true });
  expect(select.mock.calls[0][0]).not.toContain('estimatedValue');
});

test.each([
  ['unrelated singleton', [offering()], 'Repair my roof'],
  ['excluded singleton', [offering()], 'Recaulking and fiberglass repair'],
  ['substring false positive', [offering({ keywords: ['seal'], name: 'Seal replacement' })], 'resealing'],
  ['ambiguous matches', [offering(), offering({ name: 'Shower service' })], 'recaulking'],
  ['ambiguous undisclosed competitor', [offering(), offering({ name: 'Shower service', disclosePriceEstimate: false })], 'recaulking'],
  ['cross tenant response', [offering({ business: 'business-b' })], 'recaulking'],
  ['inactive response', [offering({ active: false })], 'recaulking'],
  ['discussion disabled', [offering({ aiCanDiscuss: false })], 'recaulking'],
])('does not disclose a price for %s', async (_, records, serviceNeeded) => {
  lean.mockResolvedValue(records);
  expect(await getApprovedServiceEstimate({ ...query, serviceNeeded })).toBe('');
});

test.each([
  { disclosePriceEstimate: false }, { disclosePriceEstimate: 'true' },
  { priceEstimateMin: null }, { priceEstimateMax: undefined },
  { priceEstimateMin: '125' }, { priceEstimateMax: Infinity },
  { priceEstimateMin: NaN }, { priceEstimateMin: -1 },
  { priceEstimateMin: 500, priceEstimateMax: 100 },
  { priceEstimateMin: null, priceEstimateMax: null, estimatedValue: 1000 },
])('rejects unapproved or invalid range %j', async override => {
  lean.mockResolvedValue([offering(override)]);
  expect(await getApprovedServiceEstimate(query)).toBe('');
});

test('normalizes punctuation and checks exclusions in the current customer message', async () => {
  expect(await getApprovedServiceEstimate({ ...query, serviceNeeded: 'BATHTUB: RESEALING!' })).toContain('$125-$250');
  expect(await getApprovedServiceEstimate({ ...query, customerMessage: 'It also needs fiberglass repair.' })).toBe('');
});

test.each([
  [{ discloseDiagnosticFee: true, diagnosticFee: 49.5 }, true],
  [{ discloseDiagnosticFee: false, diagnosticFee: 49.5 }, false],
  [{ discloseDiagnosticFee: 'true', diagnosticFee: 49.5 }, false],
  [{ discloseDiagnosticFee: true, diagnosticFee: -5 }, false],
  [{ discloseDiagnosticFee: true, diagnosticFee: '49.50' }, false],
])('discloses diagnostic fee only on explicit approval and valid number', async (fields, disclosed) => {
  lean.mockResolvedValue([offering(fields)]);
  expect((await getApprovedServiceEstimate(query)).includes('service-call fee')).toBe(disclosed);
});

test('equal bounds remain explicitly approximate and zero is a valid configured amount', async () => {
  lean.mockResolvedValue([offering({ priceEstimateMin: 0, priceEstimateMax: 0 })]);
  expect(await getApprovedServiceEstimate(query)).toContain('rough estimate is about $0');
});

test('missing tenant or request does not query catalog', async () => {
  expect(await getApprovedServiceEstimate()).toBe('');
  expect(await getApprovedServiceEstimate({ businessId: 'business-a' })).toBe('');
  expect(ServiceOffering.find).not.toHaveBeenCalled();
});

test('database errors propagate for caller to degrade without inventing a quote', async () => {
  lean.mockRejectedValue(new Error('catalog unavailable'));
  await expect(getApprovedServiceEstimate(query)).rejects.toThrow('catalog unavailable');
});

test.each([
 ['plumbing', 'Bathtub drain clearing', 'clogged bathtub', 'My bath tub is clogged'],
 ['hvac', 'AC diagnostic', 'warm air', 'The air is warm'],
 ['electrical', 'Outlet diagnostic', 'outlet repair', 'I need repair for the outlet'],
 ['roofing', 'Roof inspection', 'missing shingles', 'The shingles are missing'],
 ['restoration', 'Water damage inspection', 'water damage', 'I have water damage'],
 ['garage_door', 'Garage door diagnostic', 'garage door', 'My garage door is stuck'],
 ['locksmith', 'Door lock service', 'lock replacement', 'I need replacement of the lock'],
 ['landscaping', 'Hedge trimming', 'hedge trimming', 'I need trimming for the hedge'],
])('%s uses approved phrases despite natural customer word order', async (_trade, name, keyword, serviceNeeded) => {
 lean.mockResolvedValue([offering({ name, keywords: [keyword] })]);
 expect(await getApprovedServiceEstimate({ ...query, serviceNeeded })).toContain('$125-$250');
});
test('an explicitly disclosed diagnostic fee works without a repair-price range', async () => {
 lean.mockResolvedValue([offering({ disclosePriceEstimate: false, priceEstimateMin: null, priceEstimateMax: null, diagnosticFee: 75, discloseDiagnosticFee: true })]);
 const reply = await getApprovedServiceEstimate({ ...query, customerMessage: 'What is the service-call fee?' });
 expect(reply).toContain('$75'); expect(reply).toContain('not the total repair price');
});

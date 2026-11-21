import { tradeDetectionCases, multiTradeCases } from '../fixtures/multiTradeCases.js';
import { detectServiceTrades } from '../../src/services/trades/tradeProfiles.service.js';
import { detectSafetyHazardType } from '../../src/helpers/ai/safetyHazardPolicy.js';

test.each(tradeDetectionCases)('$trade: $request',row=>{
 expect(detectServiceTrades(row.request)).toEqual(row.expected);
 if (Object.hasOwn(row,'hazardExpected')) expect(detectSafetyHazardType(row.request)).toBe(row.hazardExpected);
});
test('journeys use the first case per trade without multiplying vocabulary combinations',()=>{
 expect(new Set(multiTradeCases.map(row=>row.trade)).size).toBe(12);
 for(const row of multiTradeCases) expect(tradeDetectionCases.find(item=>item.trade===row.trade)).toBe(row);
 for(const trade of multiTradeCases.map(row=>row.trade)) expect(tradeDetectionCases.filter(row=>row.trade===trade).length).toBeGreaterThanOrEqual(['plumbing','hvac','electrical','roofing'].includes(trade)?20:6);
 expect(tradeDetectionCases.filter(row=>row.trade==='ambiguous').length).toBeGreaterThanOrEqual(10);
});

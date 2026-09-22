import errorHandler from '../../src/middleware/error-handler.js';
import { databaseUnavailable } from '../../src/services/scale/queryBudget.js';
import { extractService } from '../../src/services/messaging/smsIntentClassifier.service.js';
jest.mock('../../src/services/monitoring.service.js', () => ({ __esModule: true, default: { captureError: jest.fn() } }));
test.each(['MongoNetworkTimeoutError', 'MongoPoolClearedError', 'MongoServerSelectionError'])('reports %s as unavailable, with a traceable request', name => {
  const res = { status: jest.fn().mockReturnThis(), set: jest.fn().mockReturnThis(), json: jest.fn() };
  errorHandler(Object.assign(new Error('internal host must not be returned'), { name }), { context: { requestId: 'trace-1' }, path: '/api/messages', method: 'GET' }, res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(503);
  expect(res.set).toHaveBeenCalledWith('Retry-After', '2');
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, code: 'DATABASE_UNAVAILABLE', requestId: 'trace-1' }));
  expect(JSON.stringify(res.json.mock.calls)).not.toContain('internal host');
});
test('does not classify validation or programming failures as a database outage', () => {
  expect(databaseUnavailable(new Error('invalid request'))).toBe(false);
  const cyclic = new Error('cycle'); cyclic.cause = cyclic;
  expect(databaseUnavailable(cyclic)).toBe(false);
});
test.each(["I have a leaking pipe aren't you a plumbing company?", "I have a leaking pipe don’t you handle plumbing?"])( 'separates service from a customer challenge: %s', text => {
  const service = extractService(text);
  expect(service).toMatch(/leaking pipe/i);
  expect(service).not.toMatch(/aren|don.t|company|handle/i);
});

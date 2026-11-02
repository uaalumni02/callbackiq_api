/**
 * Source-equivalent behavioral coverage for the three uncovered extracted-Db paths.
 * No real database, business deletion, network, or customer messages are invoked.
 */
import { createDbalerts1Methods } from '../../src/db/repositories/extracted/alerts-1.js';
import { createDbbusiness1Methods } from '../../src/db/repositories/extracted/business-1.js';
import { createDbidentity1Methods } from '../../src/db/repositories/extracted/identity-1.js';
import { deleteBusinessSafely } from '../../src/services/businessDeletion.service.js';

jest.mock('../../src/services/businessDeletion.service.js', () => ({
  __esModule: true,
  deleteBusinessSafely: jest.fn(),
}));

beforeEach(() => jest.clearAllMocks());

function collector() {
  const errors = [];
  return { errors, safeConsole: { error: (...args) => errors.push(args) } };
}

test('markAllAlertsAsRead defaults to a real timestamp and scopes its update to the business', async () => {
  const { safeConsole, errors } = collector();
  const result = { matchedCount: 2, modifiedCount: 2 };
  const model = { updateMany: jest.fn().mockResolvedValue(result) };
  const methods = createDbalerts1Methods({ safeConsole });
  const before = Date.now();
  const returned = await methods.markAllAlertsAsRead(model, 'business-scope-1');
  const after = Date.now();

  expect(returned).toBe(result);
  expect(model.updateMany).toHaveBeenCalledTimes(1);
  const [filter, update] = model.updateMany.mock.calls[0];
  expect(filter).toEqual({ business: 'business-scope-1', readAt: null });
  expect(update.$set.status).toBe('read');
  expect(update.$set.readAt).toBeInstanceOf(Date);
  expect(update.$set.readAt.getTime()).toBeGreaterThanOrEqual(before);
  expect(update.$set.readAt.getTime()).toBeLessThanOrEqual(after);
  expect(errors).toHaveLength(0);
});

test.each([null, undefined, ''])('findUserByLogin normalizes missing login %s without querying another identity', async login => {
  const { safeConsole, errors } = collector();
  const result = { _id: 'nobody' };
  const select = jest.fn().mockResolvedValue(result);
  const model = { findOne: jest.fn(() => ({ select })) };
  const methods = createDbidentity1Methods({ safeConsole });

  await expect(methods.findUserByLogin(model, login)).resolves.toBe(result);
  expect(model.findOne).toHaveBeenCalledTimes(1);
  expect(model.findOne).toHaveBeenCalledWith({ $or: [
    { userName: '' }, { email: '' },
  ] });
  expect(select).toHaveBeenCalledTimes(1);
  expect(select.mock.calls[0][0]).toContain('+password');
  expect(select.mock.calls[0][0]).toContain('+sessionVersion');
  expect(errors).toHaveLength(0);
});

test('deleteBusinessByOwner delegates only the owner identifier to the existing deletion service', async () => {
  const { safeConsole, errors } = collector();
  const expected = { deleted: true, scope: 'owner' };
  deleteBusinessSafely.mockResolvedValueOnce(expected);
  const methods = createDbbusiness1Methods({ safeConsole, BUSINESS_SCOPE_FIELDS: '_id owner' });
  const model = { findOneAndDelete: jest.fn() };

  await expect(methods.deleteBusinessByOwner(model, 'owner-123')).resolves.toBe(expected);
  expect(deleteBusinessSafely).toHaveBeenCalledTimes(1);
  expect(deleteBusinessSafely).toHaveBeenCalledWith({ ownerId: 'owner-123' });
  expect(model.findOneAndDelete).not.toHaveBeenCalled();
  expect(errors).toHaveLength(0);
});

test('deleteBusiness delegates only the business identifier to the existing deletion service', async () => {
  const { safeConsole, errors } = collector();
  const expected = { deleted: true, scope: 'business' };
  deleteBusinessSafely.mockResolvedValueOnce(expected);
  const methods = createDbbusiness1Methods({ safeConsole, BUSINESS_SCOPE_FIELDS: '_id owner' });
  const model = { deleteMany: jest.fn() };

  await expect(methods.deleteBusiness(model, 'business-456')).resolves.toBe(expected);
  expect(deleteBusinessSafely).toHaveBeenCalledTimes(1);
  expect(deleteBusinessSafely).toHaveBeenCalledWith({ businessId: 'business-456' });
  expect(model.deleteMany).not.toHaveBeenCalled();
  expect(errors).toHaveLength(0);
});

test.each([
  ['deleteBusinessByOwner', 'owner-123', { ownerId: 'owner-123' }],
  ['deleteBusiness', 'business-456', { businessId: 'business-456' }],
])('%s propagates deletion failure and logs exactly once', async (method, id, scope) => {
  const { safeConsole, errors } = collector();
  const failure = new Error('business deletion refused');
  deleteBusinessSafely.mockRejectedValueOnce(failure);
  const methods = createDbbusiness1Methods({ safeConsole, BUSINESS_SCOPE_FIELDS: '_id owner' });

  await expect(methods[method]({}, id)).rejects.toBe(failure);
  expect(deleteBusinessSafely).toHaveBeenCalledTimes(1);
  expect(deleteBusinessSafely).toHaveBeenCalledWith(scope);
  expect(errors).toHaveLength(1);
  expect(errors[0][1]).toBe(failure);
});

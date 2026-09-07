import User from '../../src/models/user.js';
import Business from '../../src/models/business.js';
import { revalidateSocketSessions, enforceSocketExpiry } from '../../src/services/socketSession.service.js';
const query = value => ({ select: () => ({ lean: () => Promise.resolve(value) }) });
const makeSocket = overrides => ({ data: { user: { userId: 'u', role: 'business' }, sessionVersion: 2, businessId: 'b', tokenExpiresAt: Date.now() + 60000, ...overrides }, disconnect: jest.fn(), once: jest.fn() });
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
test.each(['version', 'owner', 'inactive', 'role', 'deleted'])('existing sockets are revoked after %s changes', async change => {
  const user = { _id: 'u', role: change === 'role' ? 'admin' : 'business', sessionVersion: change === 'version' ? 3 : 2 };
  jest.spyOn(User, 'find').mockReturnValue(query(change === 'deleted' ? [] : [user]));
  jest.spyOn(Business, 'find').mockReturnValue(query([{ _id: 'b', owner: change === 'owner' ? 'other' : 'u', isActive: change !== 'inactive' }]));
  const socket = makeSocket();
  await revalidateSocketSessions({ of: () => ({ sockets: new Map([['s', socket]]) }) });
  expect(socket.disconnect).toHaveBeenCalledWith(true);
});
test('valid sessions remain connected and database failure closes access', async () => {
  jest.spyOn(User, 'find').mockReturnValue(query([{ _id: 'u', role: 'business', sessionVersion: 2 }]));
  jest.spyOn(Business, 'find').mockReturnValue(query([{ _id: 'b', owner: 'u', isActive: true }]));
  const socket = makeSocket(); const io = { of: () => ({ sockets: new Map([['s', socket]]) }) };
  await revalidateSocketSessions(io); expect(socket.disconnect).not.toHaveBeenCalled();
  User.find.mockImplementation(() => { throw new Error('unavailable'); });
  await revalidateSocketSessions(io); expect(socket.disconnect).toHaveBeenCalledWith(true);
});
test('token expiration closes an already established socket without another client request', () => {
  jest.useFakeTimers(); const socket = makeSocket({ tokenExpiresAt: Date.now() + 1000 });
  enforceSocketExpiry(socket); jest.advanceTimersByTime(1000);
  expect(socket.disconnect).toHaveBeenCalledWith(true);
});

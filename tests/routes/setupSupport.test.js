import { randomUUID } from 'node:crypto';
import request from 'supertest';
import app from '../../src/app.js';
import User from '../../src/models/user.js';
import Business from '../../src/models/business.js';
import SupportTicket from '../../src/models/supportTicket.js';
import Token from '../../src/helpers/jwt/token.js';
import SocketService from '../../src/services/socket.service.js';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testReplicaDb.js';

beforeAll(connectTestDB, 60000);
afterEach(async () => { jest.restoreAllMocks(); await clearTestDB(); });
afterAll(closeTestDB);
const payload = () => ({ requestId: randomUUID(), businessName: 'Bell Plumbing', forwardingPhone: '(404) 555-1234', message: 'This is my existing business number.' });
async function account(role = 'owner') {
  const user = await User.create({ userName: `test${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    email: `${randomUUID()}@example.com`, password: 'synthetic-password', businessName: 'Setup account', role });
  const token = Token.sign({ userId: String(user._id), sessionVersion: 0, mfaVerified: role === 'admin', authTime: Math.floor(Date.now() / 1000) });
  return { user, token };
}
const send = (token, body) => request(app).post('/api/support/setup-tickets').set('Authorization', `Bearer ${token}`).send(body);

test('setup help requires authentication', async () => {
  expect((await request(app).post('/api/support/setup-tickets').send(payload())).status).toBe(401);
});

test('an empty request body returns a validation error', async () => {
  const owner = await account();
  expect((await request(app).post('/api/support/setup-tickets').set('Authorization', `Bearer ${owner.token}`)).status).toBe(400);
});

test('a user without a business can submit; an admin can see and resolve the request', async () => {
  const owner = await account();
  const emit = jest.spyOn(SocketService, 'emitToAdmins').mockReturnValue(true);
  const body = payload();
  const response = await send(owner.token, body);
  expect(response.status).toBe(201);
  expect(response.body.data.replyEmail).toBe(owner.user.email);
  expect(Object.keys(response.body.data).sort()).toEqual(['_id', 'replyEmail', 'status']);
  const saved = await SupportTicket.findById(response.body.data._id);
  expect(saved.user.toString()).toBe(owner.user.id);
  expect(saved.business).toBeUndefined();
  expect(saved.setupContext.forwardingPhone).toBe(body.forwardingPhone);
  expect(await Business.countDocuments()).toBe(0);
  expect(emit).toHaveBeenCalledWith('admin:dashboard:refresh', { reason: 'support_ticket_created', ticketId: saved.id });
  const admin = await account('admin');
  const queue = await request(app).get('/api/admin/support/tickets').set('Authorization', `Bearer ${admin.token}`);
  expect(queue.status).toBe(200);
  expect(queue.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'setup', setupContext: expect.objectContaining({ replyEmail: owner.user.email }) })]));
  const update = await request(app).patch(`/api/admin/support/tickets/${saved.id}`)
    .set('Authorization', `Bearer ${admin.token}`).send({ status: 'resolved', adminNotes: 'Responded by email.' });
  expect(update.status).toBe(200);
  expect(update.body.data.status).toBe('resolved');
  const replay = await send(owner.token, body);
  expect(replay.status).toBe(200);
  expect(replay.body.data.status).toBe('resolved');
  expect(replay.body.data.adminNotes).toBeUndefined();
});

test('concurrent and uncertain retries create one durable request', async () => {
  const owner = await account(); const body = payload();
  jest.spyOn(SocketService, 'emitToAdmins').mockReturnValue(false);
  const results = await Promise.all(Array.from({ length: 6 }, () => send(owner.token, body)));
  expect(results.map(r => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
  expect(new Set(results.map(r => r.body.data._id)).size).toBe(1);
  expect(await SupportTicket.countDocuments()).toBe(1);
  expect((await send(owner.token, { ...body, message: 'Changed details' })).status).toBe(409);
});

test('accounts cannot impersonate a business or email, or read another account request', async () => {
  const owner = await account(); const other = await account(); const body = payload();
  expect((await send(owner.token, { ...body, business: other.user.id, replyEmail: 'spoof@example.com' })).status).toBe(400);
  const first = await send(owner.token, body);
  const second = await send(other.token, body);
  expect(first.body.data._id).not.toBe(second.body.data._id);
  const read = await request(app).get(`/api/support/tickets/${first.body.data._id}`).set('Authorization', `Bearer ${other.token}`);
  expect(read.body.success).toBe(false);
  const queue = await request(app).get('/api/admin/support/tickets').set('Authorization', `Bearer ${other.token}`);
  // Customer access rejects an account with no business before the admin guard.
  expect(queue.status).toBe(400);
  expect(queue.body.success).toBe(false);
  expect(queue.body.data).toBeUndefined();
});

test('save failures are retryable and do not notify; socket failure cannot undo a saved request', async () => {
  const owner = await account(); const body = payload();
  const emit = jest.spyOn(SocketService, 'emitToAdmins').mockReturnValue(true);
  jest.spyOn(SupportTicket, 'create').mockRejectedValueOnce(new Error('write unavailable'));
  expect((await send(owner.token, body)).status).toBe(503);
  expect(emit).not.toHaveBeenCalled();
  emit.mockImplementation(() => { throw new Error('socket unavailable'); });
  expect((await send(owner.token, body)).status).toBe(201);
  expect(await SupportTicket.countDocuments()).toBe(1);
});

test.each([
  { forwardingPhone: '<script>' }, { businessName: ' ' }, { message: 'x'.repeat(2001) }, { requestId: 'not-a-uuid' },
])('invalid setup details are rejected: %p', async override => {
  const owner = await account();
  expect((await send(owner.token, { ...payload(), ...override })).status).toBe(400);
  expect(await SupportTicket.countDocuments()).toBe(0);
});

test('ordinary account tickets still require a business', () => {
  const ticket = new SupportTicket({ user: '507f1f77bcf86cd799439011', subject: 'Account help', message: 'Help' });
  expect(ticket.validateSync().errors.business).toBeDefined();
});

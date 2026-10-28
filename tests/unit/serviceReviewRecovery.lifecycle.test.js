import {
  serviceReviewKey, serviceReviewNeedsRepair, reconcileServiceReviewPage,
} from '../../src/services/serviceEligibility/serviceReviewRecovery.service.js';
import Conversation from '../../src/models/conversation.js';
import Alert from '../../src/models/alert.js';
import AlertService from '../../src/services/alert.service.js';

jest.mock('../../src/models/conversation.js', () => ({ __esModule: true, default: { find: jest.fn() } }));
jest.mock('../../src/models/alert.js', () => ({ __esModule: true, default: { exists: jest.fn() } }));
jest.mock('../../src/services/alert.service.js', () => ({ __esModule: true, default: { create: jest.fn() } }));

const row = () => ({
  _id: 'c1', business: 'b1', lead: 'l1', status: 'open',
  serviceEligibility: { decision: 'needs_staff_review', reviewSubmitted: true,
    reason: 'catalog_incomplete', request: 'Sink draining slowly' },
  bookingState: { status: 'not_started' }, conversationMemory: { recoveryIntake: {} },
});
const query = entries => ({sort() {return this;},limit() {return this;},
  select() {return this;},lean: async () => entries});

beforeEach(() => {
  jest.clearAllMocks();
  Conversation.find.mockImplementation(() => query([row()]));
  Alert.exists.mockResolvedValue(null);
  AlertService.create.mockResolvedValue({ created: true, alert: { _id: 'a1' } });
});

test('stable per-conversation key for one service and no accidental duplicates', () => {
  expect(serviceReviewKey('c1', 'Sink draining slowly')).toBe(serviceReviewKey('c1', 'Sink draining slowly'));
  expect(serviceReviewKey('c1', 'Sink draining slowly')).not.toBe(serviceReviewKey('c1', 'Roof repair'));
});

test('never repairs withdrawn, booked, or explicitly declined requests', () => {
  expect(serviceReviewNeedsRepair(row())).toBe(true);
  expect(serviceReviewNeedsRepair({ ...row(), bookingState: { appointment: 'a1' } })).toBe(false);
  expect(serviceReviewNeedsRepair({ ...row(), conversationMemory: { recoveryIntake: { withdrawnAt: new Date() } } })).toBe(false);
  expect(serviceReviewNeedsRepair({ ...row(), serviceEligibility: { ...row().serviceEligibility, reviewDeclined: true } })).toBe(false);
});

test('repairs only missing review, retains tenant/lead/conversation links, without booking or texting', async () => {
  const result = await reconcileServiceReviewPage({ limit: 25 });
  expect(result).toMatchObject({ scanned: 1, created: 1, nextCursor: null });
  expect(Alert.exists).toHaveBeenCalledWith(expect.objectContaining({ business: 'b1' }));
  expect(AlertService.create).toHaveBeenCalledWith(expect.objectContaining({
    businessId: 'b1', leadId: 'l1', conversationId: 'c1',
    type: 'system', actionRequired: true, metadata: expect.objectContaining({ repairSource: 'missing_staff_review' }),
  }));
});

test('resolved review is never reopened by the background repair', async () => {
  Alert.exists.mockResolvedValue({ _id: 'old-resolved' });
  const result = await reconcileServiceReviewPage();
  expect(result).toMatchObject({ created: 0, skipped: 1 });
  expect(AlertService.create).not.toHaveBeenCalled();
});

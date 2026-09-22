import mongoose from 'mongoose';
import Alert from '../../src/models/alert.js';
import { attentionSummary, ownerAttentionPipeline } from '../../src/services/ownerExperience.service.js';

afterEach(() => jest.restoreAllMocks());
const business = new mongoose.Types.ObjectId();
test('summary keeps grouped customer count separate from issue count and retains representative links', async () => {
  const alertId = new mongoose.Types.ObjectId();
  const conversationId = new mongoose.Types.ObjectId();
  const option = jest.fn().mockResolvedValue([{ totals: [{ count: 1, issueCount: 2 }], preview: [
    { representative: { _id: alertId, title: 'Urgent request', conversation: conversationId }, issueCount: 2 },
  ] }]);
  jest.spyOn(Alert, 'aggregate').mockReturnValue({ option });
  jest.spyOn(Alert, 'populate').mockImplementation(async rows => rows.map(row => ({ ...row,
    conversation: { _id: conversationId, customerName: 'Jane' } })));
  const result = await attentionSummary(business);
  expect(result).toMatchObject({ count: 1, issueCount: 2, preview: [{ issueCount: 2, customerName: 'Jane', conversationId: String(conversationId) }] });
  expect(result.preview).toHaveLength(1);
  expect(option).toHaveBeenCalledWith({ maxTimeMS: expect.any(Number) });
});
test('empty result has zero customers, zero issues and no cards', async () => {
  jest.spyOn(Alert, 'aggregate').mockReturnValue({ option: jest.fn().mockResolvedValue([{ totals: [], preview: [] }]) });
  jest.spyOn(Alert, 'populate').mockResolvedValue([]);
  expect(await attentionSummary(business)).toEqual({ count: 0, issueCount: 0, preview: [] });
});
test('database errors propagate rather than reporting all clear', async () => {
  jest.spyOn(Alert, 'aggregate').mockReturnValue({ option: jest.fn().mockRejectedValue(new Error('unavailable')) });
  await expect(attentionSummary(business)).rejects.toThrow('unavailable');
});
test('query scopes tenant with a BSON ID and groups before the preview limit', () => {
  const pipeline = ownerAttentionPipeline(String(business));
  expect(pipeline[0].$match.business).toEqual(business);
  expect(pipeline[0].$match.resolvedAt).toBeNull();
  expect(pipeline.findIndex(stage => stage.$group)).toBeLessThan(pipeline.findIndex(stage => stage.$facet));
  expect(pipeline.some(stage => stage.$limit)).toBe(false);
  expect(pipeline.at(-1).$facet.preview[0]).toEqual({ $limit: 5 });
});

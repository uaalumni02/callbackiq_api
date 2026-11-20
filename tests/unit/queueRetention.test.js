import SmsProcessingJob from '../../src/models/smsProcessingJob.js';
import WebhookWork from '../../src/models/webhookWork.js';
import WebhookEvent from '../../src/models/webhookEvent.js';

const retentionIndexes = model => model.schema.indexes().filter(([, options]) => options.expireAfterSeconds !== undefined);
test.each([
  [SmsProcessingJob, [['completedAt', 'completed'], ['deadAt', 'dead']]],
  [WebhookWork, [['completedAt', 'completed']]],
  [WebhookEvent, [['completedAt', 'completed']]],
])('terminal TTL indexes retain at least 30 days and exclude active jobs', (model, expected) => {
  const indexes = retentionIndexes(model);
  expect(indexes).toHaveLength(expected.length);
  for (const [field, status] of expected) {
    const entry = indexes.find(([key]) => key[field] === 1);
    expect(entry).toBeDefined();
    expect(entry[1].expireAfterSeconds).toBeGreaterThanOrEqual(30 * 24 * 60 * 60);
    expect(entry[1].partialFilterExpression).toEqual({status});
  }
});

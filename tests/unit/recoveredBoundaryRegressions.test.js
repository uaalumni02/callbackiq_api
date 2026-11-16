import { processInlineInboundSmsJob } from '../../src/services/messaging/inlineSmsProcessing.service.js';
import { reserveReplacement } from '../../src/services/scheduling/reschedule/finalize.js';
import { observedDocumentVersion, acceptOwnedDocumentUpdate } from '../../src/services/stateTransitions/documentFence.js';
import { persistVoiceFallbackPreview } from '../../src/services/stateTransitions/messaging.js';
import { opportunityValuationCommitValuationLeadAtomicUpdate } from '../../src/services/stateTransitions/customerProjections.js';
test('inline processing shares the worker conversation lease and preserves a busy durable job', async () => {
  const process = jest.fn().mockResolvedValue('complete'),
    job = {
      _id: 'job',
      business: 'tenant',
      conversation: 'thread'
    };
  const busy = jest.fn().mockResolvedValue({
    acquired: false
  });
  await expect(processInlineInboundSmsJob(job, {
    withDistributedLease: busy,
    processInboundSmsJob: process
  })).resolves.toMatchObject({
    skipped: true
  });
  expect(process).not.toHaveBeenCalled();
  expect(busy).toHaveBeenCalledWith('sms-conversation:thread', expect.any(Function), expect.objectContaining({
    ttlMs: 60000
  }));
  const owner = jest.fn(async (_key, operation) => ({
    acquired: true,
    value: await operation()
  }));
  await expect(processInlineInboundSmsJob(job, {
    withDistributedLease: owner,
    processInboundSmsJob: process
  })).resolves.toBe('complete');
  expect(process).toHaveBeenCalledWith(job);
});
test.each([undefined, null, [], 'invalid', 42])('invalid original reschedule details cannot create a hold or a synthetic replay fingerprint (%#)', async input => {
  const createHold = jest.fn();
  await expect(reserveReplacement({
    business: {
      _id: 'tenant'
    },
    original: {
      _id: 'a'
    },
    input
  }, {
    createHold
  })).rejects.toMatchObject({
    code: 'RESCHEDULE_INPUT_REQUIRED'
  });
  expect(createHold).not.toHaveBeenCalled();
});
test.each([null, {}, {
  stateVersion: 8,
  _id: 'other',
  business: 'tenant'
}, {
  stateVersion: 9,
  _id: 'lead',
  business: 'tenant'
}, {
  stateVersion: 8,
  _id: 'lead',
  business: 'other'
}])('only an exact owned successor may advance a loaded document (%#)', updated => {
  const doc = {
    _id: 'lead',
    business: 'tenant',
    $locals: {
      stateFence: {
        version: 7,
        business: 'tenant'
      }
    },
    unmarkModified: jest.fn()
  };
  expect(observedDocumentVersion(doc)).toEqual({
    stateVersion: 7
  });
  acceptOwnedDocumentUpdate(doc, updated);
  expect(doc.$locals.stateFence.version).toBe(7);
  expect(doc.unmarkModified).not.toHaveBeenCalled();
});
test('owned successor remains fenced on its next save; legacy zero remains a guarded predicate', () => {
  const doc = {
    _id: 'lead',
    $locals: {
      stateFence: {
        version: 0,
        business: 'tenant'
      }
    },
    unmarkModified: jest.fn()
  };
  expect(observedDocumentVersion(doc)).toEqual({
    stateVersion: {
      $in: [0, null]
    }
  });
  acceptOwnedDocumentUpdate(doc, {
    _id: 'lead',
    business: 'tenant',
    stateVersion: 1
  });
  expect(doc.stateVersion).toBe(1);
  expect(doc.$locals.stateFence.version).toBe(1);
  expect(observedDocumentVersion(null)).toEqual({});
});
test('fallback preview writes are scoped and cannot overwrite a later projection', () => {
  const Conversation = {
      findOneAndUpdate: jest.fn()
    },
    at = new Date('2026-11-16T01:00:00Z');
  persistVoiceFallbackPreview({
    Conversation,
    conversation: {
      _id: 'thread'
    },
    business: {
      _id: 'tenant'
    },
    body: 'sent',
    at
  });
  expect(Conversation.findOneAndUpdate).toHaveBeenCalledWith({
    _id: 'thread',
    business: 'tenant',
    $or: [{
      lastMessageAt: null
    }, {
      lastMessageAt: {
        $lte: at
      }
    }]
  }, {
    $set: {
      lastMessage: 'sent',
      lastMessageAt: at
    }
  }, {
    returnDocument: 'after'
  });
});
test('valuation commits retain tenant ownership, valuation epoch, and automatic-source restrictions', () => {
  const Lead = {
    findOneAndUpdate: jest.fn()
  };
  opportunityValuationCommitValuationLeadAtomicUpdate({
    Lead,
    businessId: 'tenant',
    ticket: {
      _id: 'lead',
      valuationVersion: 3,
      stateVersion: 7
    },
    value: {
      estimatedValue: 500
    }
  });
  expect(Lead.findOneAndUpdate.mock.calls[0][0]).toMatchObject({
    _id: 'lead',
    business: 'tenant',
    valuationVersion: 3
  });
});

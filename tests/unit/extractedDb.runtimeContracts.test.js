/** Real extracted Db repositories: query contracts, scopes and failures.
 * These tests invoke production implementations, NOT the mocked Db facade.
 * Side effects are replaced by inert recording models only.
 */
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import logger from '../../src/config/logger.js';
import {tenantRepository,tenantContext} from '../../src/db/repositories/tenantRepository.js';
import { createDbalerts1Methods } from '../../src/db/repositories/extracted/alerts-1.js';
import { createDbbusiness1Methods } from '../../src/db/repositories/extracted/business-1.js';
import { createDbcalls1Methods } from '../../src/db/repositories/extracted/calls-1.js';
import { createDbconversations1Methods } from '../../src/db/repositories/extracted/conversations-1.js';
import { createDbdemo1Methods } from '../../src/db/repositories/extracted/demo-1.js';
import { createDbidentity1Methods } from '../../src/db/repositories/extracted/identity-1.js';
import { createDbleads1Methods } from '../../src/db/repositories/extracted/leads-1.js';
import { createDbmessages1Methods } from '../../src/db/repositories/extracted/messages-1.js';
import { createDboperations1Methods } from '../../src/db/repositories/extracted/operations-1.js';

jest.mock('../../src/config/logger.js',()=>({__esModule:true,default:{error:jest.fn()}}));

const tenant = '000000000000000000000001';
const sampleId = '000000000000000000000002';
const opts = { status: 'review', markedBy: 'staff' };
const ownedFamilies=new Set(['alerts','calls','conversations','leads','messages']);
const removed=new Set(['getAlertById','updateAlert','markAlertAsRead','updateBusiness','getCallLogById','updateCallLog','updateCallLogByProviderCallId','getConversationById','updateConversation','getLeadById','updateLead','qualifyLead','getMessageById']);
const schema=new mongoose.Schema({business:mongoose.Schema.Types.ObjectId});
const now = new Date('2026-11-01T10:00:00Z');

function recordingModel(result = { _id: sampleId, business: tenant }, fail = null) {
  const events = [];
  const query = new Proxy(Object.create(null), {
    get(_target, key) {
      if (key === 'then') return (resolve, reject) => Promise.resolve(result).then(resolve, reject);
      if (key === 'catch') return callback => Promise.resolve(result).catch(callback);
      if (key === Symbol.toStringTag) return 'Query';
      return (...args) => { events.push([key, args]); return query; };
    },
  });
  const model = new Proxy(Object.create(null), {
    get(_target, key) {
      if(key==='schema')return schema;
      if(key==='modelName')return 'ContractResource';
      if(key==='db')return {models:{}};
      return (...args) => {
        events.push([key, args]);
        if (fail) throw fail;
        return query;
      };
    },
  });
  return { model, events, result };
}

const families = [
  ['alerts', createDbalerts1Methods, {
    getAlertsByBusiness: [tenant], getUnreadAlertsByBusiness: [tenant],
    getAlertById: [sampleId], getAlertForBusiness: [sampleId, tenant],
    updateAlert: [sampleId, opts], updateAlertForBusiness: [sampleId, tenant, opts],
    markAlertAsRead: [sampleId], markAlertAsReadForBusiness: [sampleId, tenant],
    markAllAlertsAsRead: [tenant, now],
  }],
  ['business', createDbbusiness1Methods, {
    getBusinessScopeByOwner: ['owner-1'], updateBusiness: [sampleId, opts],
    updateBusinessByOwner: ['owner-1', opts],
    getBusinessByPhone: ['+15550123000'], getBusinessByPhoneForWebhook: ['+15550123000'],
    adminUpdateBusinessStatus: [{ businessId: tenant, isActive: false }],
  }],
  ['calls', createDbcalls1Methods, {
    getCallLogsByBusiness: [tenant], getCallLogById: [sampleId],
    getCallLogForBusiness: [sampleId, tenant], updateCallLog: [sampleId, opts],
    updateCallLogForBusiness: [sampleId, tenant, opts],
    updateCallLogByProviderCallId: ['CA_provider', opts],
  }],
  ['conversations', createDbconversations1Methods, {
    getConversationsByBusiness: [tenant], getConversationById: [sampleId],
    getConversationForBusiness: [sampleId, tenant], updateConversation: [sampleId, opts],
    getConversationByBusinessAndPhone: [tenant, '+15550123000'],
  }],
  ['demo', createDbdemo1Methods, { updateDemoRequest: [sampleId, opts] }],
  ['identity', createDbidentity1Methods, {
    savePasswordResetToken: [sampleId, 'reset-1', now],
    findUserByPasswordResetToken: ['reset-1'],
    saveResetPassword: [sampleId, 'hashed-password'],
    findUserByLogin: ['  Person@EXAMPLE.com  '],
  }],
  ['leads', createDbleads1Methods, {
    getLeadsByBusiness: [tenant], getLeadById: [sampleId],
    updateLead: [sampleId, opts], updateLeadForBusiness: [sampleId, tenant, opts],
    getLeadByBusinessAndPhone: [tenant, '+15550123000'], qualifyLead: [sampleId, opts],
  }],
  ['messages', createDbmessages1Methods, {
    getMessagesByConversation: [sampleId,tenant], getMessageById: [sampleId],
    getMessageForBusiness: [sampleId, tenant],
  }],
  ['operations', createDboperations1Methods, {
    recordFailedLogin: [sampleId], clearLoginSecurityState: [sampleId],
    decayLoginSecurityState: [sampleId],
  }],
];

for (const [family, factory, argsByMethod] of families) {
  const methods = factory({
    safeConsole: { error: () => {} },
    BUSINESS_SCOPE_FIELDS: '_id owner businessName',
  });
  for (const [name, args] of Object.entries(argsByMethod)) {
    test(`${family}.${name}: real repository returns query result and forwards data`, async () => {
      const { model, events, result } = recordingModel();
      if(removed.has(name)){assert.equal(methods[name],undefined,'ID-only capability must not be exposed to owner callers');assert.equal(events.length,0);return;}
      const input = name === 'adminUpdateBusinessStatus'
        ? [{ ...args[0], Business: model }]
        : [model, ...args];
      const observed = await methods[name](...input);
      assert.equal(observed, result, `${name} must return the data from the model`);
      assert.ok(events.length, `${name} must invoke a model method`);
      assert.ok(['find','findOne','findById','findOneAndUpdate','findByIdAndUpdate','updateMany'].includes(events[0][0]),
        `${name} must perform an expected read or mutation`);
      const first = events[0];
      if (/ForBusiness|ByBusiness|getAlertsByBusiness|getCallLogsByBusiness|getLeadsByBusiness|getConversationsByBusiness|markAllAlertsAsRead/.test(name)) {
        assert.ok(JSON.stringify(first[1]).includes(tenant), `${name} must preserve tenant scope`);
      }
      if (/update|markAlertAsRead|qualifyLead|savePasswordResetToken|saveResetPassword|recordFailedLogin|clearLoginSecurityState|decayLoginSecurityState|adminUpdateBusinessStatus/i.test(name)) {
        if (first[0].endsWith('Update')) {
          const settings = first[1].at(-1);
          assert.equal(settings.returnDocument, 'after', `${name} must return updated document`);
        }
      }
      if (name === 'findUserByLogin') {
        assert.deepEqual(first[1][0].$or, [
          { userName: 'Person@EXAMPLE.com' }, { email: 'person@example.com' },
        ]);
        assert.ok(events.some(([op]) => op === 'select'), 'must request password and security fields explicitly');
      }
      if (name === 'recordFailedLogin') {
        assert.ok(Array.isArray(first[1][1]), 'failed login updates must be atomic MongoDB pipeline');
        assert.ok(first[1][1].length >= 5, 'must retain account lockout policy pipeline');
      }
      if (name === 'markAllAlertsAsRead') {
        assert.deepEqual(first[1][0], { business:new mongoose.Types.ObjectId(tenant),$and:[{readAt:null}] });
        assert.deepEqual(first[1][1], { $set: { status: 'read', readAt: now } });
      }
    });
    test(`${family}.${name}: database error path preserves logging contract`, async () => {
      const exception = new Error('database unavailable');
      if(removed.has(name)){await assert.rejects(async()=>methods[name](),TypeError);return;}
      const named=logger.error;named.mockClear();
      const errors = [];
      const failing = factory({ safeConsole: { error: (...x) => errors.push(x) }, BUSINESS_SCOPE_FIELDS: '_id owner' });
      const { model } = recordingModel(undefined, exception);
      const input = name === 'adminUpdateBusinessStatus'
        ? [{ ...args[0], Business: model }]
        : [model, ...args];
      await assert.rejects(() => failing[name](...input), err =>
        name === 'findUserByLogin' ? err.message === 'Database error while finding user' : err === exception);
      if(ownedFamilies.has(family)){assert.equal(named.mock.calls.length,1);assert.equal(named.mock.calls[0][0],'repository.tenant_operation_failed');assert.equal(named.mock.calls[0][1].businessId,tenant);}
      else assert.equal(errors.length,1,'legacy non-tenant repository logs once');

    });
  }
}

test('tenant capabilities preserve explicit lean/select without querying unrelated populations',async()=>{
 const {model,events}=recordingModel();
 await tenantRepository(model,tenantContext(tenant)).read(sampleId,{select:'_id status'});
 assert.ok(events.some(([name])=>name==='lean'));
 assert.equal(events.filter(([name])=>name==='populate').length,0);
 assert.deepEqual(events.find(([name])=>name==='select')[1],['_id status']);
});

test('getMessagesForAI preserves chronological order and bounded projection', async () => {
  const prior = process.env.AI_ANALYSIS_HISTORY_LIMIT;
  try {
    process.env.AI_ANALYSIS_HISTORY_LIMIT = '10000';
    const records = [{ _id: 'new' }, { _id: 'old' }];
    const { model, events } = recordingModel(records);
    const methods = createDbmessages1Methods({ safeConsole: { error: () => {} } });
    const out = await methods.getMessagesForAI(model,sampleId,tenant);
    assert.deepEqual(out.map(x => x._id), ['old', 'new']);
    assert.deepEqual(events.find(([name]) => name === 'limit')[1], [500]);
    assert.ok(events.some(([name, a]) => name === 'select' && a[0].includes('providerMessageId')));
  } finally {
    if (prior === undefined) delete process.env.AI_ANALYSIS_HISTORY_LIMIT;
    else process.env.AI_ANALYSIS_HISTORY_LIMIT = prior;
  }
});

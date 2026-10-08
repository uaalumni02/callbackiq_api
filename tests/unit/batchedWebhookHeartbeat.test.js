import WebhookEvent from '../../src/models/webhookEvent.js';
import {heartbeatTwilioWebhookEvent} from '../../src/services/webhooks/twilioWebhookEvent.service.js';
jest.mock('../../src/models/webhookEvent.js',()=>({__esModule:true,default:{bulkWrite:jest.fn(),updateOne:jest.fn()}}));
beforeEach(()=>jest.clearAllMocks());
test('one bulk command retains every event ID, lease token and processing-status fence',async()=>{
 WebhookEvent.bulkWrite.mockResolvedValue({modifiedCount:1});
 await Promise.all([heartbeatTwilioWebhookEvent({eventId:'a',leaseToken:'owner-a'}),heartbeatTwilioWebhookEvent({eventId:'b',leaseToken:'owner-b'})]);
 expect(WebhookEvent.bulkWrite).toHaveBeenCalledTimes(1);
 const [operations,options]=WebhookEvent.bulkWrite.mock.calls[0];
 expect(options).toEqual({ordered:false});
 expect(operations.map(op=>op.updateOne.filter)).toEqual([{_id:'a',status:'processing',leaseToken:'owner-a'},{_id:'b',status:'processing',leaseToken:'owner-b'}]);
 expect(operations.every(op=>op.updateOne.update.$set.leaseExpiresAt>Date.now())).toBe(true);
});
test('bulk failure is not reported as successful renewal',async()=>{
 const error=new Error('write failed');WebhookEvent.bulkWrite.mockRejectedValue(error);
 const result=await Promise.allSettled(['a','b'].map(eventId=>heartbeatTwilioWebhookEvent({eventId,leaseToken:'token'})));
 expect(result.every(r=>r.status==='rejected'&&r.reason===error)).toBe(true);
});

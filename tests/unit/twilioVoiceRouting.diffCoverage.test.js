import CallLog from '../../src/models/callLog.js';
import { handleSmsRecoveryVoiceWebhook } from '../../src/services/twilioSmsWebhook.service.js';
import {
  resolveTwilioNumberContext,
  resolveBusinessByTwilioNumber,
} from '../../src/services/twilioBusinessResolver.service.js';
import { sendSms } from '../../src/services/twilioSmsService.js';
import { claimTwilioWebhookEvent } from '../../src/services/webhooks/twilioWebhookEvent.service.js';
import { enqueueWebhookWork } from '../../src/services/webhooks/webhookWork.service.js';

jest.mock('../../src/services/twilioBusinessResolver.service.js', () => ({
  resolveTwilioNumberContext: jest.fn(),
  resolveBusinessByTwilioNumber: jest.fn(),
  resolveBusinessFromWebhookPhones: jest.fn(),
}));

jest.mock('../../src/services/twilioSmsService.js', () => ({
  sendSms: jest.fn(),
}));

jest.mock('../../src/services/webhooks/twilioWebhookEvent.service.js', () => ({
  claimTwilioWebhookEvent: jest.fn(),
}));

jest.mock('../../src/services/webhooks/webhookWork.service.js', () => ({
  durableWebhookWorkEnabled: () => true,
  enqueueWebhookWork: jest.fn(),
}));

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

test.each([
  {
    From: '+14045550101',
    To: '+14045550100',
    CallSid: 'CA_UNMAPPED_NUMBER',
  },
  {
    Caller: '+14045550101',
    Called: '+14045550100',
    CallSid: 'CA_UNMAPPED_ALIAS',
  },
])(
  'unmapped voice destination returns 404 without communication or persistence: %j',
  async body => {
    resolveTwilioNumberContext.mockResolvedValue(null);
    resolveBusinessByTwilioNumber.mockResolvedValue(null);

    const persist = jest.spyOn(CallLog, 'findOneAndUpdate');
    const res = {
      type: jest.fn().mockReturnThis(),
      status: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
    };

    await handleSmsRecoveryVoiceWebhook({ body }, res);

    expect(resolveTwilioNumberContext)
      .toHaveBeenCalledWith('+14045550100');
    expect(resolveBusinessByTwilioNumber)
      .toHaveBeenCalledWith('+14045550100');

    expect(res.status).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.type).toHaveBeenCalledWith('text/xml');
    expect(res.set).toHaveBeenCalledWith(
      'X-CallBackIQ-Routing-Error',
      'TWILIO_NUMBER_NOT_MAPPED',
    );
    expect(res.send).toHaveBeenCalledWith(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    );

    expect(sendSms).not.toHaveBeenCalled();
    expect(enqueueWebhookWork).not.toHaveBeenCalled();
    expect(claimTwilioWebhookEvent).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  },
);

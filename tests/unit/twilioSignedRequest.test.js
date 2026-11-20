import validateTwilioSignature from '../../src/middleware/validate-twilio-signature.js';
import { signTwilioRequest } from '../helpers/signTwilioRequest.js';

const originalEnv = { ...process.env };
afterEach(() => { process.env = { ...originalEnv }; });
test('a fixture sends a genuine signature through normal Twilio validation', () => {
  process.env.NODE_ENV = 'development';
  process.env.TWILIO_WEBHOOK_BASE_URL = 'https://api.example.test';
  const body = { From: '+14045550100', Body: 'Synthetic fixture' };
  const signature = signTwilioRequest({url: 'https://api.example.test/api/twilio/sms', params: body});
  const req = { headers: {}, body, originalUrl: '/api/twilio/sms',
    get: name => signature['X-Twilio-Signature'] && name.toLowerCase() === 'x-twilio-signature' ? signature['X-Twilio-Signature'] : undefined };
  const next = jest.fn();
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  validateTwilioSignature(req, res, next);
  expect(next).toHaveBeenCalledTimes(1);
  req.body.Body = 'Changed after signing';
  validateTwilioSignature(req, res, next);
  expect(next).toHaveBeenCalledTimes(1);
  expect(res.status).toHaveBeenCalledWith(403);
});

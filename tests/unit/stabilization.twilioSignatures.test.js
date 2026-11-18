import twilio from 'twilio';
import validate from '../../src/middleware/validate-twilio-signature.js';
test('staging and development cannot disable Twilio validation and require a configured token and valid signature', () => {
  const original = { ...process.env };
  try {
    for (const environment of ['staging', 'development', 'production']) {
      process.env.NODE_ENV = environment; process.env.TWILIO_VALIDATE_WEBHOOKS = 'false';
      process.env.TWILIO_WEBHOOK_BASE_URL = 'https://synthetic.example.test';
      delete process.env.TWILIO_AUTH_TOKEN; delete process.env.TWILIO_AUTH_TOKEN_NEXT; delete process.env.TWILIO_AUTH_TOKEN_PREVIOUS;
      const headers = {}, req = { originalUrl: '/api/twilio/sms', body: { Body: 'Synthetic' }, get: key => headers[key], headers: {} };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }, next = jest.fn();
      validate(req, res, next); expect(res.status).toHaveBeenLastCalledWith(503); expect(next).not.toHaveBeenCalled();
      process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
      validate(req, res, next); expect(res.status).toHaveBeenLastCalledWith(403); expect(next).not.toHaveBeenCalled();
      headers['x-twilio-signature'] = twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN, 'https://synthetic.example.test/api/twilio/sms', req.body);
      validate(req, res, next); expect(next).toHaveBeenCalledTimes(1);
    }
  } finally { process.env = original; }
});

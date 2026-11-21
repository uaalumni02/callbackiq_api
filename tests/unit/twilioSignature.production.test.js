import express from 'express';
import request from 'supertest';
import validateTwilioSignature from '../../src/middleware/validate-twilio-signature.js';
import { signedTwilioPost } from '../helpers/signTwilioRequest.js';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.post('/api/twilio/sms', validateTwilioSignature, (_req, res) => res.sendStatus(204));
const previous = { ...process.env };
afterEach(() => { process.env = { ...previous }; });

test.each(['test', 'development', 'staging', 'production'])('validates real Twilio HMACs in %s even with the old disable flag', async NODE_ENV => {
  Object.assign(process.env, { NODE_ENV, TWILIO_VALIDATE_WEBHOOKS: 'false' });
  const response = await signedTwilioPost(app, '/api/twilio/sms', { Body: 'Synthetic test' });
  expect(response.status).toBe(204);
});
test('missing and invalid signatures are rejected', async () => {
  for (const headers of [{}, { 'X-Twilio-Signature': 'invalid' }]) {
    expect((await request(app).post('/api/twilio/sms').set(headers).type('form').send({Body:'Synthetic'})).status).toBe(403);
  }
});
test('a rotated previous token passes real validation', async () => {
  process.env.TWILIO_AUTH_TOKEN_PREVIOUS = 'synthetic-previous-token';
  expect((await signedTwilioPost(app, '/api/twilio/sms', { Body: 'Synthetic' }, { token: process.env.TWILIO_AUTH_TOKEN_PREVIOUS })).status).toBe(204);
});
test('the signed form cannot be changed after signing', async () => {
  const post = signedTwilioPost(app, '/api/twilio/sms', {Body:'Original'});
  expect((await post.send({Body:'Tampered'})).status).toBe(403);
});

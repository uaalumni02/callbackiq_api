import twilio from 'twilio';
import request from 'supertest';
import { getWebhookUrl } from '../../src/middleware/validate-twilio-signature.js';
import { signatureUrlForRequest } from '../../src/voice/conversationRelaySignature.js';

export const signTwilioRequest = ({ url, params = {}, token = process.env.TWILIO_AUTH_TOKEN }) => ({
  'X-Twilio-Signature': twilio.getExpectedTwilioSignature(token, url, params),
});

export const signedTwilioHeaders = (path, params = {}, { token, headers = {}, origin = 'http://localhost' } = {}) => {
  const parsed = new URL(path, origin);
  const req = { originalUrl: `${parsed.pathname}${parsed.search}`, headers,
    protocol: parsed.protocol.replace(':', ''), get: name => name === 'host' ? parsed.host : headers[name] };
  return signTwilioRequest({ url: getWebhookUrl(req), params, token });
};

export const signedTwilioPost = (app, path, params = {}, options = {}) => {
  const post = request(app).post(path);
  // Sign the form-encoded representation, which is what Express/Twilio validates.
  const form = Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)]));
  return post.set(options.headers || {}).set(signedTwilioHeaders(path, form, { ...options, origin: post.url }))
    .type('form').send(form);
};

export const signedRelayOptions = (url, { token, headers = {} } = {}) => ({
  headers: { ...headers, ...signTwilioRequest({ url: signatureUrlForRequest({ url }), token }) },
});

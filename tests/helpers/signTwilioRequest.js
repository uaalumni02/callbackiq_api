import twilio from 'twilio';

export const signTwilioRequest = ({ url, params = {}, token = process.env.TWILIO_AUTH_TOKEN }) => ({
  'X-Twilio-Signature': twilio.getExpectedTwilioSignature(token, url, params),
});

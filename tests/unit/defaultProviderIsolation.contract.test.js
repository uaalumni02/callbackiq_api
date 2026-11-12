import https from 'node:https';
import tls from 'node:tls';
import { createTwilioClient } from '../../src/integrations/providerClients.js';

// Importing the installer here would conceal a missing Jest setup.
test('the default test environment blocks the real Twilio SDK before transport creation', async () => {
  const transport = jest.spyOn(tls, 'connect').mockImplementation(() => {
    throw Object.assign(new Error('Unexpected transport attempt'), { code: 'CANARY_TRANSPORT_ATTEMPT' });
  });
  try {
    const client = createTwilioClient('AC00000000000000000000000000000000', 'test-auth-token',
      { autoRetry: false, maxRetries: 0, timeout: 100 });
    await expect(client.incomingPhoneNumbers('PN00000000000000000000000000000000').fetch())
      .rejects.toMatchObject({ code: 'EXTERNAL_PROVIDER_NETWORK_BLOCKED' });
    expect(transport).not.toHaveBeenCalled();
  } finally { transport.mockRestore(); }
});

test('the default test environment rejects provider HTTP requests synchronously', () => {
  let request, error;
  const transport = jest.spyOn(tls, 'connect').mockImplementation(() => {
    throw Object.assign(new Error('Unexpected transport attempt'), { code: 'CANARY_TRANSPORT_ATTEMPT' });
  });
  try {
    try { request = https.request('https://api.stripe.com/v1/customers'); }
    catch (failure) { error = failure; }
    request?.on('error', () => {}); request?.destroy();
    expect(error?.code).toBe('EXTERNAL_PROVIDER_NETWORK_BLOCKED');
    expect(transport).not.toHaveBeenCalled();
  } finally { transport.mockRestore(); }
});

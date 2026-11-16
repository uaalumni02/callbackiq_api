import { EventEmitter } from 'node:events';
import { passwordPolicyError } from '../../src/services/security/passwordPolicy.js';
import { validAdminSession, ADMIN_SESSION_SECONDS } from '../../src/services/security/adminSessionPolicy.js';
import { allowedMediaUrl, loadProviderMedia } from '../../src/services/security/providerMedia.js';
import bcrypt from '../../src/helpers/bcrypt/bcrypt.js';
afterEach(() => jest.restoreAllMocks());
test.each([undefined, null, 123, {}, []])('non-text passwords fail closed (%#)', value => {
  expect(passwordPolicyError(value)).toBe('Enter a password.');
});
test.each(['abcdabcdabcdabcd', 'ABCABCABCABCABCABC', '   passwordpassword   ', 'qwertyuiopasdfgh'])('repetition and whitespace do not evade screening (%#)', value => {
  expect(passwordPolicyError(value)).toBeTruthy();
});
test('password length uses normalized Unicode characters, including both supported boundaries', () => {
  expect(passwordPolicyError('😀😃😄😁😆😅😂🙂🙃😉😊😇🥰😍🤩')).toBe('');
  const value = Array.from('A varied Unicode passphrase 🎯! '.repeat(5)).slice(0, 128).join('');
  expect(passwordPolicyError(value)).toBe('');
  expect(passwordPolicyError(value + 'x')).toBeTruthy();
});
test.each([null, undefined, {}])('absent/non-text stored hashes never authenticate (%#)', async hash => {
  await expect(bcrypt.comparePassword('A valid long passphrase!', hash)).resolves.toBe(false);
});
test.each([[null, false], [{}, false], [{
  mfaVerified: false,
  authTime: 1000
}, false], [{
  mfaVerified: true,
  authTime: 0
}, false], [{
  mfaVerified: true,
  authTime: -1
}, false], [{
  mfaVerified: true,
  authTime: NaN
}, false], [{
  mfaVerified: true,
  authTime: '1000'
}, false], [{
  mfaVerified: true,
  authTime: 1001
}, false], [{
  mfaVerified: true,
  authTime: 1000
}, true]])('administrator claims must have a valid verified timestamp (%#)', (claims, expected) => {
  expect(validAdminSession(claims, 1000)).toBe(expected);
});
test('administrator expiry includes its boundary and rejects the next second', () => {
  const claims = {
    mfaVerified: true,
    authTime: 1000
  };
  expect(validAdminSession(claims, 1000 + ADMIN_SESSION_SECONDS)).toBe(true);
  expect(validAdminSession(claims, 1001 + ADMIN_SESSION_SECONDS)).toBe(false);
  jest.spyOn(Date, 'now').mockReturnValue(1001 * 1000);
  expect(validAdminSession(claims)).toBe(true);
});
test.each([['https://user:pass@api.twilio.com/media', false], ['https://user@api.twilio.com/media', false], ['https://:pass@api.twilio.com/media', false], ['https://api.twilio.com:443/media', true], ['https://media.twilio.com/file', true], ['https://assets.twiliocdn.com/file', true], ['https://twilio.com.evil.test/file', false], ['https://twiliocdn.com/file', false], ['file:///tmp/media', false], ['https://api.twilio.com./media', false]])('media URL ownership policy is enforced for %s', (url, expected) => {
  expect(allowedMediaUrl(url)).toBe(expected);
});
test('the process-wide limit blocks a ninth tenant and all aborted tenants release their permits', async () => {
  const requests = Array.from({
    length: 8
  }, () => new EventEmitter());
  const fetcher = jest.fn((_url, {
    signal
  }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')))));
  const pending = requests.map((req, index) => loadProviderMedia({
    url: 'https://api.twilio.com/media',
    businessId: 'global-limit-' + index,
    authorization: 'synthetic-auth',
    req,
    fetcher
  }));
  const settled = Promise.allSettled(pending);
  await expect(loadProviderMedia({
    url: 'https://api.twilio.com/media',
    businessId: 'ninth-tenant',
    fetcher
  })).rejects.toMatchObject({
    statusCode: 429
  });
  requests.forEach(req => req.emit('aborted'));
  expect((await settled).every(row => row.status === 'rejected')).toBe(true);
  const response = await loadProviderMedia({
    url: 'https://media.twiliocdn.com/file',
    businessId: 'ninth-tenant',
    fetcher: async () => new Response('released')
  });
  expect(response.buffer.toString()).toBe('released');
});
test('default fetching needs no optional HTTP listeners and releases a failed stream', async () => {
  const original = new Error('upstream stream failed');
  const reader = {
    read: jest.fn().mockRejectedValue(original),
    cancel: jest.fn().mockRejectedValue(new Error('cancel failed')),
    releaseLock: jest.fn()
  };
  jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
    ok: true,
    status: 200,
    headers: new Headers(),
    body: {
      getReader: () => reader
    }
  }).mockResolvedValueOnce(new Response('ok'));
  await expect(loadProviderMedia({
    url: 'https://api.twilio.com/media',
    businessId: 'stream-error'
  })).rejects.toBe(original);
  expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  expect((await loadProviderMedia({
    url: 'https://api.twilio.com/media',
    businessId: 'stream-error'
  })).buffer.toString()).toBe('ok');
});

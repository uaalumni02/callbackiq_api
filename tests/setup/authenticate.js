import request from 'supertest';
import { TOTP, Secret } from 'otpauth';
/** Test client follows the actual admin enrollment/login flow; it never invents an MFA claim. */
export async function loginWithMfa(app, credentials) {
  const login = await request(app).post('/api/auth/login').send(credentials);
  if (!login.body.data?.mfaRequired) return login;
  if (!login.body.data.setupRequired) throw new Error('Fixture requires a fresh admin enrollment.');
  const code = new TOTP({ secret: Secret.fromBase32(login.body.data.secret) }).generate();
  const verified = await request(app).post('/api/auth/mfa/verify').send({ challengeToken: login.body.data.challengeToken, code });
  if (verified.status !== 200) return verified;
  const cookie = verified.headers['set-cookie'][0].split(';')[0];
  const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
  if (me.status !== 200) return me;
  return { ...verified, body: { success: true, data: { user: me.body.data, token: decodeURIComponent(cookie.slice('token='.length)) } } };
}

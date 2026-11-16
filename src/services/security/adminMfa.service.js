import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { TOTP, Secret } from 'otpauth';
import User from '../../models/user.js';
import { encryptSecret, decryptSecret } from '../integrations/tokenEncryption.service.js';
import { saveAdminChallenge, claimAdminChallengeAttempt, consumeAdminChallenge,
  enableAdminMfa, consumeAdminTotp, consumeAdminRecovery, replaceAdminRecovery, chargeAdminMfaAttempt } from '../stateTransitions/adminAuthentication.js';
import bcrypt from '../../helpers/bcrypt/bcrypt.js';
export const mfaFailure = () => Object.assign(new Error('Verification failed or expired. Sign in again if needed.'), { statusCode: 401, code: 'MFA_VERIFICATION_FAILED' });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const normalizeRecovery = value => String(value || '').replace(/-/g, '').toLowerCase();
const privateFields = '+sessionVersion +mfaSecretEncrypted +mfaRecoveryHashes +mfaLastStep +password';
const authenticator = (secret, email) => new TOTP({ issuer: 'MeekCall', label: email, algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secret) });
const recoveryCodes = () => Array.from({ length: 10 }, () => crypto.randomBytes(16).toString('hex').match(/.{1,8}/g).join('-'));
function totpStep(secret, email, code, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code))) return null;
  const delta = authenticator(secret, email).validate({ token: String(code), timestamp: now, window: 1 });
  return delta === null ? null : Math.floor(now / 30000) + delta;
}
export async function issueAdminChallenge(user) {
  const current = await User.findById(user._id).select(privateFields);
  if (!current || current.role !== 'admin' || Number(current.sessionVersion || 0) !== Number(user.sessionVersion || 0)) throw mfaFailure();
  await chargeAdminMfaAttempt(current._id, 'challenge');
  const token = crypto.randomBytes(32).toString('hex');
  const setupRequired = current.mfaEnabled !== true;
  const secret = setupRequired ? new Secret({ size: 20 }).base32 : null;
  await saveAdminChallenge({ _id: hash(token), user: current._id, sessionVersion: current.sessionVersion || 0,
    expiresAt: new Date(Date.now() + 300000), ...(secret ? { enrollmentSecretEncrypted: encryptSecret(secret) } : {}) });
  return { mfaRequired: true, setupRequired, challengeToken: token,
    ...(secret ? { secret, provisioningUri: authenticator(secret, current.email).toString() } : {}) };
}
async function authenticateFactor({ user, challenge, code, session }) {
  if (challenge.enrollmentSecretEncrypted && !user.mfaEnabled) {
    const secret = decryptSecret(challenge.enrollmentSecretEncrypted);
    const step = totpStep(secret, user.email, code);
    if (step === null) throw mfaFailure();
    const codes = recoveryCodes();
    const changed = await enableAdminMfa({ user, secret: challenge.enrollmentSecretEncrypted, step, hashes: codes.map(c => hash(normalizeRecovery(c))), session });
    if (!changed) throw mfaFailure();
    return { user: changed, recoveryCodes: codes };
  }
  if (!user.mfaEnabled || !user.mfaSecretEncrypted) throw mfaFailure();
  const step = totpStep(decryptSecret(user.mfaSecretEncrypted), user.email, code);
  const changed = step === null
    ? await consumeAdminRecovery({ user, hash: hash(normalizeRecovery(code)), session })
    : await consumeAdminTotp({ user, step, session });
  if (!changed) throw mfaFailure();
  return { user: changed };
}
export async function completeAdminChallenge({ challengeToken, code }) {
  if (!/^[a-f0-9]{64}$/.test(String(challengeToken)) || typeof code !== 'string' || code.length > 100) throw mfaFailure();
  // Failed attempts are charged outside the transaction so rollback cannot restore the budget.
  const challenge = await claimAdminChallengeAttempt(hash(challengeToken), new Date());
  if (!challenge) throw mfaFailure();
  await chargeAdminMfaAttempt(challenge.user);
  return mongoose.connection.transaction(async session => {
    const user = await User.findById(challenge.user).session(session).select(privateFields);
    if (!user || user.role !== 'admin' || Number(user.sessionVersion || 0) !== challenge.sessionVersion) throw mfaFailure();
    if (!await consumeAdminChallenge(challenge, session)) throw mfaFailure();
    return authenticateFactor({ user, challenge, code, session });
  });
}
export async function regenerateAdminRecovery({ userId, password, code }) {
  await chargeAdminMfaAttempt(userId);
  const user = await User.findById(userId).select(privateFields);
  if (!user || !user.mfaEnabled || !await bcrypt.comparePassword(password, user.password)) throw mfaFailure();
  const step = totpStep(decryptSecret(user.mfaSecretEncrypted), user.email, code);
  if (step === null) throw mfaFailure();
  const codes = recoveryCodes();
  const changed = await replaceAdminRecovery({ user, step, hashes: codes.map(c => hash(normalizeRecovery(c))) });
  if (!changed) throw mfaFailure();
  return { user: changed, recoveryCodes: codes };
}

import RequestRateLimitBucket from '../../models/requestRateLimitBucket.js';
import User from '../../models/user.js';
import Challenge from '../../models/adminAuthChallenge.js';
const versionMatch = user => user.sessionVersion ? user.sessionVersion : { $in: [0, null] };
export const saveAdminChallenge = value => Challenge.create(value);
export const claimAdminChallengeAttempt = (id, now) => Challenge.findOneAndUpdate({ _id: id,
  consumedAt: null, expiresAt: { $gt: now }, attempts: { $lt: 5 } }, { $inc: { attempts: 1 } },
{ returnDocument: 'after' }).select('+enrollmentSecretEncrypted');
export const consumeAdminChallenge = (challenge, session) => Challenge.findOneAndUpdate({
  _id: challenge._id, consumedAt: null, expiresAt: { $gt: new Date() },
}, { $set: { consumedAt: new Date() }, $unset: { enrollmentSecretEncrypted: '' } }, { session, returnDocument: 'after' });
export const enableAdminMfa = ({ user, secret, step, hashes, session }) => User.findOneAndUpdate({
  _id: user._id, role: 'admin', sessionVersion: versionMatch(user), mfaEnabled: { $ne: true },
}, { $set: { mfaEnabled: true, mfaSecretEncrypted: secret, mfaLastStep: step, mfaRecoveryHashes: hashes },
  $inc: { sessionVersion: 1 } }, { session, returnDocument: 'after' }).select('+sessionVersion');
export const consumeAdminTotp = ({ user, step, session }) => User.findOneAndUpdate({
  _id: user._id, role: 'admin', sessionVersion: versionMatch(user), mfaEnabled: true,
  mfaSecretEncrypted: user.mfaSecretEncrypted,
  $or: [{ mfaLastStep: { $lt: step } }, { mfaLastStep: { $exists: false } }],
}, { $set: { mfaLastStep: step } }, { session, returnDocument: 'after' }).select('+sessionVersion');
export const consumeAdminRecovery = ({ user, hash, session }) => User.findOneAndUpdate({
  _id: user._id, role: 'admin', sessionVersion: versionMatch(user), mfaEnabled: true, mfaRecoveryHashes: hash,
}, { $pull: { mfaRecoveryHashes: hash } }, { session, returnDocument: 'after' }).select('+sessionVersion');
export const replaceAdminRecovery = ({ user, step, hashes, session }) => User.findOneAndUpdate({
  _id: user._id, role: 'admin', sessionVersion: versionMatch(user), mfaEnabled: true,
  mfaSecretEncrypted: user.mfaSecretEncrypted, mfaLastStep: { $lt: step },
}, { $set: { mfaLastStep: step, mfaRecoveryHashes: hashes }, $inc: { sessionVersion: 1 } },
{ session, returnDocument: 'after' }).select('+sessionVersion');

export async function chargeAdminMfaAttempt(userId, scope = 'attempt') {
  const start = Math.floor(Date.now() / 900000) * 900000;
  const bucket = await RequestRateLimitBucket.findOneAndUpdate({ _id: `admin-mfa:${scope}:${userId}:${start}` },
    { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(start + 960000) } }, { upsert: true, returnDocument: 'after' }).lean();
  if (bucket.count > 10) throw Object.assign(new Error('Too many verification attempts. Try again later.'), { statusCode: 429, code: 'MFA_RATE_LIMITED' });
}

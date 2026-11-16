import { completeAdminChallenge, regenerateAdminRecovery } from '../../services/security/adminMfa.service.js';
import { cookieOptions, buildAuthToken } from './context.js';
function finish(res, result) {
  res.set('Cache-Control', 'no-store');
  res.cookie('token', buildAuthToken(result.user, result.user.sessionVersion, { mfaVerified: true, authTime: Math.floor(Date.now() / 1000) }), cookieOptions);
  return res.json({ success: true, data: { verified: true, ...(result.recoveryCodes ? { recoveryCodes: result.recoveryCodes } : {}) } });
}
export async function verifyAdminMfa(req, res, next) {
  try { return finish(res, await completeAdminChallenge(req.body || {})); } catch (error) { return next(error); }
}
export async function regenerateRecoveryCodes(req, res, next) {
  try { return finish(res, await regenerateAdminRecovery({ userId: req.user.userId, ...req.body })); } catch (error) { return next(error); }
}

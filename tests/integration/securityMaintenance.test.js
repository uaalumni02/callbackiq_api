import crypto from 'node:crypto';
import { TOTP, Secret } from 'otpauth';
import request from 'supertest';
import app from '../../src/app.js';
import User from '../../src/models/user.js';
import Challenge from '../../src/models/adminAuthChallenge.js';
import Db from '../../src/db/db.js';
import Controller from '../../src/controllers/auth/PasswordReset.js';
import { issueAdminChallenge, completeAdminChallenge, regenerateAdminRecovery } from '../../src/services/security/adminMfa.service.js';
import bcrypt from '../../src/helpers/bcrypt/bcrypt.js';
import Token from '../../src/helpers/jwt/token.js';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testReplicaDb.js';
jest.setTimeout(60000);
beforeAll(connectTestDB);afterAll(closeTestDB);afterEach(async()=>{jest.restoreAllMocks();await clearTestDB()});
beforeEach(()=>{process.env.INTEGRATION_ENCRYPTION_KEY='synthetic-audit-key-for-encryption-1234567890'});
const password='A long synthetic passphrase!';
async function account(role='owner') { return User.create({userName:'SecurityAudit',email:'audit@example.com',password:await bcrypt.hashPassword(password),role,businessName:'Synthetic audit',termsAccepted:true,privacyAccepted:true}); }
const response=()=>{const res={};res.status=jest.fn().mockReturnValue(res);res.json=jest.fn().mockReturnValue(res);return res};
const otp=secret=>new TOTP({secret:Secret.fromBase32(secret)}).generate();
test('only one concurrent reset may consume the token and revoke sessions',async()=>{
 const u=await account();const token=crypto.randomBytes(32).toString('hex');
 await User.updateOne({_id:u._id},{$set:{resetToken:crypto.createHash('sha256').update(token).digest('hex'),resetTokenExpiresAt:new Date(Date.now()+600000)}});
 const original=Db.findUserByPasswordResetToken.bind(Db);let arrivals=0,release;const both=new Promise(r=>{release=r});
 jest.spyOn(Db,'findUserByPasswordResetToken').mockImplementation(async(...args)=>{const value=await original(...args);if(++arrivals===2)release();await both;return value});
 const first=response(),second=response();
 await Promise.all([Controller.resetPassword({params:{resetToken:token},body:{password:'First long synthetic password!'}},first),Controller.resetPassword({params:{resetToken:token},body:{password:'Second long synthetic password!'}},second)]);
 expect([first,second].filter(r=>r.json.mock.calls[0][0].success)).toHaveLength(1);
 expect((await User.findById(u._id).select('+sessionVersion')).sessionVersion).toBe(1);
});
test('administrator password login never establishes a session before MFA',async()=>{
 await account('admin');const res=await request(app).post('/api/auth/login').send({login:'audit@example.com',password});
 expect(res.status).toBe(200);expect(res.body.data).toMatchObject({mfaRequired:true,setupRequired:true});expect(res.headers['set-cookie']).toBeUndefined();
 const verified=await request(app).post('/api/auth/mfa/verify').send({challengeToken:res.body.data.challengeToken,code:otp(res.body.data.secret)});
 expect(verified.status).toBe(200);expect(verified.body.data.recoveryCodes).toHaveLength(10);expect(verified.headers['set-cookie'].join(';')).toContain('HttpOnly');
});
test('enrollment, challenge replay, TOTP replay, recovery reuse and pre-MFA sessions are enforced',async()=>{
 const u=await account('admin');const initial=await issueAdminChallenge(u);const enrolledCode=otp(initial.secret);
 const result=await completeAdminChallenge({challengeToken:initial.challengeToken,code:enrolledCode});
 expect(result.recoveryCodes).toHaveLength(10);
 await expect(completeAdminChallenge({challengeToken:initial.challengeToken,code:enrolledCode})).rejects.toMatchObject({code:'MFA_VERIFICATION_FAILED'});
 const user=await User.findById(u._id).select('+sessionVersion');
 const verify=await issueAdminChallenge(user);
 await expect(completeAdminChallenge({challengeToken:verify.challengeToken,code:enrolledCode})).rejects.toMatchObject({code:'MFA_VERIFICATION_FAILED'});
 const login=await completeAdminChallenge({challengeToken:verify.challengeToken,code:result.recoveryCodes[0]});
 expect(login.user.role).toBe('admin');
 const retry=await issueAdminChallenge(user);
 await expect(completeAdminChallenge({challengeToken:retry.challengeToken,code:result.recoveryCodes[0]})).rejects.toMatchObject({code:'MFA_VERIFICATION_FAILED'});
 const token=Token.sign({userId:u._id,role:'admin',sessionVersion:user.sessionVersion});
 expect((await request(app).get('/api/auth/me').set('Authorization',`Bearer ${token}`)).status).toBe(401);
 const stored=await User.findById(u._id).select('+mfaSecretEncrypted +mfaRecoveryHashes');
 expect(JSON.stringify(stored.toJSON())).not.toContain(initial.secret);expect(stored.mfaRecoveryHashes).not.toContain(result.recoveryCodes[1]);
});
test('five failed attempts exhaust the challenge even though verification rolls back',async()=>{
 const u=await account('admin');const challenge=await issueAdminChallenge(u);
 for(let i=0;i<5;i++)await expect(completeAdminChallenge({challengeToken:challenge.challengeToken,code:'invalid'})).rejects.toMatchObject({code:'MFA_VERIFICATION_FAILED'});
 await expect(completeAdminChallenge({challengeToken:challenge.challengeToken,code:otp(challenge.secret)})).rejects.toMatchObject({code:'MFA_VERIFICATION_FAILED'});
 expect((await Challenge.findOne()).attempts).toBe(5);
});
test('expiry and password reset invalidate pending challenges',async()=>{
 const u=await account('admin');const a=await issueAdminChallenge(u);
 await Challenge.updateMany({},{$set:{expiresAt:new Date(0)}});
 await expect(completeAdminChallenge({challengeToken:a.challengeToken,code:otp(a.secret)})).rejects.toMatchObject({code:'MFA_VERIFICATION_FAILED'});
 const b=await issueAdminChallenge(u);await User.updateOne({_id:u._id},{$inc:{sessionVersion:1}});
 await expect(completeAdminChallenge({challengeToken:b.challengeToken,code:otp(b.secret)})).rejects.toMatchObject({code:'MFA_VERIFICATION_FAILED'});
});
test('recovery rotation requires password plus a fresh TOTP and revokes prior sessions',async()=>{
 const u=await account('admin');const a=await issueAdminChallenge(u);await completeAdminChallenge({challengeToken:a.challengeToken,code:otp(a.secret)});
 const next=new TOTP({secret:Secret.fromBase32(a.secret)}).generate({timestamp:Date.now()+30000});
 const result=await regenerateAdminRecovery({userId:u._id,password,code:next});
 expect(result.recoveryCodes).toHaveLength(10);expect(result.user.sessionVersion).toBe(2);
 await expect(regenerateAdminRecovery({userId:u._id,password,code:next})).rejects.toMatchObject({code:'MFA_VERIFICATION_FAILED'});
});

test('concurrent enrollment and recovery redemption each have one winner',async()=>{
 const u=await account('admin'),a=await issueAdminChallenge(u);
 const enrollment=await Promise.allSettled([completeAdminChallenge({challengeToken:a.challengeToken,code:otp(a.secret)}),completeAdminChallenge({challengeToken:a.challengeToken,code:otp(a.secret)})]);
 expect(enrollment.filter(x=>x.status==='fulfilled')).toHaveLength(1);
 const codes=enrollment.find(x=>x.status==='fulfilled').value.recoveryCodes,user=await User.findById(u._id).select('+sessionVersion');
 const b=await issueAdminChallenge(user),c=await issueAdminChallenge(user);
 const redeemed=await Promise.allSettled([completeAdminChallenge({challengeToken:b.challengeToken,code:codes[0]}),completeAdminChallenge({challengeToken:c.challengeToken,code:codes[0]})]);
 expect(redeemed.filter(x=>x.status==='fulfilled')).toHaveLength(1);
});

test('legacy administrators without a persisted session counter can enroll securely',async()=>{
 const {issueAdminChallenge,completeAdminChallenge}=await import('../../src/services/security/adminMfa.service.js');
 const user=await User.create({userName:'LegacyAdmin',email:'legacy-admin@example.test',password:'unused-fixture-hash',businessName:'Legacy',role:'admin',termsAccepted:true,privacyAccepted:true});
 await User.updateOne({_id:user._id},{$unset:{sessionVersion:''}});
 const challenge=await issueAdminChallenge(user);
 const {TOTP,Secret}=await import('otpauth');const code=new TOTP({secret:Secret.fromBase32(challenge.secret),algorithm:'SHA1',digits:6,period:30}).generate();
 const result=await completeAdminChallenge({challengeToken:challenge.challengeToken,code});
 expect(result.user.mfaEnabled).toBe(true);expect(result.user.sessionVersion).toBe(1);expect(result.recoveryCodes).toHaveLength(10);
});

test('recovery rotation HTTP endpoint binds the account to the verified session',async()=>{
 const u=await account('admin'),challenge=await issueAdminChallenge(u);await completeAdminChallenge({challengeToken:challenge.challengeToken,code:otp(challenge.secret)});
 const token=Token.sign({userId:u._id,role:'admin',sessionVersion:1,mfaVerified:true,authTime:Math.floor(Date.now()/1000)});
 const denied=await request(app).post('/api/auth/mfa/recovery-codes').set('Authorization',`Bearer ${token}`).send({password,code:'invalid'});expect(denied.status).toBe(401);
 const code=new TOTP({secret:Secret.fromBase32(challenge.secret)}).generate({timestamp:Date.now()+30000});
 const rotated=await request(app).post('/api/auth/mfa/recovery-codes').set('Authorization',`Bearer ${token}`).send({userId:'123456789012345678901234',password,code});
 expect(rotated.status).toBe(200);expect(rotated.body.data.recoveryCodes).toHaveLength(10);expect(rotated.headers['set-cookie'].join(';')).toContain('HttpOnly');expect(rotated.headers['cache-control']).toBe('no-store');
 expect((await User.findById(u._id).select('+sessionVersion')).sessionVersion).toBe(2);
 expect((await request(app).post('/api/auth/mfa/verify').send({challengeToken:'malformed',code:'123456'})).status).toBe(401);
});

test('recovery sign-in returns only a verified session and malformed MFA bodies fail closed',async()=>{
 const u=await account('admin'),first=await issueAdminChallenge(u),enrolled=await completeAdminChallenge({challengeToken:first.challengeToken,code:otp(first.secret)});
 const current=await User.findById(u._id).select('+sessionVersion'),challenge=await issueAdminChallenge(current);
 const verified=await request(app).post('/api/auth/mfa/verify').send({challengeToken:challenge.challengeToken,code:enrolled.recoveryCodes[0]});
 expect(verified.status).toBe(200);expect(verified.body.data).toEqual({verified:true});expect(verified.headers['set-cookie'].join(';')).toContain('HttpOnly');
 expect((await request(app).post('/api/auth/mfa/verify')).status).toBe(401);
 const token=Token.sign({userId:u._id,role:'admin',sessionVersion:1,mfaVerified:true,authTime:Math.floor(Date.now()/1000)});
 expect((await request(app).post('/api/auth/mfa/recovery-codes').set('Authorization',`Bearer ${token}`)).status).toBe(401);
 for(const code of [{invalid:true},'x'.repeat(101)])expect((await request(app).post('/api/auth/mfa/recovery-codes').set('Authorization',`Bearer ${token}`).send({password,code})).status).toBe(401);
});

test('MFA failure budgets cannot be reset by issuing another challenge',async()=>{
 const u=await account('admin'),a=await issueAdminChallenge(u),b=await issueAdminChallenge(u),c=await issueAdminChallenge(u);
 for(const challenge of [a,b])for(let i=0;i<5;i++)await expect(completeAdminChallenge({challengeToken:challenge.challengeToken,code:'invalid'})).rejects.toMatchObject({code:'MFA_VERIFICATION_FAILED'});
 await expect(completeAdminChallenge({challengeToken:c.challengeToken,code:otp(c.secret)})).rejects.toMatchObject({code:'MFA_RATE_LIMITED'});
 expect((await User.findById(u._id)).mfaEnabled).not.toBe(true);
});

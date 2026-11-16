import bcrypt from '../../src/helpers/bcrypt/bcrypt.js';
import nativeBcrypt from 'bcrypt';
import { passwordPolicyError } from '../../src/services/security/passwordPolicy.js';
import { registerSchema, resetPasswordSchema } from '../../src/validator/auth.js';
test.each(['123456','passwordpassword','123456789012345','aaaaaaaaaaaaaaaa'])('weak new password is rejected: %s',password=>{
 expect(passwordPolicyError(password)).toBeTruthy();expect(resetPasswordSchema.validate({password}).error).toBeDefined();
});
test('spaces, Unicode, long passphrases and valid account registration use the same policy',async()=>{
 const password='A Unicode passphrase 🔑 with spaces';
 expect(passwordPolicyError(password)).toBe('');
 expect(resetPasswordSchema.validate({password}).error).toBeUndefined();
 expect(registerSchema.validate({email:'user@example.com',password,businessName:'Synthetic business',termsAccepted:true,privacyAccepted:true}).error).toBeUndefined();
 const prefix='a'.repeat(80);const hash=await bcrypt.hashPassword(prefix+'first',4);
 expect(await bcrypt.comparePassword(prefix+'first',hash)).toBe(true);expect(await bcrypt.comparePassword(prefix+'second',hash)).toBe(false);
});
test('legacy bcrypt hashes remain readable and canonical Unicode hashes compare consistently',async()=>{
 const legacy=await nativeBcrypt.hash('OldPassword123',4);expect(await bcrypt.comparePassword('OldPassword123',legacy)).toBe(true);
 const hash=await bcrypt.hashPassword('Café long passphrase',4);expect(await bcrypt.comparePassword('Cafe\u0301 long passphrase',hash)).toBe(true);
 expect(passwordPolicyError('x'.repeat(129))).toBeTruthy();expect(passwordPolicyError('long password with\nnewline')).toBeTruthy();
});

test('administrator sessions require a fresh, correctly typed MFA timestamp',async()=>{
 const { validAdminSession }=await import('../../src/services/security/adminSessionPolicy.js');
 expect(validAdminSession({mfaVerified:true,authTime:1000},1001)).toBe(true);
 for(const claims of [{authTime:1000},{mfaVerified:true},{mfaVerified:true,authTime:'1000'},{mfaVerified:true,authTime:1002},{mfaVerified:true,authTime:1}])expect(validAdminSession(claims,30000)).toBe(false);
});

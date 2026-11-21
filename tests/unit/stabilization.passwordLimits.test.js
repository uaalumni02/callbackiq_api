import { loginSchema, registerSchema, resetPasswordSchema } from '../../src/validator/auth.js';

const account = {
  email: 'unicode@example.com',
  businessName: 'Synthetic Unicode',
  termsAccepted: true,
  privacyAccepted: true,
};

test.each([1, 5, 6, 14, 15, 30, 31, 110, 128, 129])('validates passwords with %i Unicode code points', length => {
  const password = Array.from({ length }, (_, i) => i % 2 ? '🚀' : '😀').join('');
  const login = loginSchema.validate({ login: account.email, password });
  const signup = registerSchema.validate({ ...account, password });
  const reset = resetPasswordSchema.validate({ password });

  expect(Boolean(login.error)).toBe(length > 128);
  expect(Boolean(signup.error)).toBe(length < 6 || length > 30);
  expect(Boolean(reset.error)).toBe(length < 15 || length > 128);
});

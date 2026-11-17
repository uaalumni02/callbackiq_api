import { registerSchema, loginSchema } from '../../src/validator/auth.js';
test('signup and login share Unicode code-point length boundaries, including long astral passwords', () => {
  const signup = password => registerSchema.validate({ email: 'unicode@example.com', password, businessName: 'Synthetic Unicode', termsAccepted: true, privacyAccepted: true }).error;
  const login = password => loginSchema.validate({ login: 'unicode@example.com', password }).error;
  for (const length of [15, 110, 128]) {
    const password = Array.from({ length }, (_, i) => i % 2 ? '🚀' : '😀').join('');
    expect(signup(password)).toBeUndefined(); expect(login(password)).toBeUndefined();
  }
  for (const length of [14, 129]) {
    const password = Array.from({ length }, (_, i) => i % 2 ? '🚀' : '😀').join('');
    expect(signup(password)).toBeTruthy(); expect(login(password)).toBeTruthy();
  }
});

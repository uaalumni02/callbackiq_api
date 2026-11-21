export const PASSWORD_MIN_LENGTH = 15;
export const PASSWORD_MAX_LENGTH = 128;
const SIGNUP_PASSWORD_MIN_LENGTH = 6;
const SIGNUP_PASSWORD_MAX_LENGTH = 30;
const common = new Set(['123456', '1234567', '12345678', '123456789', 'password', 'password1', 'qwerty', 'abc123', 'letmein','passwordpassword', 'password123456789', '123456789012345', '1234567890123456',
  'qwertyuiopasdfgh', 'letmeinletmeinletmein', 'iloveyouiloveyou', 'adminadminadmin', 'welcome123456789']);
export function passwordLengthError(value, minLength = PASSWORD_MIN_LENGTH, maxLength = PASSWORD_MAX_LENGTH) {
  if (typeof value !== 'string') return 'Enter a password.';
  const length = Array.from(value.normalize('NFC')).length;
  return length < minLength || length > maxLength
    ? `Use a password or passphrase of ${minLength}–${maxLength} characters.` : '';
}
export function passwordPolicyError(value, minLength = PASSWORD_MIN_LENGTH, maxLength = PASSWORD_MAX_LENGTH) {
  const lengthError = passwordLengthError(value, minLength, maxLength);
  if (lengthError) return lengthError;
  const normalized = value.normalize('NFC');
  if (/\p{Cc}/u.test(normalized)) return 'Passwords cannot contain control characters.';
  const compact = normalized.toLowerCase().replace(/\s/g, '');
  if (common.has(compact) || /^(.)\1+$/u.test(compact) || /^(\w{1,4})\1{2,}$/.test(compact)) return 'Choose a less common password or passphrase.';
  return '';
}

export function signupPasswordPolicyError(value) {
  return passwordPolicyError(value, SIGNUP_PASSWORD_MIN_LENGTH, SIGNUP_PASSWORD_MAX_LENGTH);
}

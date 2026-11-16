export const PASSWORD_MIN_LENGTH = 15;
export const PASSWORD_MAX_LENGTH = 128;
const common = new Set(['passwordpassword', 'password123456789', '123456789012345', '1234567890123456',
  'qwertyuiopasdfgh', 'letmeinletmeinletmein', 'iloveyouiloveyou', 'adminadminadmin', 'welcome123456789']);
export function passwordPolicyError(value) {
  if (typeof value !== 'string') return 'Enter a password.';
  const normalized = value.normalize('NFC');
  const length = Array.from(normalized).length;
  if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) return 'Use a password or passphrase of 15–128 characters.';
  if (/\p{Cc}/u.test(normalized)) return 'Passwords cannot contain control characters.';
  const compact = normalized.toLowerCase().replace(/\s/g, '');
  if (common.has(compact) || /^(.)\1+$/u.test(compact) || /^(\w{1,4})\1{2,}$/.test(compact)) return 'Choose a less common password or passphrase.';
  return '';
}

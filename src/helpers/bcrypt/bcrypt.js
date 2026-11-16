import bcryptjs from 'bcrypt';
import crypto from 'node:crypto';
// Versioned prehash supports long UTF-8 passphrases without bcrypt's 72-byte truncation.
// The ASCII digest contains no NUL bytes. Existing bcrypt hashes remain readable.
const PREFIX = '$meekcall$bcrypt-sha256$';
const digest = value => crypto.createHash('sha256').update(String(value).normalize('NFC'), 'utf8').digest('base64');
class bcrypt {
  static async hashPassword(password, saltRounds = 10) {
    return PREFIX + await bcryptjs.hash(digest(password), saltRounds);
  }
  static async comparePassword(password, hashedPassword) {
    if (typeof hashedPassword !== 'string') return false;
    return hashedPassword.startsWith(PREFIX)
      ? bcryptjs.compare(digest(password), hashedPassword.slice(PREFIX.length))
      : bcryptjs.compare(password, hashedPassword);
  }
}
export default bcrypt;

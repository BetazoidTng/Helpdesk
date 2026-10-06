// Password hashing using Node's built-in crypto module (scrypt).
// No third-party dependency needed for this.

const crypto = require('crypto');

const KEY_LENGTH = 64;

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const derivedKey = crypto.scryptSync(password, salt, KEY_LENGTH);
    return `${salt}:${derivedKey.toString('hex')}`;
}

function verifyPassword(password, stored) {
    const [salt, hashHex] = stored.split(':');
    if (!salt || !hashHex) return false;
    const derivedKey = crypto.scryptSync(password, salt, KEY_LENGTH);
    const storedBuffer = Buffer.from(hashHex, 'hex');
    if (storedBuffer.length !== derivedKey.length) return false;
    return crypto.timingSafeEqual(storedBuffer, derivedKey);
}

module.exports = { hashPassword, verifyPassword };

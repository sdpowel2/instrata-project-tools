/**
 * AES-256-GCM sealing for Procore tokens at rest.
 *
 * The encryption key comes from TOKEN_ENCRYPTION_KEY and lives ONLY in the
 * process env / secret manager — never in the database. So a stolen DB dump or
 * volume snapshot yields ciphertext with no way to decrypt it. (This does not
 * protect against a full runtime compromise, where the key is already in memory.)
 *
 * Sealed format: base64( iv[12] ‖ authTag[16] ‖ ciphertext ).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_BYTES = 12; // GCM standard nonce length
const TAG_BYTES = 16;

/** Parse TOKEN_ENCRYPTION_KEY (base64 or hex) into a 32-byte key, or throw. */
export function loadKey(raw: string): Buffer {
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    key = Buffer.from(raw, 'base64');
  }
  if (key.length !== 32) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to 32 bytes (got ${key.length}). ` +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  return key;
}

/** Encrypt a UTF-8 string, returning the sealed base64 blob. */
export function seal(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/** Decrypt a sealed base64 blob back to the original string, or throw. */
export function open(key: Buffer, sealed: string): string {
  const buf = Buffer.from(sealed, 'base64');
  if (buf.length < IV_BYTES + TAG_BYTES) {
    throw new Error('Sealed token is truncated or corrupt.');
  }
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

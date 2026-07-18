/**
 * Dedicated-Postgres implementation of TokenStore.
 *
 * Access + refresh tokens are sealed (AES-256-GCM) into a single `sealed` column;
 * the encryption key never touches the database. Non-secret metadata lives in
 * plain columns so we can inspect connections without decrypting.
 *
 * Schema lives in store/db.ts (procore_tokens). This class only reads/writes it.
 */
import type { Pool } from 'pg';
import { loadKey, seal, open } from './crypto.js';
import type { ProcoreTokenRecord, TokenStore } from './tokenStore.js';

type SealedSecrets = { accessToken: string; refreshToken: string };

export class PgTokenStore implements TokenStore {
  private readonly pool: Pool;
  private readonly key: Buffer;

  constructor(pool: Pool, encryptionKey: string) {
    this.pool = pool;
    this.key = loadKey(encryptionKey);
  }

  async get(userId: string): Promise<ProcoreTokenRecord | null> {
    const { rows } = await this.pool.query(
      'SELECT sealed, expires_at, procore_user_id, email, name FROM procore_tokens WHERE user_id = $1',
      [userId],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    const secrets = JSON.parse(open(this.key, r.sealed)) as SealedSecrets;
    return {
      userId,
      accessToken: secrets.accessToken,
      refreshToken: secrets.refreshToken,
      expiresAt: Number(r.expires_at),
      procoreUserId: Number(r.procore_user_id),
      email: r.email ?? undefined,
      name: r.name ?? undefined,
    };
  }

  async put(record: ProcoreTokenRecord): Promise<void> {
    const sealed = seal(
      this.key,
      JSON.stringify({ accessToken: record.accessToken, refreshToken: record.refreshToken }),
    );
    await this.pool.query(
      `INSERT INTO procore_tokens (user_id, sealed, expires_at, procore_user_id, email, name, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (user_id) DO UPDATE SET
         sealed = EXCLUDED.sealed,
         expires_at = EXCLUDED.expires_at,
         procore_user_id = EXCLUDED.procore_user_id,
         email = EXCLUDED.email,
         name = EXCLUDED.name,
         updated_at = now()`,
      [record.userId, sealed, record.expiresAt, record.procoreUserId, record.email ?? null, record.name ?? null],
    );
  }

  async delete(userId: string): Promise<void> {
    await this.pool.query('DELETE FROM procore_tokens WHERE user_id = $1', [userId]);
  }
}

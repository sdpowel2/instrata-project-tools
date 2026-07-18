/**
 * Postgres-backed store for the refresh tokens THIS server issues to Claude.
 * Only a SHA-256 hash is stored (like a password), never the plaintext token.
 * Persisted so a restart doesn't force users to re-authorize (spec criterion #8).
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export type RefreshRecord = { userId: string; clientId: string };

export class PgRefreshTokenStore {
  constructor(private readonly pool: Pool) {}

  async save(token: string, userId: string, clientId: string): Promise<void> {
    await this.pool.query(
      'INSERT INTO oauth_refresh_tokens (token_hash, user_id, client_id) VALUES ($1, $2, $3) ON CONFLICT (token_hash) DO NOTHING',
      [hash(token), userId, clientId],
    );
  }

  async lookup(token: string): Promise<RefreshRecord | null> {
    const { rows } = await this.pool.query(
      'SELECT user_id, client_id FROM oauth_refresh_tokens WHERE token_hash = $1',
      [hash(token)],
    );
    return rows[0] ? { userId: rows[0].user_id, clientId: rows[0].client_id } : null;
  }

  async delete(token: string): Promise<void> {
    await this.pool.query('DELETE FROM oauth_refresh_tokens WHERE token_hash = $1', [hash(token)]);
  }
}

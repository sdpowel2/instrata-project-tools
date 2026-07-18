/**
 * Postgres-backed OAuthRegisteredClientsStore. Persists Dynamic Client
 * Registration records so Claude clients survive restarts (no re-registration).
 * The SDK generates client_id/secret before calling registerClient; we just store
 * the full record as jsonb.
 */
import type { Pool } from 'pg';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

export class PgClientStore implements OAuthRegisteredClientsStore {
  constructor(private readonly pool: Pool) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const { rows } = await this.pool.query('SELECT client FROM oauth_clients WHERE client_id = $1', [clientId]);
    return rows[0]?.client as OAuthClientInformationFull | undefined;
  }

  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    await this.pool.query(
      `INSERT INTO oauth_clients (client_id, client) VALUES ($1, $2)
       ON CONFLICT (client_id) DO UPDATE SET client = EXCLUDED.client`,
      [client.client_id, client],
    );
    return client;
  }
}

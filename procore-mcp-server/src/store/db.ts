/**
 * Shared Postgres pool + schema for the dedicated token/OAuth store.
 *
 * This database is intentionally SEPARATE from the app's Supabase so the Procore
 * trust domain is isolated. All persisted state lives here:
 *   procore_tokens        — per-user Procore tokens (secrets AES-256-GCM sealed)
 *   oauth_clients         — Dynamic Client Registration records (Claude clients)
 *   oauth_refresh_tokens  — refresh tokens THIS server issues to Claude (hashed)
 */
import { Pool } from 'pg';
import { config } from '../config.js';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) pool = new Pool({ connectionString: config.databaseUrl });
  return pool;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS procore_tokens (
  user_id         text PRIMARY KEY,
  sealed          text NOT NULL,
  expires_at      bigint NOT NULL,
  procore_user_id bigint NOT NULL,
  email           text,
  name            text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id  text PRIMARY KEY,
  client     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  token_hash text PRIMARY KEY,
  user_id    text NOT NULL,
  client_id  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

/** Create all tables if absent. Idempotent; safe to run on every boot. */
export async function initDb(): Promise<void> {
  await getPool().query(SCHEMA);
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

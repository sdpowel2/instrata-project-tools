/**
 * Environment configuration. Fails fast at startup on anything missing, so the
 * engine never runs half-configured. All secrets are Fly secrets (spec §9).
 *
 * Required:
 *   DATABASE_URL               postgres://sync_engine.<project-ref>:<pw>@<pooler-host>:5432/postgres
 *                              Session-mode pooler (port 5432) — LISTEN/NOTIFY needs a session.
 *   SYNC_MODE                  dry_run | live. Every outbound write goes through the writeGate.
 *   MONDAY_API_TOKEN           token of the "AVSS Integration" monday user
 *   MONDAY_INTEGRATION_USER_ID that user's monday id — its webhook echoes are ignored (§4.7).
 *                              Not a secret: set in fly.toml [env] (119228546, "AV Integrations").
 *   MONDAY_WEBHOOK_PATH_SECRET path segment monday webhook URLs carry (/webhooks/monday/<secret>)
 *   SF_LOGIN_URL               My Domain URL, e.g. https://instrata--partial.sandbox.my.salesforce.com
 *                              (the Client Credentials flow does NOT work against login.salesforce.com)
 *   SF_CLIENT_ID / SF_CLIENT_SECRET   External Client App consumer key / secret
 *   SF_WEBHOOK_SECRET          value of the X-AVSS-Secret header the Salesforce Flows send
 *   ENGINE_INTERNAL_SECRET     shared with mcp-server + the sync-admin edge function
 * Optional:
 *   DB_SCHEMA                  public (default) | sync_sandbox
 *   MONDAY_API_VERSION         default '2026-07' (monday's "current" version as of 2026-10-11)
 *   SF_API_VERSION             default '66.0' (what the Instrata org serves, checked 2026-10-11)
 *   PUBLIC_BASE_URL            this app's public origin; defaults to https://<FLY_APP_NAME>.fly.dev
 *                              (Fly sets FLY_APP_NAME). monday webhook URLs are built from it.
 *   PORT                       default 8080
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') throw new Error(`Missing required environment variable: ${name}`);
  return v.trim();
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : fallback;
}

export type SyncMode = 'dry_run' | 'live';

function syncMode(): SyncMode {
  const v = required('SYNC_MODE');
  if (v !== 'dry_run' && v !== 'live') throw new Error(`SYNC_MODE must be dry_run or live, got "${v}"`);
  return v;
}

function schemaName(): string {
  const v = optional('DB_SCHEMA', 'public');
  if (!/^[a-z_][a-z0-9_]*$/.test(v)) throw new Error(`DB_SCHEMA must be a plain identifier, got "${v}"`);
  return v;
}

function publicBaseUrl(): string {
  const explicit = process.env.PUBLIC_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const app = process.env.FLY_APP_NAME?.trim();
  if (app) return `https://${app}.fly.dev`;
  throw new Error('Set PUBLIC_BASE_URL (or run on Fly, which provides FLY_APP_NAME)');
}

export interface Env {
  databaseUrl: string;
  dbSchema: string;
  syncMode: SyncMode;
  monday: { token: string; apiVersion: string; integrationUserId: string; webhookPathSecret: string };
  salesforce: { loginUrl: string; clientId: string; clientSecret: string; apiVersion: string; webhookSecret: string };
  internalSecret: string;
  publicBaseUrl: string;
  port: number;
}

export function loadEnv(): Env {
  return {
    databaseUrl: required('DATABASE_URL'),
    dbSchema: schemaName(),
    syncMode: syncMode(),
    monday: {
      token: required('MONDAY_API_TOKEN'),
      apiVersion: optional('MONDAY_API_VERSION', '2026-07'),
      integrationUserId: required('MONDAY_INTEGRATION_USER_ID'),
      webhookPathSecret: required('MONDAY_WEBHOOK_PATH_SECRET'),
    },
    salesforce: {
      loginUrl: required('SF_LOGIN_URL').replace(/\/+$/, ''),
      clientId: required('SF_CLIENT_ID'),
      clientSecret: required('SF_CLIENT_SECRET'),
      apiVersion: optional('SF_API_VERSION', '66.0'),
      webhookSecret: required('SF_WEBHOOK_SECRET'),
    },
    internalSecret: required('ENGINE_INTERNAL_SECRET'),
    publicBaseUrl: publicBaseUrl(),
    port: Number(optional('PORT', '8080')),
  };
}

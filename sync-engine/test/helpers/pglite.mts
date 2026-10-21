/**
 * A real Postgres (PGlite, in-process WASM) loaded with minimal Supabase stubs +
 * the REAL add_sync_and_queue.sql migration, wrapped in the engine's Db interface.
 * Queries run as the `sync_engine` role, like production.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import type { Db, Queryable } from '../../src/db/pool.ts';

const MIGRATION = fileURLToPath(new URL('../../../supabase/migrations/add_sync_and_queue.sql', import.meta.url));

const SUPABASE_STUBS = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth; create schema extensions;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create table public.profiles (id uuid primary key, email text not null, full_name text default '', role text default 'member');
  alter table public.profiles enable row level security;
  create table public.projects (id uuid primary key default gen_random_uuid(), name text);
  alter table public.projects enable row level security;
  create function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin') $$;
  create function public.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
`;

export interface TestDb extends Db {
  pg: PGlite;
}

export async function createTestDb(): Promise<TestDb> {
  const pg = new PGlite();
  await pg.exec(SUPABASE_STUBS);
  await pg.exec(readFileSync(MIGRATION, 'utf8'));
  await pg.exec('set search_path to public, extensions; set role sync_engine;');

  const q: Queryable = { query: async (text, params) => (await pg.query(text, params as any[])) as any };
  return {
    pg,
    query: q.query,
    tx: (fn) => pg.transaction(async (t) => fn({ query: async (text, params) => (await t.query(text, params as any[])) as any })),
    withLock: async (_name, fn) => fn(),
    close: () => pg.close(),
  };
}

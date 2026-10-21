/**
 * Postgres access as the least-privilege `sync_engine` role (plan §1.2).
 *
 * Everything above this file talks to the database through `Queryable` — the
 * one method both `pg` clients and PGlite (used by the tests) share — so the
 * store SQL is exercised against the real migration in test/store.test.mts.
 */
import pg from 'pg';

export interface Queryable {
  query<R = any>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface Db extends Queryable {
  /** Run `fn` in one transaction on one connection. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /**
   * Run `fn` only if no other engine process holds the named advisory lock —
   * guards every scheduled job against an accidental second machine. Returns
   * undefined when the lock was busy.
   */
  withLock<T>(name: string, fn: () => Promise<T>): Promise<T | undefined>;
  close(): Promise<void>;
}

export function createDb(databaseUrl: string, schema: string): Db {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });

  // Unqualified table names resolve to the engine's schema (public or sync_sandbox).
  // search_path is set — and awaited — the first time each pooled connection is
  // handed out. (Firing it from pool.on('connect') raced the caller's first query:
  // pg queued it, but warned that concurrent client.query() is deprecated.)
  const initialized = new WeakSet<pg.PoolClient>();
  async function acquire(): Promise<pg.PoolClient> {
    const client = await pool.connect();
    if (!initialized.has(client)) {
      try {
        await client.query(`set search_path to ${schema}, public`);
      } catch (e) {
        client.release(e as Error);
        throw e;
      }
      initialized.add(client);
    }
    return client;
  }

  return {
    async query(text, params) {
      const client = await acquire();
      try {
        return (await client.query(text, params as any[])) as any;
      } finally {
        client.release();
      }
    },

    async tx(fn) {
      const client = await acquire();
      try {
        await client.query('begin');
        const out = await fn(client);
        await client.query('commit');
        return out;
      } catch (e) {
        await client.query('rollback').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },

    async withLock(name, fn) {
      const client = await acquire();
      try {
        const { rows } = await client.query<{ ok: boolean }>(
          'select pg_try_advisory_lock(hashtext($1)) as ok', [`sync-engine:${schema}:${name}`]);
        if (!rows[0]?.ok) return undefined;
        try {
          return await fn();
        } finally {
          await client.query('select pg_advisory_unlock(hashtext($1))', [`sync-engine:${schema}:${name}`]);
        }
      } finally {
        client.release();
      }
    },

    close: () => pool.end(),
  };
}

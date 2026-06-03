/**
 * Minimal in-memory fixed-window rate limiter, keyed by a string (we use a hash
 * of the bearer token). Good enough for an internal, single-machine service;
 * if this ever scales to multiple machines, move to a shared store (Redis).
 */
import { createHash } from 'node:crypto';
import { config } from './config.js';

type Window = { count: number; resetAt: number };
const windows = new Map<string, Window>();

export function keyFor(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/** Returns true if the request is allowed, false if the per-minute cap is hit. */
export function allow(key: string): boolean {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || now >= w.resetAt) {
    windows.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (w.count >= config.rateLimitPerMin) return false;
  w.count += 1;
  return true;
}

// Periodically drop expired windows so the map can't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, w] of windows) if (now >= w.resetAt) windows.delete(k);
}, 60_000).unref();

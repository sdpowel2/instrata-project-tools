/**
 * Per-user Procore token store. The interface is backend-agnostic so the
 * Postgres implementation (pgTokenStore) can be swapped without touching auth.
 *
 * Secret material (access + refresh tokens) is sealed with AES-256-GCM before it
 * ever reaches the backend; non-secret metadata (expiry, Procore identity) is
 * stored in the clear for lookup/debugging.
 */

export type ProcoreTokenRecord = {
  /** Our internal user id — equals the Procore user id (keyed via /rest/v1.0/me). */
  userId: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch ms at which the access token expires. */
  expiresAt: number;
  /** Procore identity captured at connect time, for whoami + debugging. */
  procoreUserId: number;
  email?: string;
  name?: string;
};

export interface TokenStore {
  /** Fetch a user's decrypted token record, or null if they haven't connected. */
  get(userId: string): Promise<ProcoreTokenRecord | null>;
  /** Insert or replace a user's token record (secrets sealed before write). */
  put(record: ProcoreTokenRecord): Promise<void>;
  /** Remove a user's tokens (disconnect / failed refresh). */
  delete(userId: string): Promise<void>;
}

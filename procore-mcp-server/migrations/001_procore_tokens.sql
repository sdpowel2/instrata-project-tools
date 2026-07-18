-- Encrypted per-user Procore token store (dedicated Postgres — NOT the app's Supabase).
-- Secret material (access + refresh tokens) is AES-256-GCM sealed in `sealed`;
-- the encryption key lives only in the server's env, never in this database.
-- PgTokenStore.init() runs this idempotently on boot; this file is the canonical
-- reference for provisioning the dedicated database.

CREATE TABLE IF NOT EXISTS procore_tokens (
  user_id         text PRIMARY KEY,        -- our user id = Procore user id (/rest/v1.0/me)
  sealed          text NOT NULL,           -- base64(iv‖tag‖ciphertext) of {accessToken, refreshToken}
  expires_at      bigint NOT NULL,         -- epoch ms when the access token expires
  procore_user_id bigint NOT NULL,
  email           text,
  name            text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

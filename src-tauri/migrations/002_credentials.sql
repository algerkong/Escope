-- F08.2: credential reference metadata.
--
-- The connection row records *which* authentication kind it uses and *which* credential
-- reference belongs to it. The secret itself never reaches SQLite: it lives only in the OS
-- credential store and is addressed by `credential_ref`.
--
-- `credential_cleanup` is a persisted outbox. A row means "this reference may exist in the OS
-- store and must not be bound to a connection": `prepare` rows are written before a keyring
-- write, `cleanup` rows when a reference is detached. Both are only removed after the secret
-- is gone (or the write is known not to have happened).
ALTER TABLE connections ADD COLUMN auth_kind TEXT NOT NULL DEFAULT 'none'
  CHECK (auth_kind IN ('none', 'basic', 'apiKey', 'bearer'));
ALTER TABLE connections ADD COLUMN credential_ref TEXT
  CHECK (credential_ref IS NULL OR length(credential_ref) = 36);

CREATE TABLE credential_cleanup (
  reference TEXT PRIMARY KEY CHECK (length(reference) = 36),
  reason TEXT NOT NULL CHECK (reason IN ('prepare', 'cleanup')),
  queued_at INTEGER NOT NULL CHECK (queued_at >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);

PRAGMA user_version = 2;

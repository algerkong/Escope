-- A01.2/A02.3: model credential reference metadata.
--
-- A model row records *which* credential reference belongs to it. The secret itself never reaches
-- SQLite: it lives only in the OS credential store and is addressed by `credential_ref`. Clearing
-- the reference and queuing it in the shared `credential_cleanup` outbox (see 002) is the only way
-- a model stops using a key, and a queued reference is deleted from the OS store only after no
-- connection and no model row references it.
ALTER TABLE model_profiles ADD COLUMN credential_ref TEXT
  CHECK (credential_ref IS NULL OR length(credential_ref) = 36);

PRAGMA user_version = 4;

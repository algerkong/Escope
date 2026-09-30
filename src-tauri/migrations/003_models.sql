-- A01: model profile metadata.
--
-- A model profile is configuration metadata only: a stable id, a display name, the wire protocol,
-- a base endpoint and the model id the user typed. No secret, header, credential reference or
-- prompt is stored here, so a saved profile can never be mistaken for an authenticated provider or
-- for a model that has been verified. The protocol list is closed and mirrors the adapters that
-- are actually implemented; adding one means changing this CHECK and `ModelProtocol` together.
--
-- `workspace.default_model_id` remembers the user's default selection. It is nullable on purpose:
-- with no profile there is no default, and a stored id that no longer names a row is resolved to
-- the first profile on read instead of failing.
CREATE TABLE model_profiles (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  protocol TEXT NOT NULL CHECK (protocol IN ('openaiCompatible', 'ollama')),
  endpoint TEXT NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 2048),
  model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 200),
  sort_order INTEGER NOT NULL CHECK (sort_order BETWEEN 0 AND 1000000)
);
ALTER TABLE workspace ADD COLUMN default_model_id TEXT
  CHECK (default_model_id IS NULL OR length(default_model_id) = 36);

PRAGMA user_version = 3;

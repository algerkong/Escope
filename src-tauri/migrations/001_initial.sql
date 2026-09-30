CREATE TABLE preferences (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  json TEXT NOT NULL CHECK (length(json) <= 16384)
);
CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('development', 'staging', 'production')),
  sort_order INTEGER NOT NULL
);
CREATE TABLE workspace (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  active_connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL
);
INSERT INTO workspace(singleton, active_connection_id) VALUES (1, NULL);
PRAGMA user_version = 1;

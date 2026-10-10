-- Literal definitions only, with no execution or trusted session bindings.
-- Connection deletion retains historical IDs. Reads never create a row.
CREATE TABLE pinned_filter_library (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  json TEXT NOT NULL CHECK (length(CAST(json AS BLOB)) <= 262144)
);

PRAGMA user_version = 8;

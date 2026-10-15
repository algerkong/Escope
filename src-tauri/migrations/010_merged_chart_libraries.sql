-- The two v9 branches used different chart libraries. Preserve both documents verbatim.
CREATE TABLE IF NOT EXISTS saved_chart_library (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  json TEXT NOT NULL CHECK (length(CAST(json AS BLOB)) <= 262144)
);

CREATE TABLE IF NOT EXISTS chart_definition_library (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  json TEXT NOT NULL CHECK (length(CAST(json AS BLOB)) <= 262144)
);

PRAGMA user_version = 10;

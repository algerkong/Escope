-- Chart definitions only: group/metric literals and a plotted measure per saved target.
-- No results, endpoints, credentials or evidence. Connection deletion retains historical IDs.
-- Reads never insert a row; revision 0 denotes the absent row. Bounds mirror chart_definitions.rs.
CREATE TABLE chart_definition_library (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  json TEXT NOT NULL CHECK (length(CAST(json AS BLOB)) <= 262144)
);

PRAGMA user_version = 9;

-- Saved chart and aggregation definitions.
-- Local definitions only. Connection IDs are retained when a connection is deleted.
-- Reads never insert; revision 0 denotes the absent row. Bounds mirror saved_charts.rs.
CREATE TABLE saved_chart_library (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  json TEXT NOT NULL CHECK (length(CAST(json AS BLOB)) <= 262144)
);

PRAGMA user_version = 9;

-- C05.3/C04.1: per-connection custom CA metadata and the saved-query library.
--
-- `connections.ca_pem` holds one bounded PEM chain of *public* certificates (no private key),
-- validated by `connection_tls` before it is stored. The column is nullable: no custom CA means
-- the default (platform/webpki) trust roots stay in effect, and certificate verification is
-- never disabled.
--
-- `saved_query_library` is the single-row storage of the Q07 saved-query document. The bound is
-- the same 4 MiB the IPC layer enforces; typed validation stays in `saved_queries.rs`.
ALTER TABLE connections ADD COLUMN ca_pem TEXT
  CHECK (ca_pem IS NULL OR (length(ca_pem) BETWEEN 1 AND 65536));

CREATE TABLE saved_query_library (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  json TEXT NOT NULL CHECK (length(json) <= 4194304)
);

PRAGMA user_version = 5;

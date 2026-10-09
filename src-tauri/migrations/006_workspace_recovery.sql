-- Q07 second batch: the workspace/tab/history recovery document.
--
-- `workspace_recovery` is the singleton row for the recovery document, separate from
-- `saved_query_library`. `revision` is the compare-and-swap counter: a save is applied only when
-- the caller's expected revision still matches what is stored (0 means the row does not exist
-- yet), so a stale session can never overwrite a newer document.
--
-- The byte CHECK counts UTF-8 bytes (`length(CAST(json AS BLOB))`), not characters, and mirrors
-- `MAX_RECOVERY_BYTES` in `workspace_recovery.rs` (4 MiB workspace + 4 MiB history + 1 KiB).
-- The revision CHECK mirrors the JS-safe integer bound; both bounds are re-checked by the IPC
-- layer before any write.
CREATE TABLE workspace_recovery (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  json TEXT NOT NULL CHECK (length(CAST(json AS BLOB)) <= 8389632)
);

PRAGMA user_version = 6;

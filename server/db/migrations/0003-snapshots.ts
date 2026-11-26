export const snapshotsSql = `
  ALTER TABLE snapshots ADD COLUMN controller_scope TEXT;
  CREATE INDEX snapshots_scope_ts_id ON snapshots(controller_scope, ts, id);

  CREATE TABLE snapshot_restore_ids (
    scope TEXT NOT NULL,
    resource TEXT NOT NULL,
    original_id TEXT NOT NULL,
    current_id TEXT NOT NULL,
    PRIMARY KEY (scope, resource, original_id)
  );

  CREATE TABLE unifi_log_entries (
    scope TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (scope, fingerprint)
  );
  CREATE INDEX unifi_log_entries_ts ON unifi_log_entries(ts);
`

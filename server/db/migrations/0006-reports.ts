export const reportsSql = `
  ALTER TABLE egress_samples ADD COLUMN interval_ms INTEGER;
  CREATE TABLE egress_report_archive (
    egress_id TEXT NOT NULL REFERENCES egresses(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    samples BLOB NOT NULL,
    PRIMARY KEY (egress_id, ts)
  );
  ALTER TABLE speedtests ADD COLUMN controller_scope TEXT;
  CREATE INDEX speedtests_scope_ts ON speedtests(controller_scope, ts);
`

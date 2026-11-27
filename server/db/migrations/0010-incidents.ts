export const incidentsSql = `
  ALTER TABLE infra_devices ADD COLUMN last_uplink TEXT;
  ALTER TABLE infra_devices ADD COLUMN offline_planned INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE device_samples ADD COLUMN planned INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE device_transitions ADD COLUMN planned INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE device_rollups_hourly ADD COLUMN report_minutes TEXT;
  ALTER TABLE poe_applied ADD COLUMN label TEXT;
  ALTER TABLE poe_grace ADD COLUMN label TEXT;

  CREATE TABLE incidents (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    opened_at INTEGER NOT NULL,
    latest_at INTEGER NOT NULL,
    resolved_at INTEGER,
    status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
    severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
    title_key TEXT NOT NULL,
    title_params TEXT NOT NULL,
    root TEXT NOT NULL,
    impact TEXT NOT NULL,
    affected_nodes TEXT NOT NULL,
    baseline_clients INTEGER NOT NULL,
    signal_count INTEGER NOT NULL,
    suspect_count INTEGER NOT NULL,
    acknowledged INTEGER NOT NULL DEFAULT 0,
    note TEXT
  );
  CREATE INDEX incidents_scope_status_opened ON incidents (scope, status, opened_at, id);
  CREATE INDEX incidents_opened ON incidents (opened_at);

  CREATE TABLE incident_signals (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    incident_id TEXT REFERENCES incidents(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL,
    ref TEXT,
    message_key TEXT NOT NULL,
    message_params TEXT NOT NULL,
    suspect INTEGER NOT NULL DEFAULT 0,
    facts TEXT NOT NULL
  );
  CREATE INDEX incident_signals_incident_ts ON incident_signals (incident_id, ts);
  CREATE INDEX incident_signals_scope_ts ON incident_signals (scope, kind, ts);

  CREATE TABLE incident_wan_state (
    scope TEXT NOT NULL,
    egress_id TEXT NOT NULL,
    up INTEGER NOT NULL,
    PRIMARY KEY (scope, egress_id)
  );
`

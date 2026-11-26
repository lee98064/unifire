const port = 'scope TEXT NOT NULL, switch_mac TEXT NOT NULL, port_idx INTEGER NOT NULL'
const key = 'scope, switch_mac, port_idx'
const bucket = `
  ${port}, ts INTEGER NOT NULL, observed INTEGER NOT NULL, up INTEGER NOT NULL,
  speed REAL, rx REAL, rx_count INTEGER NOT NULL, tx REAL, tx_count INTEGER NOT NULL,
  errors REAL, drops REAL, poe REAL, poe_count INTEGER NOT NULL,
  on_w REAL, on_count INTEGER NOT NULL, PRIMARY KEY (${key}, ts)
`

export const portsPoeSql = `
CREATE TABLE port_state (
  ${port}, first_seen INTEGER NOT NULL, at INTEGER NOT NULL, up INTEGER NOT NULL, speed REAL, duplex INTEGER,
  peer_mac TEXT, peer_kind TEXT, speeds TEXT NOT NULL, baseline_speed REAL, below INTEGER NOT NULL,
  downgraded INTEGER NOT NULL, counters TEXT NOT NULL, error_at INTEGER, flap_at INTEGER, last_drop INTEGER,
  PRIMARY KEY (${key})
);
CREATE TABLE port_peers (
  ${port}, mac TEXT NOT NULL, name TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, max_speed REAL,
  PRIMARY KEY (${key}, mac)
);
CREATE TABLE port_deltas (
  ${port}, ts INTEGER NOT NULL, errors REAL, packets REAL, flaps INTEGER NOT NULL, PRIMARY KEY (${key}, ts)
);
CREATE INDEX port_deltas_ts ON port_deltas(ts);
CREATE TABLE port_samples (${bucket});
CREATE INDEX port_samples_ts ON port_samples(ts);
CREATE TABLE port_rollups_hourly (${bucket});
CREATE INDEX port_rollups_ts ON port_rollups_hourly(ts);
CREATE TABLE port_events (
  ${port}, id TEXT PRIMARY KEY NOT NULL, ts INTEGER NOT NULL, switch_name TEXT NOT NULL, port_name TEXT,
  kind TEXT NOT NULL, severity TEXT NOT NULL, message_key TEXT NOT NULL, message_params TEXT NOT NULL,
  data TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX port_events_scope_ts ON port_events(scope, ts, id);
CREATE INDEX port_events_port_ts ON port_events(scope, switch_mac, port_idx, ts);
CREATE TABLE poe_schedules (
  ${port}, id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, off_windows TEXT NOT NULL, timezone TEXT NOT NULL,
  mode TEXT NOT NULL, enabled INTEGER NOT NULL, acknowledged_ap INTEGER NOT NULL, status TEXT NOT NULL,
  reason_key TEXT, reason_params TEXT NOT NULL, last_applied_at INTEGER, created_at INTEGER NOT NULL,
  UNIQUE (${key})
);
CREATE TABLE poe_overrides (
  ${port}, is_on INTEGER NOT NULL, ends_at INTEGER, source TEXT NOT NULL, rule_id TEXT, acknowledged_ap INTEGER NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY (${key})
);
CREATE TABLE poe_applied (
  ${port}, previous_mode TEXT NOT NULL, created_entry INTEGER NOT NULL, at INTEGER NOT NULL, schedule_id TEXT,
  source TEXT NOT NULL, phase TEXT NOT NULL, PRIMARY KEY (${key})
);
CREATE TABLE poe_grace (${port}, until INTEGER NOT NULL, PRIMARY KEY (${key}));
CREATE TABLE poe_off_log (
  ${port}, start INTEGER NOT NULL, end INTEGER, schedule_id TEXT NOT NULL, schedule_name TEXT NOT NULL, avg_w REAL,
  PRIMARY KEY (${key}, start)
);
CREATE INDEX poe_off_log_period ON poe_off_log(scope, start);
CREATE TABLE energy_hourly (
  ${port}, hour_ts INTEGER NOT NULL, wh REAL NOT NULL, sampled_ms INTEGER NOT NULL, peer_name TEXT, port_name TEXT,
  PRIMARY KEY (${key}, hour_ts)
);
CREATE INDEX energy_hourly_period ON energy_hourly(scope, hour_ts);
CREATE TABLE energy_last (${port}, at INTEGER NOT NULL, PRIMARY KEY (${key}));
`

export const infraSql = `
CREATE TABLE infra_devices (
  mac TEXT PRIMARY KEY NOT NULL,
  site TEXT NOT NULL,
  scope TEXT NOT NULL,
  unifi_id TEXT,
  name TEXT NOT NULL,
  model TEXT,
  model_name TEXT,
  type TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER,
  last_state TEXT NOT NULL,
  firmware TEXT,
  upgrade_to TEXT,
  last_uptime REAL,
  uptime_at INTEGER,
  offline_since INTEGER,
  upgrading INTEGER NOT NULL DEFAULT 0,
  room_id TEXT,
  locate_until INTEGER
);
CREATE INDEX infra_devices_scope ON infra_devices(scope);
CREATE TABLE device_samples (
  mac TEXT NOT NULL REFERENCES infra_devices(mac) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  state TEXT NOT NULL,
  uptime REAL,
  cpu REAL,
  mem REAL,
  temp REAL,
  clients INTEGER,
  rx_bps REAL,
  tx_bps REAL,
  poe_w REAL,
  PRIMARY KEY (mac, ts)
);
CREATE INDEX device_samples_ts ON device_samples(ts);
CREATE TABLE device_rollups_hourly (
  mac TEXT NOT NULL REFERENCES infra_devices(mac) ON DELETE CASCADE,
  hour_ts INTEGER NOT NULL,
  online_fraction REAL NOT NULL,
  cpu_avg REAL, cpu_max REAL,
  mem_avg REAL, mem_max REAL,
  temp_avg REAL, temp_max REAL,
  clients_avg REAL, clients_max REAL,
  rx_avg REAL, rx_max REAL,
  tx_avg REAL, tx_max REAL,
  poe_w_avg REAL,
  PRIMARY KEY (mac, hour_ts)
);
CREATE INDEX device_rollups_hourly_ts ON device_rollups_hourly(hour_ts);
CREATE TABLE device_transitions (
  id INTEGER PRIMARY KEY,
  mac TEXT NOT NULL REFERENCES infra_devices(mac) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason TEXT,
  down_sec REAL
);
CREATE INDEX device_transitions_mac_ts ON device_transitions(mac, ts);
CREATE TABLE firmware_history (
  id INTEGER PRIMARY KEY,
  mac TEXT NOT NULL REFERENCES infra_devices(mac) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  from_version TEXT,
  to_version TEXT NOT NULL
);
CREATE INDEX firmware_history_mac_ts ON firmware_history(mac, ts);
`

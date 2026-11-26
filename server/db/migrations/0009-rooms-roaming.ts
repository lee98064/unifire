export const roomsRoamingSql = `
CREATE TABLE rooms (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, floor TEXT, icon TEXT, color TEXT,
  "order" INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE ap_rooms (
  ap_mac TEXT PRIMARY KEY NOT NULL REFERENCES infra_devices(mac) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE
);
UPDATE infra_devices SET room_id = NULL;
CREATE TABLE room_segments (
  id TEXT PRIMARY KEY NOT NULL, scope TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE, room_id TEXT, ap_mac TEXT,
  start INTEGER NOT NULL, end INTEGER
);
CREATE UNIQUE INDEX room_segments_open ON room_segments (scope, person_id) WHERE end IS NULL;
CREATE INDEX room_segments_range ON room_segments (scope, start);
CREATE INDEX room_segments_end ON room_segments (end);

CREATE TABLE client_roams (
  id TEXT PRIMARY KEY NOT NULL, scope TEXT NOT NULL, mac TEXT NOT NULL, ts INTEGER NOT NULL,
  from_ap_mac TEXT NOT NULL, to_ap_mac TEXT NOT NULL, from_signal REAL, to_signal REAL,
  band TEXT, channel INTEGER, source TEXT NOT NULL
);
CREATE INDEX client_roams_client ON client_roams (scope, mac, ts);
CREATE INDEX client_roams_from_ap ON client_roams (scope, from_ap_mac, ts);
CREATE INDEX client_roams_to_ap ON client_roams (scope, to_ap_mac, ts);
CREATE INDEX client_roams_ts ON client_roams (ts);
CREATE TABLE client_rf_minutes (
  scope TEXT NOT NULL, mac TEXT NOT NULL, ts INTEGER NOT NULL, ap_mac TEXT NOT NULL, signal REAL,
  PRIMARY KEY (scope, mac, ts)
);
CREATE INDEX client_rf_minutes_ts ON client_rf_minutes (ts);
CREATE TABLE sticky_flags (
  scope TEXT NOT NULL, mac TEXT NOT NULL, ap_mac TEXT NOT NULL, signal REAL NOT NULL,
  since INTEGER NOT NULL, other_aps INTEGER NOT NULL, status TEXT NOT NULL, recovered_at INTEGER,
  PRIMARY KEY (scope, mac)
);
CREATE INDEX sticky_flags_recovery ON sticky_flags (recovered_at);
CREATE TABLE sticky_nudges (
  id TEXT PRIMARY KEY NOT NULL, scope TEXT NOT NULL, mac TEXT NOT NULL, ts INTEGER NOT NULL
);
CREATE INDEX sticky_nudges_client ON sticky_nudges (scope, mac, ts);
CREATE INDEX sticky_nudges_ts ON sticky_nudges (ts);
`

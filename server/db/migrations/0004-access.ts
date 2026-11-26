export const accessSql = `
  -- WP2 inserted pending rows even during the controller's initial import.
  UPDATE clients SET approval = 'approved', detected_at = NULL
    WHERE approval = 'pending' AND first_seen < (SELECT MIN(detected_at) FROM clients);
  INSERT OR IGNORE INTO settings (key, value)
    SELECT 'access.clientBaseline', json_quote(CASE WHEN url = 'mock://unifire' THEN 'mock:default'
      ELSE '' || json_array(url, site) END)
    FROM controller WHERE id = 1 AND EXISTS (SELECT 1 FROM clients);

  -- Legacy ownership lacked a controller identity. Keep the desired reasons.
  UPDATE blocks SET applied = 0 WHERE applied = 1;
  CREATE TABLE applied_client_blocks (
    controller_scope TEXT NOT NULL,
    mac TEXT NOT NULL REFERENCES clients(mac) ON DELETE CASCADE,
    PRIMARY KEY (controller_scope, mac)
  );

  CREATE TABLE group_pauses (
    group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
    until INTEGER,
    reason TEXT
  );

  CREATE TABLE usage_quarters (
    mac TEXT NOT NULL,
    ts INTEGER NOT NULL,
    rx_bytes INTEGER NOT NULL,
    tx_bytes INTEGER NOT NULL,
    active_mask INTEGER NOT NULL,
    sample_mask INTEGER NOT NULL,
    PRIMARY KEY (mac, ts)
  );
  CREATE INDEX usage_quarters_ts ON usage_quarters(ts);

  ALTER TABLE extension_requests ADD COLUMN period_start INTEGER;
  ALTER TABLE extension_requests ADD COLUMN expires_at INTEGER;
  UPDATE extension_requests SET status = 'expired', decided_at = created_at
    WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY person_id ORDER BY created_at DESC, id DESC) AS rank
        FROM extension_requests WHERE status = 'pending'
      ) WHERE rank > 1
    );
  CREATE UNIQUE INDEX extension_requests_one_pending ON extension_requests(person_id) WHERE status = 'pending';

  ALTER TABLE presence_sessions ADD COLUMN offline_since INTEGER;

  CREATE TABLE quota_transitions (
    quota_id TEXT NOT NULL REFERENCES quotas(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    period_start INTEGER NOT NULL,
    period_end INTEGER NOT NULL,
    state TEXT NOT NULL,
    warned INTEGER NOT NULL,
    exceeded INTEGER NOT NULL,
    PRIMARY KEY (quota_id, subject)
  );

  CREATE TABLE quota_routes (
    controller_scope TEXT NOT NULL,
    subject TEXT NOT NULL,
    route_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    PRIMARY KEY (controller_scope, subject),
    UNIQUE (controller_scope, route_id)
  );
`

export const routingSql = `
  ALTER TABLE managed_routes ADD COLUMN controller_scope TEXT;
  ALTER TABLE managed_routes ADD COLUMN route_shape TEXT;
  ALTER TABLE managed_routes ADD COLUMN failover_primary TEXT;
  ALTER TABLE managed_routes ADD COLUMN failover_egress TEXT;
  ALTER TABLE managed_routes ADD COLUMN failover_recover_since INTEGER;

  CREATE TABLE route_observations (
    scope TEXT NOT NULL,
    route_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    egress_id TEXT,
    PRIMARY KEY (scope, route_id)
  );
  CREATE TABLE route_external_changes (
    scope TEXT NOT NULL,
    route_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    egress_changed INTEGER NOT NULL,
    PRIMARY KEY (scope, route_id, ts)
  );
  CREATE INDEX route_external_changes_ts ON route_external_changes(ts);

  ALTER TABLE egresses ADD COLUMN probe_route_scope TEXT;

  CREATE TABLE egress_health (
    egress_id TEXT PRIMARY KEY REFERENCES egresses(id) ON DELETE CASCADE,
    value TEXT NOT NULL,
    failed_rounds INTEGER NOT NULL
  );
  ALTER TABLE egress_samples ADD COLUMN source TEXT NOT NULL DEFAULT 'probe';
  CREATE TABLE egress_sample_rollups (
    egress_id TEXT NOT NULL REFERENCES egresses(id) ON DELETE CASCADE,
    resolution INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    latency_total REAL NOT NULL,
    latency_count INTEGER NOT NULL,
    loss_total REAL NOT NULL,
    loss_count INTEGER NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY (egress_id, resolution, ts)
  );
  CREATE TABLE egress_health_transitions (
    egress_id TEXT NOT NULL REFERENCES egresses(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY (egress_id, ts)
  );
`

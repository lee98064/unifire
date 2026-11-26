// Initial DDL generated from server/db/schema.ts with drizzle-kit.
// Keep this migration immutable after release.
export const initialSql = `
CREATE TABLE "allowances" (
	"id" text PRIMARY KEY NOT NULL,
	"person_id" text NOT NULL,
	"starts_at" integer NOT NULL,
	"until" integer NOT NULL,
	FOREIGN KEY ("person_id") REFERENCES "people"("id") ON UPDATE no action ON DELETE cascade
);

CREATE INDEX "allowances_person_until" ON "allowances" ("person_id","until");
CREATE INDEX "allowances_until" ON "allowances" ("until");
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"ts" integer NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"actor_name" text,
	"category" text NOT NULL,
	"action" text NOT NULL,
	"severity" text NOT NULL,
	"target" text,
	"message_key" text NOT NULL,
	"message_params" text NOT NULL,
	"diff" text,
	"dry_run" integer NOT NULL
);

CREATE INDEX "audit_events_ts_id" ON "audit_events" ("ts","id");
CREATE INDEX "audit_events_category_ts" ON "audit_events" ("category","ts","id");
CREATE INDEX "audit_events_actor_ts" ON "audit_events" ("actor_type","ts","id");
CREATE TABLE "blocks" (
	"id" text PRIMARY KEY NOT NULL,
	"mac" text NOT NULL,
	"source" text NOT NULL,
	"ref_id" text,
	"label" text NOT NULL,
	"until" integer,
	"applied" integer DEFAULT false NOT NULL,
	FOREIGN KEY ("mac") REFERENCES "clients"("mac") ON UPDATE no action ON DELETE cascade
);

CREATE UNIQUE INDEX "blocks_mac_source_ref" ON "blocks" ("mac","source",coalesce("ref_id", ''));
CREATE INDEX "blocks_until" ON "blocks" ("until");
CREATE TABLE "clients" (
	"mac" text PRIMARY KEY NOT NULL,
	"alias" text,
	"note" text,
	"hostname" text,
	"vendor" text,
	"randomized_mac" integer DEFAULT false NOT NULL,
	"approval" text DEFAULT 'pending' NOT NULL,
	"first_seen" integer,
	"last_seen" integer,
	"detected_at" integer
);

CREATE INDEX "clients_last_seen" ON "clients" ("last_seen");
CREATE INDEX "clients_approval_detected" ON "clients" ("approval","detected_at");
CREATE TABLE "controller" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"url" text NOT NULL,
	"username" text NOT NULL,
	"encrypted_password" text NOT NULL,
	"site" text DEFAULT 'default' NOT NULL,
	"verify_mode" text DEFAULT 'fingerprint' NOT NULL,
	"fingerprint" text,
	"ca_pem" text,
	"mode" text DEFAULT 'dry-run' NOT NULL,
	"self_mac" text,
	"self_ip" text,
	"self_mac_override" text,
	"self_ip_override" text,
	"capabilities" text DEFAULT '[]' NOT NULL,
	"network_version" text,
	"console_version" text,
	"model" text,
	"timezone" text,
	"last_sync_at" integer,
	CONSTRAINT "controller_singleton" CHECK("controller"."id" = 1)
);

CREATE TABLE "egress_ip_checks" (
	"egress_id" text NOT NULL,
	"ts" integer NOT NULL,
	"ip" text,
	"country" text,
	"colo" text,
	"latency_ms" real,
	"changed" integer DEFAULT false NOT NULL,
	"error" text,
	PRIMARY KEY("egress_id", "ts"),
	FOREIGN KEY ("egress_id") REFERENCES "egresses"("id") ON UPDATE no action ON DELETE cascade
);

CREATE INDEX "egress_ip_checks_ts" ON "egress_ip_checks" ("ts");
CREATE TABLE "egress_samples" (
	"egress_id" text NOT NULL,
	"ts" integer NOT NULL,
	"latency_ms" real,
	"loss_pct" real,
	"jitter_ms" real,
	"status" text NOT NULL,
	PRIMARY KEY("egress_id", "ts"),
	FOREIGN KEY ("egress_id") REFERENCES "egresses"("id") ON UPDATE no action ON DELETE cascade
);

CREATE INDEX "egress_samples_ts" ON "egress_samples" ("ts");
CREATE TABLE "egresses" (
	"id" text PRIMARY KEY NOT NULL,
	"controller_id" integer DEFAULT 1 NOT NULL,
	"site" text DEFAULT 'default' NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"wan_group" text,
	"color" text NOT NULL,
	"enabled" integer DEFAULT true NOT NULL,
	"probe_enabled" integer DEFAULT false NOT NULL,
	"probe_ip" text,
	"probe_route_id" text,
	FOREIGN KEY ("controller_id") REFERENCES "controller"("id") ON UPDATE no action ON DELETE no action
);

CREATE INDEX "egresses_controller_site" ON "egresses" ("controller_id","site");
CREATE TABLE "extension_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"person_id" text NOT NULL,
	"quota_id" text,
	"amount" real NOT NULL,
	"granted_amount" real,
	"reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" integer NOT NULL,
	"decided_at" integer,
	"decided_by" text,
	FOREIGN KEY ("person_id") REFERENCES "people"("id") ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY ("quota_id") REFERENCES "quotas"("id") ON UPDATE no action ON DELETE set null
);

CREATE INDEX "extension_requests_person_ts" ON "extension_requests" ("person_id","created_at");
CREATE INDEX "extension_requests_status_ts" ON "extension_requests" ("status","created_at");
CREATE INDEX "extension_requests_quota" ON "extension_requests" ("quota_id");
CREATE TABLE "groups" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL
);

CREATE TABLE "guest_wifi" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"wlan_id" text,
	"ssid" text,
	"enabled" integer NOT NULL,
	"rotation" text NOT NULL,
	"encrypted_passphrase" text,
	"encrypted_kiosk_token" text,
	"kiosk_token_hash" text,
	"last_rotated_at" integer,
	"next_rotation_at" integer,
	CONSTRAINT "guest_wifi_singleton" CHECK("guest_wifi"."id" = 1)
);

CREATE UNIQUE INDEX "guest_wifi_kiosk_token_hash_unique" ON "guest_wifi" ("kiosk_token_hash");
CREATE TABLE "leases" (
	"name" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"expires_at" integer NOT NULL
);

CREATE TABLE "managed_routes" (
	"id" text PRIMARY KEY NOT NULL,
	"controller_id" integer DEFAULT 1 NOT NULL,
	"site" text DEFAULT 'default' NOT NULL,
	"unifi_route_id" text NOT NULL,
	"name" text NOT NULL,
	"baseline_fingerprint" text NOT NULL,
	"default_egress_id" text NOT NULL,
	"failover" text NOT NULL,
	"enabled" integer DEFAULT true NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"state_detail" text,
	"created_by_unifire" integer DEFAULT false NOT NULL,
	"created_at" integer NOT NULL,
	"last_switch_at" integer,
	FOREIGN KEY ("controller_id") REFERENCES "controller"("id") ON UPDATE no action ON DELETE no action
);

CREATE UNIQUE INDEX "managed_routes_controller_route" ON "managed_routes" ("controller_id","site","unifi_route_id");
CREATE TABLE "notification_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"enabled" integer NOT NULL,
	"encrypted_config" text NOT NULL,
	"events" text NOT NULL,
	"last_sent_at" integer,
	"last_error" text
);

CREATE TABLE "passkeys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" integer NOT NULL,
	"backed_up" integer NOT NULL,
	"transports" text,
	"aaguid" text,
	"created_at" integer NOT NULL,
	"last_used_at" integer,
	FOREIGN KEY ("user_id") REFERENCES "users"("id") ON UPDATE no action ON DELETE cascade
);

CREATE INDEX "passkeys_user" ON "passkeys" ("user_id");
CREATE TABLE "pause_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"person_id" text NOT NULL,
	"days" text NOT NULL,
	"start" text NOT NULL,
	"end" text NOT NULL,
	"enabled" integer DEFAULT true NOT NULL,
	FOREIGN KEY ("person_id") REFERENCES "people"("id") ON UPDATE no action ON DELETE cascade
);

CREATE INDEX "pause_schedules_person" ON "pause_schedules" ("person_id");
CREATE TABLE "people" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"avatar" text NOT NULL,
	"color" text NOT NULL,
	"paused" integer DEFAULT false NOT NULL,
	"paused_until" integer,
	"pause_reason" text,
	"created_at" integer NOT NULL
);

CREATE TABLE "person_devices" (
	"mac" text PRIMARY KEY NOT NULL,
	"person_id" text NOT NULL,
	"presence" integer DEFAULT false NOT NULL,
	FOREIGN KEY ("mac") REFERENCES "clients"("mac") ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY ("person_id") REFERENCES "people"("id") ON UPDATE no action ON DELETE cascade
);

CREATE INDEX "person_devices_person" ON "person_devices" ("person_id");
CREATE TABLE "person_groups" (
	"person_id" text NOT NULL,
	"group_id" text NOT NULL,
	PRIMARY KEY("person_id", "group_id"),
	FOREIGN KEY ("person_id") REFERENCES "people"("id") ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON UPDATE no action ON DELETE cascade
);

CREATE INDEX "person_groups_group" ON "person_groups" ("group_id");
CREATE TABLE "poe_watchdogs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"target_mac" text,
	"target_ip" text NOT NULL,
	"method" text NOT NULL,
	"tcp_port" integer,
	"interval_sec" integer NOT NULL,
	"fail_threshold" integer NOT NULL,
	"cooldown_min" integer NOT NULL,
	"max_cycles_per_day" integer NOT NULL,
	"switch_mac" text NOT NULL,
	"switch_name" text,
	"port_idx" integer NOT NULL,
	"enabled" integer NOT NULL,
	"state" text NOT NULL
);

CREATE UNIQUE INDEX "poe_watchdogs_switch_port" ON "poe_watchdogs" ("switch_mac","port_idx");
CREATE TABLE "presence_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"person_id" text NOT NULL,
	"mac" text NOT NULL,
	"start" integer NOT NULL,
	"end" integer,
	FOREIGN KEY ("person_id") REFERENCES "people"("id") ON UPDATE no action ON DELETE cascade
);

CREATE INDEX "presence_sessions_person_start" ON "presence_sessions" ("person_id","start");
CREATE INDEX "presence_sessions_start" ON "presence_sessions" ("start");
CREATE INDEX "presence_sessions_mac" ON "presence_sessions" ("mac");
CREATE TABLE "push_action_tokens" (
	"token_hash" blob PRIMARY KEY NOT NULL,
	"user_id" text,
	"action" text NOT NULL,
	"payload" text NOT NULL,
	"expires_at" integer NOT NULL,
	"used_at" integer,
	FOREIGN KEY ("user_id") REFERENCES "users"("id") ON UPDATE no action ON DELETE cascade
);

CREATE INDEX "push_action_tokens_expiry" ON "push_action_tokens" ("expires_at");
CREATE INDEX "push_action_tokens_user" ON "push_action_tokens" ("user_id");
CREATE TABLE "push_subscriptions" (
	"endpoint" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"encrypted_keys" text NOT NULL,
	"device_label" text,
	"created_at" integer NOT NULL,
	FOREIGN KEY ("user_id") REFERENCES "users"("id") ON UPDATE no action ON DELETE cascade
);

CREATE INDEX "push_subscriptions_user" ON "push_subscriptions" ("user_id");
CREATE TABLE "quotas" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"metric" text NOT NULL,
	"period" text NOT NULL,
	"limit" real NOT NULL,
	"weekday_limits" text,
	"warn_at_pct" real DEFAULT 80 NOT NULL,
	"action" text NOT NULL,
	"enabled" integer DEFAULT true NOT NULL
);

CREATE INDEX "quotas_scope" ON "quotas" ("scope_type","scope_id");
CREATE TABLE "route_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"managed_route_id" text NOT NULL,
	"egress_id" text NOT NULL,
	"starts_at" integer NOT NULL,
	"ends_at" integer NOT NULL,
	"reason" text,
	"created_by" text NOT NULL,
	FOREIGN KEY ("managed_route_id") REFERENCES "managed_routes"("id") ON UPDATE no action ON DELETE cascade
);

CREATE INDEX "route_overrides_route_end" ON "route_overrides" ("managed_route_id","ends_at");
CREATE INDEX "route_overrides_end" ON "route_overrides" ("ends_at");
CREATE TABLE "route_schedules" (
	"managed_route_id" text PRIMARY KEY NOT NULL,
	"timezone" text NOT NULL,
	"grid" text NOT NULL,
	"generator" text,
	FOREIGN KEY ("managed_route_id") REFERENCES "managed_routes"("id") ON UPDATE no action ON DELETE cascade
);

CREATE TABLE "route_switch_log" (
	"id" text PRIMARY KEY NOT NULL,
	"ts" integer NOT NULL,
	"managed_route_id" text NOT NULL,
	"route_name" text NOT NULL,
	"from_egress_id" text,
	"to_egress_id" text NOT NULL,
	"reason" text NOT NULL,
	"verified" integer NOT NULL,
	"dry_run" integer NOT NULL,
	"duration_ms" integer,
	"error" text
);

CREATE INDEX "route_switch_log_route_ts" ON "route_switch_log" ("managed_route_id","ts");
CREATE INDEX "route_switch_log_ts" ON "route_switch_log" ("ts");
CREATE TABLE "rule_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"rule_id" text NOT NULL,
	"rule_name" text NOT NULL,
	"ts" integer NOT NULL,
	"event" text NOT NULL,
	"test" integer NOT NULL,
	"dry_run" integer NOT NULL,
	"ok" integer NOT NULL,
	"skipped" text,
	"results" text NOT NULL
);

CREATE INDEX "rule_runs_rule_ts" ON "rule_runs" ("rule_id","ts");
CREATE INDEX "rule_runs_ts" ON "rule_runs" ("ts");
CREATE TABLE "rules" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enabled" integer DEFAULT true NOT NULL,
	"trigger" text NOT NULL,
	"conditions" text NOT NULL,
	"actions" text NOT NULL,
	"cooldown_seconds" integer NOT NULL,
	"last_run_at" integer,
	"last_run_ok" integer,
	"run_count" integer DEFAULT 0 NOT NULL,
	"created_at" integer NOT NULL
);

CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text
);

CREATE TABLE "snapshot_items" (
	"snapshot_id" text NOT NULL,
	"resource" text NOT NULL,
	"item_id" text NOT NULL,
	"encrypted_doc" text NOT NULL,
	"hash" text NOT NULL,
	"label" text NOT NULL,
	PRIMARY KEY("snapshot_id", "resource", "item_id"),
	FOREIGN KEY ("snapshot_id") REFERENCES "snapshots"("id") ON UPDATE no action ON DELETE cascade
);

CREATE TABLE "snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"ts" integer NOT NULL,
	"trigger" text NOT NULL,
	"note" text,
	"network_version" text,
	"complete" integer NOT NULL,
	"failed" text NOT NULL,
	"counts" text NOT NULL,
	"change_count" integer,
	"size_bytes" integer NOT NULL
);

CREATE INDEX "snapshots_ts_id" ON "snapshots" ("ts","id");
CREATE TABLE "speedtests" (
	"id" text PRIMARY KEY NOT NULL,
	"ts" integer NOT NULL,
	"egress_id" text,
	"down_mbps" real NOT NULL,
	"up_mbps" real NOT NULL,
	"latency_ms" real
);

CREATE INDEX "speedtests_ts" ON "speedtests" ("ts");
CREATE INDEX "speedtests_egress_ts" ON "speedtests" ("egress_id","ts");
CREATE TABLE "usage_daily" (
	"mac" text NOT NULL,
	"ts" integer NOT NULL,
	"rx_bytes" integer NOT NULL,
	"tx_bytes" integer NOT NULL,
	"active_minutes" integer NOT NULL,
	PRIMARY KEY("mac", "ts")
);

CREATE INDEX "usage_daily_ts" ON "usage_daily" ("ts");
CREATE TABLE "usage_hourly" (
	"mac" text NOT NULL,
	"ts" integer NOT NULL,
	"rx_bytes" integer NOT NULL,
	"tx_bytes" integer NOT NULL,
	"active_minutes" integer NOT NULL,
	PRIMARY KEY("mac", "ts")
);

CREATE INDEX "usage_hourly_ts" ON "usage_hourly" ("ts");
CREATE TABLE "usage_minutes" (
	"mac" text NOT NULL,
	"ts" integer NOT NULL,
	"rx_bytes" integer NOT NULL,
	"tx_bytes" integer NOT NULL,
	"active" integer NOT NULL,
	PRIMARY KEY("mac", "ts")
);

CREATE INDEX "usage_minutes_ts" ON "usage_minutes" ("ts");
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text NOT NULL,
	"person_id" text,
	"locale" text DEFAULT 'zh-TW' NOT NULL,
	"created_at" integer NOT NULL,
	"last_login_at" integer,
	"auth_version" integer DEFAULT 0 NOT NULL,
	FOREIGN KEY ("person_id") REFERENCES "people"("id") ON UPDATE no action ON DELETE set null,
	CONSTRAINT "users_valid_role" CHECK("users"."role" in ('admin', 'member'))
);

CREATE UNIQUE INDEX "users_username_unique" ON "users" (lower("username"));
CREATE INDEX "users_person" ON "users" ("person_id");
CREATE INDEX "users_role" ON "users" ("role");
CREATE TABLE "watchdog_events" (
	"id" text PRIMARY KEY NOT NULL,
	"watchdog_id" text NOT NULL,
	"ts" integer NOT NULL,
	"kind" text NOT NULL,
	"message" text NOT NULL
);

CREATE INDEX "watchdog_events_watchdog_ts" ON "watchdog_events" ("watchdog_id","ts");
CREATE INDEX "watchdog_events_ts" ON "watchdog_events" ("ts");
CREATE TABLE "wol_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"mac" text NOT NULL,
	"broadcast" text,
	"port" integer DEFAULT 9 NOT NULL,
	"schedule" text,
	"last_woke_at" integer
);

CREATE INDEX "wol_targets_mac" ON "wol_targets" ("mac");
`

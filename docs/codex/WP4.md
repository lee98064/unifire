# WP4 — Snapshots, semantic diff, restore, change audit

Read `docs/codex/BRIEF.md` first. WP1–WP3 are in the repo.

## 1. Snapshot service (`server/engine/snapshots/`)
- Capture every `SnapshotResource` (shared/schemas/insight.ts) via the UniFi client. Store one
  `snapshots` row + `snapshot_items` (resource, item id, label, sha256 of normalized doc, **encrypted full
  doc**). `complete=false` + `failed[]` when a resource read fails. `counts`, `sizeBytes`, `changeCount`
  (items added/removed/modified vs previous snapshot), `networkVersion`.
- Triggers: cron `settings.snapshots.cron` (settings tz), manual `POST /api/snapshots`, **pre-write**
  hook registered in the WP2 write gate (`settings.snapshots.preWrite`; debounce: reuse a snapshot younger
  than 2 min), `pre-restore`. Retention: delete older than `retainDays` (never delete the newest 3).
- Endpoints: `GET /api/snapshots` (cursor), `POST`, `DELETE /api/snapshots/:id`,
  `GET /api/snapshots/:id/items/:resource/:itemId` (redacted doc).

## 2. Diff engine (`server/engine/snapshots/diff.ts`)
- Normalize docs (sort object keys; drop volatile fields such as counters/timestamps if any appear; keep
  array order where it matters — firewall `index`, `rule_index`). Compare by item id → added / removed /
  modified with field paths (`target_devices[0].client_mac`).
- Secrets: any key starting with `x_`, or matching /pass|secret|private|psk|token|key$/i → `secret: true`,
  values replaced by `null` in API output.
- Labels: resolve ids to names for `network_id` (egress/network names), `client_mac` (client display
  name), zone ids, wlan ids → `beforeLabel` / `afterLabel`.
- Semantic summaries as i18n keys (add them to `docs/backend/i18n-keys.md`), e.g.
  `snapshots.summary.routeEgress` {route, from, to}, `snapshots.summary.routeToggled` {route, state},
  `snapshots.summary.added` {resource, label}, `snapshots.summary.removed` {resource, label},
  `snapshots.summary.modified` {resource, label, fields}, `snapshots.summary.wifiPassword` {ssid},
  `snapshots.summary.firewallToggled` {name, state}.
- `GET /api/snapshots/diff?from=&to=` (`to` omitted = live: take an in-memory snapshot, don't persist).
- `restorable` per change (see 3).

## 3. Restore (`POST /api/snapshots/:id/restore`, body `RestoreInput`)
- Restores the selected items to their state **in snapshot `:id`**. Build a `RestorePlan`:
  modified/removed-in-live → PUT (or POST if missing now) the full original doc (decrypted) for:
  trafficroutes, objects (PUT singular path), firewall-policies, portforward, wlanconf, users (`rest/user`
  name/fixed ip fields only), static-dns (DELETE + POST). Items added after the snapshot → DELETE for
  trafficroutes, portforward, static-dns. Everything else (networkconf, zones, routing, qos, portconf) →
  `supported:false` with reason. Routes in `settings.excludedRouteIds` or Unifire probe routes →
  `supported:false` reason `excluded`.
- `dryRun:true` (default) returns the plan with redacted bodies. `dryRun:false`: take a `pre-restore`
  snapshot, apply steps sequentially through the write gate (honour global dry-run mode → steps `skipped`),
  re-read and verify, mark `applied/failed`, audit each step, return the plan with results. Managed routes
  touched by a restore get their baseline refreshed.

## 4. Change audit (`server/engine/audit-watch.ts`)
- Every 5 min (and shortly after relevant WS events) fingerprint key collections (trafficroutes, objects,
  firewall-policies, wlanconf, portforward, networkconf, static-dns). For each changed item not explained by
  the Unifire write ledger (±15 s) → audit `config.changed`, actor `external`, category by resource,
  redacted field diff, messageKey e.g. `audit.config.externalChange` {resource, label}; engine event
  `config.external_change` (WP6 notifies `external_change`).
- Unifire's own writes are already audited by the write gate; make sure messages for route switches,
  blocks, probe provisioning, restores have i18n keys + params (document them).
- If capability `systemlog` is ok: poll `v2/system-log/all` every 2 min, de-dup, store as audit actor
  `unifi-log`, messageKey `audit.unifi.log` {message, key}. Never store secrets.
- `GET /api/audit` already exists — ensure filters work with the new categories/actors and `q` searches
  label/params text.

## 5. Mock
- The fake controller should occasionally (dev only) change a non-managed resource (e.g. toggle a port
  forward) so the audit timeline shows external changes. Seed 3 historical snapshots with a couple of
  differences so the snapshots page has content.

## 6. Tests
- diff paths/labels/secret redaction; restore plan per resource type; excluded routes unsupported;
  dry-run vs apply with verification; pre-write debounce; external change attribution vs write ledger;
  retention keeps newest 3.

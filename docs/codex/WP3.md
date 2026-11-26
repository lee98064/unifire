# WP3 — Routing engine: managed routes, reconciler, schedule/override/failover, probes, IP sweep

Read `docs/codex/BRIEF.md` first. WP1 + WP2 are in the repo (DB, auth, audit, bus, UniFi client, write gate,
fake controller, cache, read APIs). Reuse them. Shared pure helpers already exist in
`shared/utils/schedule.ts` (`cellAt`, `segments`, `nextChange`, `generateGrid`, `wallClock`) and are tested in
`tests/shared/schedule.test.ts` — use them, do not re-implement schedule maths.

## 1. Managed routes (endpoints in `shared/api.ts` → routes section)
- `GET /api/managed-routes`, `GET /api/managed-routes/:id` → `ManagedRoute` (desired/actual/next/activeOverride filled).
- `POST /api/managed-routes`:
  - `adopt`: only `external` routes that are not `suspectedAutomation`; store baseline fingerprint.
  - `create`: POST a new trafficroute through the write gate (description = name, `target_devices` from
    targets, matching target + destinations mapped to `domains` / `ip_addresses` / `regions` in the wire
    shapes of `docs/unifi-wire-shapes.md`, `network_id` = default egress, `next_hop` "", kill switch,
    enabled true). Mark `created_by_unifire`. If the create capability is missing, return
    `409 ROUTE_CREATE_UNSUPPORTED` (UI tells the user to create it in UniFi and adopt).
- `PATCH` (name, enabled, defaultEgressId, killSwitch → kill switch change is written to UniFi and becomes
  the new baseline; failover policy), `DELETE` (release; `deleteFromUnifi` only if created by Unifire).
- `PUT …/schedule` (validate 7×24 egress ids exist, IANA timezone), `POST/DELETE …/override`,
  `POST …/resume` (accept current UniFi doc as baseline, state → active), `GET …/preview?hours=` (segments
  from schedule + default + active override; failover not predicted), `GET /api/switch-log` (cursor).
- `GET /api/routes`: ownership now includes `managed` + `managedRouteId`; implement `suspectedAutomation`:
  keep a ledger of route document changes seen by the cache that were **not** caused by a Unifire write
  (write ledger ±15 s); a route with ≥3 such `network_id` changes in 24 h → `suspectedAutomation: true`,
  `lastExternalChangeAt`. Adopting such a route → `409 ROUTE_EXTERNALLY_AUTOMATED`.

## 2. Reconciler (`server/engine/reconciler.ts`)
- Runs every 30 s, at every wall-clock hour boundary of any managed route's timezone (timer aimed at
  hh:00:00, fire within 1 s), and immediately on: schedule/override/failover/default changes, egress health
  transitions, override expiry, mode change, controller reconnect.
- Desired egress priority: active override > failover (if desired egress unhealthy) > schedule cell >
  default. Track `reason` (`override|failover|recover|schedule|default|initial|rule`).
- Failover state machine per route using egress health (section 4): primary considered failed after
  `failThreshold` consecutive failed rounds or loss ≥ `lossPct`; pick the first healthy egress in `chain`
  (skip unknown/down); return to primary only after it stayed healthy `recoverMinutes` (reason `recover`).
- Drift guard: before each write, fetch fresh doc; if `target_devices`, `matching_target`, destinations,
  `kill_switch_enabled` or `enabled` differ from the baseline (someone edited it in UniFi) → state `drift`,
  `stateDetail`, audit (`route.drift`), live event, notification hook `route_drift`, and **stop writing** that
  route until `resume`. Route deleted in UniFi → state `error`.
- Write via `updateRouteEgress` (WP2) — read-back verification, duration; switch log row (dryRun flag
  honoured: in dry-run record the intended switch with `dryRun: true`, do not mark actual as changed).
- Live events `route.switched` / `route.changed`; audit `route.switched` with from/to labels.
- Concurrency: one reconcile pass at a time; per-site write queue from WP2.

## 3. Dashboard pieces
- Fill `DashboardSummary.routes`, `upcoming` (next 24 h, all managed routes, schedule boundaries +
  override ends, sorted, max 10), `recentSwitches` (last 10).

## 4. Probes & egress health (`server/engine/probes/`)
- Probe route per probe-enabled egress: description `[unifire-probe] <egress name>`, source = self MAC
  (`CLIENT`), `matching_target: IP`, `ip_addresses: [{ ip_or_subnet: <assigned ip>, ip_version: 'v4', ports: [], port_ranges: [] }]`,
  `network_id` = egress, `kill_switch_enabled: true`. Stable 1:1 IP assignment from `settings.probe.ipPool`
  (persist on `egresses.probe_ip`); never assign 1.1.1.1/1.0.0.1 (reserved for the sweep).
- `POST /api/probes/provision` creates/repairs (and fixes drifted probe routes), `DELETE /api/probes`
  removes all `[unifire-probe]` routes, `GET /api/probes` → `ProbeOverview`. Provision automatically when a
  probe-enabled egress lacks a route and mode is live (in dry-run: state `missing`, no writes).
- Probe runner every `settings.probe.intervalSec`: for each egress with an ok probe route, 3 attempts →
  latency (median), jitter, loss. Methods: `tcp` (connect to ip:443, fallback 53), `dns` (UDP query for `.` NS
  to ip:53), `icmp` (`ping -c 1 -W 1` child process; capability-detect binary). Behind a
  `ProbeTransport` interface: real transport vs **mock transport** that asks the fake controller's
  simulation hook (mock mode must look alive with realistic latencies, occasional loss and the scripted VPN
  flap).
- Health: `down` after `failThreshold` consecutive failed rounds, `degraded` if loss > 0 % or latency >
  2.5 × rolling median, else `healthy`; WANs additionally use UniFi WAN status (gateway uplink / stat/health)
  — UniFi says down ⇒ down. `since` = last transition. Store `egress_samples` every round; keep raw 7 days,
  1-min → 10-min rollups beyond (30 d+). Emit engine events `egress.down` / `egress.up` and a throttled
  (≤ every 10 s) live `egress.health` event.
- `GET /api/egresses` now returns real `health`, `probe` state and latest `publicIp`.
- `GET /api/egresses/:id/history?range=1h|24h|7d|30d` → samples (downsampled to ≤ 360 points), ip checks,
  incidents (contiguous down/degraded spans).

## 5. Rotating public-IP sweep (`server/engine/probes/sweep.ts`)
- One route `[unifire-probe] sweep`: source self MAC, IP match `1.1.1.1/32` + `1.0.0.1/32`, kill switch on,
  created disabled when idle. For each egress: PUT `network_id` + enable → poll
  `https://1.1.1.1/cdn-cgi/trace` (and 1.0.0.1) every 1 s up to 20 s until two consecutive reads agree and
  differ from the previous egress's IP (or timeout → error) → parse `ip=`, `loc=`, `colo=` → store
  `egress_ip_checks` (changed flag vs previous) → next. Disable the route at the end. Live `sweep` events.
- `GET/POST /api/egresses/sweep`; scheduled every `settings.probe.sweepIntervalMin` (0 = manual). Mock mode:
  the fake controller answers the trace for the currently selected egress.
- IP change → engine event `egress.ip_changed` + audit.

## 6. Mock demo seed (extend `server/services/seed.ts`, mock mode + empty only)
- 3 managed routes on fake clients: (a) "Proxy host hourly rotation" with a grid built by `generateGrid`
  using `docs/reference-egress-schedule.json`'s pattern (00:00 WAN1 + 7-step VPN cycle), kill switch;
  (b) "Kids tablets" daytime WAN2 / evening VPN with failover chain; (c) "Lab NAS" with an active 2 h
  override. Plus one plain fake route "proxy hourly egress (external script)" that the fake controller
  rewrites every ~5 min to simulate another automation, and put its id in `settings.excludedRouteIds`.

## 7. Tests (fake controller)
- priority resolution; failover hysteresis (fail → fallback → recover after N minutes); drift detection
  stops writes; schedule boundary fires a switch with read-back; dry-run logs but doesn't write; excluded /
  object / predefined / unadopted routes are never written; probe health classification; sweep flow incl.
  timeout; suspectedAutomation heuristic; preview segments.

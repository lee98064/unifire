# WP9 — Port & cable health guard, PoE schedules (desired-state), energy ledger

Read `docs/codex/BRIEF.md`, `docs/PLAN-infra.md`, `docs/unifi-wire-shapes-infra.md` (authoritative field
shapes, incl. `last_connection`, `link_down_count`, `mac_table_count`, `poe_power` as STRING, `port_overrides`
inside `stat/device`, `rest/device` GET = 404), `shared/schemas/infra.ts`, and the WP8 code you build on
(`server/engine/infra/*`, `device-shape.ts`, `poe-safety.ts`, the mock fleet). Endpoints marked `WP9` in
`shared/api.ts` are in scope.

## 1. Port health (`server/engine/infra/port-health.ts`, pure detectors + thin wiring)
State per port (`port_state`, PK switchMac+idx): up, speed, duplex, current peer MAC + kind, `baselineSpeed`
(highest speed negotiated **with the current peer** in the last 30 days; reset when the peer changes),
consecutive-below counter, previous counters (rx/tx errors, drops, packets, `link_down_count`), first-seen.
`port_peers` (switchMac, idx, mac, firstSeen, lastSeen, maxSpeed) = every MAC seen on the port.
Peer resolution order: adopted device whose `uplink` points at the port / `downlink_table` → wired client with
`sw_mac/sw_port` (or `last_uplink_mac/last_uplink_remote_port`) → `last_connection.mac`. Count = max(
`mac_table_count`, clients on the port).

Detectors (run on every successful devices poll; `settings.infra.*` thresholds; ignore ports in
`settings.infra.ignoredPorts`):
- **downgrade** (warning): same peer, link up, speed < baseline for ≥ `downgradeMinPolls` consecutive polls.
  Emit once; emit **recovered** (info) when speed ≥ baseline again. A peer that only ever did 100M has a 100M
  baseline → never fires.
- **errors** (warning): over the last hour, (Δrx_errors+Δtx_errors) / (Δrx_packets+Δtx_packets) × 100 ≥
  `errorRatePct` **and** Δerrors ≥ 50. Counter decrease = device reboot/reset → that interval contributes 0.
  At most once per port per 6 h.
- **flapping** (error): link-down count within the last hour ≥ `flapsPerHour`. Use Δ`link_down_count` where
  the field exists, else observed up→down transitions between polls. Re-arm after 1 h without drops.
- **new_device** (warning) / **peer_changed** (info): a MAC appears on a port that has never seen it. Unknown
  MAC (not an approved client/adopted device) → `new_device`; known → `peer_changed`. Skip uplink ports,
  ports with an adopted device downstream, and ports whose count > 1 (unmanaged switch). **Learning period:**
  no new_device/peer_changed for a port during its first 24 h in Unifire (bootstrap silently).
Each event → `port_events` row (i18n `port.event.<kind>` + params `{switch, port, from, to, peer, rate,
flaps}`), engine event `port.issue {switchMac, portIdx, kind, eventId}`, live `port.event`, notification
`port_issue` (dedupe per port+kind 6 h), audit (category `device`, actor system).

`port_samples` 5-min buckets (up fraction, last speed, avg rx/tx bps, Δerrors, Δdrops, avg poeW) → hourly
rollups; retention from settings. Fill `PortView.baselineSpeedMbps / errorRatePct / flaps1h / issues` (open =
active downgrade, errors < 6 h unacked, flapping < 1 h, new_device/peer_changed < 24 h unacked) and the device
issue `port_issue`. `DashboardSummary.infra.portEvents` = unacknowledged events.

## 2. PoE schedules — desired-state reconciler (`server/engine/infra/poe.ts`)
Tables: `poe_schedules` (fields of `PoeScheduleInput` + status/paused reason/lastAppliedAt), `poe_overrides`
(PK switchMac+idx: on, endsAt, source manual|rule, ruleId), `poe_applied` (PK switchMac+idx: what Unifire
changed — `previousMode`, `createdEntry` (true when no `port_overrides` entry existed before), at,
scheduleId|null, source) = **ownership**, `poe_off_log` (switchMac, idx, start, end, scheduleId) for savings.

Desired per port: active override → else enabled **active** schedule (off inside an off window, on outside)
→ else "leave alone". Rules:
- **Ownership**: Unifire only powers **on** ports in `poe_applied`. A port that is already `off` without a
  Unifire hold is never claimed and never turned on (the user's PoE-off ports 9/10/12/14 in the capture).
  Manual/rule override `on` for a port Unifire doesn't hold → 409 `POE_NOT_OWNED` (message `errors.poeNotOwned`). Other refusals: `errors.poeUnsafe` (safety), `errors.poeAckRequired`, `errors.poeNotQualified` — error `message` values are i18n keys (Claude translates).
- **Drift**: Unifire holds a port off but observes `poe_mode !== 'off'` (someone re-enabled it in UniFi) →
  drop the hold, set schedule status `drift`, pause it, notify `poe_schedule`, audit. Resume only via
  `POST /api/poe/schedules/:id/resume`.
- **Safety** every reconcile via `poe-safety.ts`: not allowed → status `blocked` (never write *off*; restoring
  *on* is always allowed). `requiresAck` without `acknowledgedAp` → `blocked` with reason key
  `poe.reason.ack_required`.
- **Modes**: `preview` → compute state only (status `preview`). Global dry-run → status `dry_run`, audited
  writes with dryRun=true. Not qualified → status `unqualified`, no writes.
- Wake-ups: next window boundary of any schedule (reuse `bedtimeWindows` from
  `server/engine/access-time.ts`), override expiry, `cache.changed devices`, CRUD, controller mode change,
  60 s fallback. Same single-flight pattern as `server/engine/reconciler.ts`.
- State for the API: desired/actual (`port_table.poe_mode` off → off, other → on; port missing → unknown),
  status + reasonKey/params, nextChangeAt/nextDesired, `upcoming` windows (48 h), lastAppliedAt; savings:
  offHoursPerWeek from windows, avgW = mean poeW while on (port_samples, last 7 d), monthKwh =
  avgW·offHoursPerWeek·30/7/1000, monthCost via `settings.energy.ratePerKwh`.
- DELETE schedule: if this schedule holds the port off → power it back on first (honour dry-run), then delete.
- **Watchdog coordination** (`server/engine/watchdogs.ts`): export `poeHold(switchMac, idx)` → watchdogs skip
  checks/cycles while the port is held off and for a 10-min boot grace after Unifire powers it on.
- Rule action `poe.set` → override (source rule, minutes; `acknowledgedAp` from the action). Implement it.
- Rule trigger `poe.budget` (total_used_power / total_max_power ≥ percent; edge-triggered, re-arms 5 % below).

## 3. Write gate (`server/unifi/writes.ts`)
`updatePortOverride(deviceMac, portIdx, change: { poe_mode: 'off' | 'auto' | string } | { remove: true }, ctx)`:
read the freshest `stat/device/<mac>` (not the cache), take `_id` + `port_overrides` (missing = []), modify
only the entry for `portIdx` (set `poe_mode`; or append `{ port_idx, poe_mode }`; `remove` deletes the
entry Unifire created), keep every other entry and field byte-for-byte, `PUT rest/device/{_id}` with
`{ port_overrides: merged }`. Per-site mutex, pre-write snapshot hook, audit category `poe` with field diff,
dry-run honoured, ledger entry (so the AP's reboot is classified `unifire_restart`). Read-back: poll
`stat/device/<mac>` every 2 s up to 20 s until `port_table[idx].poe_mode` matches; return `verified`.
Restoring "on": `createdEntry` → `remove`, else set `previousMode`.

**Qualification** `POST /api/poe/qualify` (body `PoeQualifyInput`): refuse in dry-run (`DRY_RUN`), refuse
unsafe ports / missing ack; snapshot → off → read-back → restore → read-back → store qualification
(`PoeQualification`, reset when the Network version changes, like route qualification). On failure always
try to restore, return the error, audit everything. `GET /api/poe` returns it.

Snapshots: enable restore for the `devices` resource **only for `port_overrides`** (whole saved array via the
same PUT), `restorable: true` only when port_overrides differ.

## 4. Energy ledger (`server/engine/infra/energy.ts`)
Each devices poll: for every PoE port parse `poe_power` (string) → W; Wh += W·Δt/3600 with Δt since the
previous sample of that port; Δt > 180 s → skip the gap (no interpolation). Accumulate in `energy_hourly`
(switchMac, idx, hourTs UTC, wh, peerName snapshot). `GET /api/energy?period&at` → `EnergyReport` in the
settings timezone (day = hourly buckets, week/month = daily, year = monthly), `byDevice` with ports sorted
desc, `savings` from `poe_off_log` × that port's avgW before going off, `coverage` = sampled time / elapsed
period time, `liveW`, cost via settings. Fill `InfraDeviceDetail.energy` and `DashboardSummary.infra.poeWatts`.

## 5. API (WP9 rows in `shared/api.ts`)
`GET /api/devices/:mac/ports/:idx?range=` (PortDetail: series from port_samples/rollups, peers history,
events), `GET /api/ports/events` (cursor paging, filters), `PATCH /api/ports/events/:id`,
`POST /api/ports/events/ack`, `GET /api/poe`, schedules CRUD + resume, `POST /api/poe/override`,
`POST /api/poe/qualify`, `GET /api/energy`. Rule trigger `port.issue` (switchMac/kinds filters).

## 6. Mock
Implement `PUT rest/device/{_id}` `port_overrides` in the mock (mutates state: `poe_mode`, `poe_power` → 0,
an AP behind the port goes `state:0` until ~60 s after power returns, then reboots with low uptime). The WP8
scenario hooks must now produce real port events (downgrade/recovered, errors, flapping, new_device).

## 7. Notifications & i18n
`port_issue`, `poe_schedule` (drift / error / blocked) texts; register all keys (`port.event.*`,
`poe.reason.*`, `notification.port_issue.*`, `notification.poe_schedule.*`, `diff.device.*` additions) in
`docs/backend/i18n-keys.md`.

## Tests
Detectors: downgrade with persistence + recovered, 100M-only peer never fires, counter reset, error floor,
flapping via link_down_count and via transitions, learning period, new_device vs peer_changed, ignoredPorts.
PoE: priority (override > schedule > leave alone), ownership (never powers on an externally-off port,
`POE_NOT_OWNED`), drift pauses, safety blocked/ack, preview/dry-run/unqualified, window crossing midnight +
DST-safe boundary, delete restores, createdEntry removal vs previousMode restore. Write gate: merge keeps
other entries/fields exactly (fixture from the capture), read-back retry, qualification restore on failure.
Energy: integration with gaps, period bucketing in Asia/Taipei, savings. Watchdog skip while held + grace.

## Done
`pnpm typecheck`, `pnpm test`, `pnpm test:contract` (WP9 endpoints added) green; in mock mode a schedule in
`active` mode actually powers a mock port off/on at the boundary and the AP behind it disappears/returns.

## 8. Follow-ups from the WP8 review (do these too)
- **Mock port names**: the mock copied de-identified names (`name-4`, `name-17` …) into `port_table[].name`
  and `port_overrides[].name`. Use UniFi defaults (`Port 1` … `Port 18`, SFP ports `SFP+ 1/2`) plus a few
  friendly custom names (e.g. "Desk", "Garage camera") so the UI shows realistic names.
- **Uplink port peer**: a device's own uplink port currently resolves to `peer.kind:'unknown'`
  ("unknown device +7" on Core Switch port 18). The peer of an uplink port is the upstream device
  (`uplink.uplink_mac`) with `kind:'device'`.
- **First observation of a device** must not create noise: do not insert a `firmware_history` row
  (no "from null → x" change) and do not emit `infra.firmware` for an `upgradeTo` that was already present when
  Unifire first saw the device (record it silently; only later changes notify).

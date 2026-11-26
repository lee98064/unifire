# WP8 — Infra foundation: device fleet, long-term health, locate, device snapshots, infra rule triggers, multi-device mock

Read `docs/codex/BRIEF.md` first, then `docs/PLAN-infra.md` (phase 2 plan, binding), then:
- `shared/schemas/infra.ts` — **new domain contract** (devices, ports, PoE, topology, rooms, incidents).
- `shared/api.ts` — section `// ── infra` lists every new endpoint; each line says which WP implements it.
- `shared/schemas/automation.ts` (new rule triggers/conditions/actions), `shared/schemas/system.ts`
  (new Settings blocks, NotificationEvent values, DashboardSummary.infra, LiveEvent types),
  `shared/schemas/insight.ts` (`SnapshotResource` += `devices`, `AuditCategory` += `device`).
- `docs/unifi-wire-shapes-infra.md` — real, de-identified Network 11.0.104 shapes captured from the user's
  controller, with the raw fixture `tests/fixtures/wire/infra-capture-11.0.104.json`. **Authoritative**
  where it disagrees with `docs/unifi-api-research.md`. Read it fully. Key findings: the UniFi Express 7
  reports `type:"udm"` but is an AP (gateway detection fix), `rest/device` GET is 404 while `stat/device`
  carries `port_overrides`, `last_connection.mac` / `downlink_table` give port peers, `link_down_count`
  exists, there are no WS `events` frames, and `device:sync` arrives about 1/s.

WP8 covers sections 1–9 below. Later WPs: WP9 ports/PoE/energy, WP10 topology/rooms/roaming, WP11 incidents.
Design every module so those WPs can plug in (export small pure functions, keep engine wiring in one place).

## 0. Gateway detection fix
Replace `isGateway()` in `server/services/cache.ts` with the rule from `docs/unifi-wire-shapes-infra.md`
(type ∈ udm/ugw/uxg, not `is_access_point`, no `gateway_mac`, has `wan1` or no `uplink.uplink_mac`). Add a
test using the fixture, where the UX7 must not become the gateway even if it is listed first. Throttle cache
refreshes from WS `device:sync` (≥ 10 s between refreshes) if they are not already throttled.

## 1. Wire layer
- Extend `Device` in `server/unifi/endpoints/schemas.ts` (loose, everything `nullish`): `_id, state, adopted,
  ip, version, upgradable, upgrade_to_firmware, uptime, last_seen, model, model_name/shortname, type,
  system-stats{cpu,mem}, general_temperature, temperatures[], num_sta, user-num_sta, guest-num_sta,
  uplink{…}, last_uplink{…}, port_table[], radio_table[], radio_table_stats[], vap_table[] (essid, ap_mac,
  radio, num_sta), total_max_power, ethernet_table, led_override, locating`. Names follow the capture file.
- New `server/unifi/device-shape.ts` (pure, unit-tested) that normalises one wire device into the pieces the
  contract needs: `type` (udm/ugw/uxg/udm-like → gateway; usw → switch; uap → ap; else other — a UDM
  still exposes its built-in switch ports), `state` mapping (document the numeric map you used), cpu/mem as
  numbers (system-stats values are strings on some builds), temperature (general_temperature, else max of
  `temperatures[].value`), uplink (`DeviceUplink`; wired vs wireless/mesh, speed, duplex, signal, rates;
  fall back to `last_uplink` when `uplink` is absent), radios (`Radio[]`: merge `radio_table` +
  `radio_table_stats` by radio name; ng→2.4, na→5, 6e→6, ad→60), port normalisation (`media` from
  `media`/`sfp_found`/`port_poe` hints; `maxSpeedMbps` from `speed_caps` bitmask or the max of
  `speeds`; PoE fields; `isUplink` via existing `isUplink()` in `server/unifi/poe-ports.ts`).
- Reuse `poeCapable/isUplink/portIndex` from `poe-ports.ts`; do not duplicate.
- New endpoint helper `deviceCommand` in the write gate (see §5) — `cmd/devmgr` `set-locate` / `unset-locate`
  with `{ mac }`.

## 2. Persistence (drizzle, inline migration, `server/db/schema.ts`)
Tables (names indicative — pick sane columns/indexes):
- `infra_devices` (mac PK, site, unifiId, name, model, modelName, type, firstSeen, lastSeen, lastState,
  firmware, upgradeTo, lastUptime, roomId nullable (FK comes in WP10, keep a plain column now), locateUntil).
- `device_samples` (mac, ts minute-aligned, state, uptime, cpu, mem, temp, clients, rxBps, txBps, poeW) —
  PK (mac, ts). Raw retention `settings.infra.retainRawDays` (default 7).
- `device_rollups_hourly` (mac, hourTs, onlineFraction, cpuAvg/Max, memAvg/Max, tempAvg/Max, clientsAvg/Max,
  rxAvg/Max, txAvg/Max, poeWAvg) — retention `settings.infra.retainRollupDays` (default 400). Same rollup
  style as `egress_sample_rollups`.
- `device_transitions` (id, mac, ts, from, to, reason, downSec) — kept forever (small).
- `firmware_history` (id, mac, ts, from, to).

## 3. Device sampler (`server/engine/infra/device-sampler.ts`)
- Driven by the cache: on `cache.changed` for `devices` (60 s poll + WS `device:sync` refresh) and once at
  engine start. Never issue extra controller reads for sampling.
- Per device: upsert `infra_devices`; one sample per minute (dedupe within the minute, keep the latest);
  rollup completed hours; prune by retention.
- **State transitions** recorded when the normalised state changes. A device missing from `stat/device` for
  2 consecutive successful polls counts as `offline` (a failed poll changes nothing).
- **Reboot detection**: uptime decreased versus the previous sample by more than the elapsed time tolerance
  (or device returned from offline with uptime < downtime). Reason:
  `unifire_restart` if the write ledger (`server/unifi/write-ledger.ts` — extend it if needed) shows a
  Unifire `restart` command or PoE power-cycle/PoE-off of the port powering this device within the last
  15 min; `upgrade` if firmware changed or the device passed through `upgrading`; otherwise
  `unexpected_reboot`.
- **Firmware**: record `firmware_history` on version change; emit when `upgradeTo` first appears or changes.
- Engine events (add to `ControllerEvent` in `server/unifi/ws.ts`):
  `infra.offline {mac}` (at the transition), `infra.online {mac, downSec}`, `infra.rebooted {mac, unexpected}`,
  `infra.overheat {mac, tempC}` (edge-triggered at ≥ `settings.infra.tempWarnC`, re-arms after dropping
  3 °C below), `infra.firmware {mac, version}`.
- Live bus: `{ type: 'device', data: { macs } }` whenever a device's list-visible fields change (throttle to
  ≤ 1 per 5 s).
- `availability24h`: online fraction over the last 24 h from samples; minutes without any sample (Unifire
  down) are excluded from both numerator and denominator; null when < 60 sampled minutes.

## 4. PortView from live data + PoE safety (`server/engine/infra/ports.ts`, `poe-safety.ts`)
`InfraDeviceDetail.ports` and `PoeOverview` need `PortView` already. WP8 fills what live data allows:
`peer` (adopted device whose uplink points at this port → `device`; otherwise wired clients with
`sw_mac/sw_port` → `client` with person; count of MACs), `issues: []`, `baselineSpeedMbps: null`,
`errorRatePct: null`, `flaps1h: 0` (WP9 replaces these with real values — keep a single builder function
WP9 can extend).
**PoE safety** (pure function over the device graph + clients + controller self MAC/IP):
`not_poe` (not PoE capable), `uplink` (port is this device's uplink), `downstream_devices` (any adopted
switch/AP-with-children behind the port — follow uplink graph recursively; a single AP with no children is
not this reason), `unifire_host` (Unifire's own MAC — `service` self MAC — is behind the port, directly or via
downstream devices/unmanaged switch), `gateway_path` (port lies on the path between the Unifire host and the
gateway), `powers_ap` (an AP is directly behind the port → `requiresAck=true`, still allowed). `allowed =
capable && no blocking reason` (`powers_ap` alone is not blocking). Unit-test every reason.

## 5. Write gate additions (`server/unifi/writes.ts`)
- `deviceCommand('set-locate' | 'unset-locate', mac)` — category `device`, audited, dry-run honoured, no
  read-back. Locate API: `POST /api/devices/:mac/locate {on, minutes}`; persist `locateUntil`; a timer (and a
  check at boot) sends `unset-locate` when it expires. `locating` in the API = `locateUntil > now`.
- `POST /api/devices/:mac/restart` reuses the existing `deviceAction({cmd:'restart'})` path (audit category
  becomes `device`), records the ledger entry used by reboot detection. Refuse restarting the gateway unless
  body `{ confirmGateway: true }` (see api.ts note).

## 6. Snapshots
Add `devices` to `snapshotResources`, category `device`, **no `write`** in WP8 (WP9 adds a
port_overrides-only restore). `rest/device` GET is 404 on 11.0.104, so read `stat/device` and keep only
config-like keys per device (`_id, mac, name, model, type, port_overrides, radio_table (config fields
only), led_override, config_network, mgmt_network_id, ethernet_overrides, device_mode_override`). The
snapshot must not churn on volatile stats: add a test showing that two polls with different counters
produce no diff. `itemLabel` = name/model/mac. Make sure the existing redaction removes `x_*`
(adoption keys, fingerprints, SSH keys) and add a test with a realistic rest/device doc. Diff summary keys for
the common changes: `diff.device.port_override` {device, port, field, from, to}, `diff.device.name`,
`diff.device.radio` {device, radio, field, from, to}, generic fallback. Register keys in
`docs/backend/i18n-keys.md`.

## 7. API (implement the endpoints marked WP8 in `shared/api.ts`)
`GET /api/devices`, `GET /api/devices/:mac`, `GET /api/devices/:mac/series?range=`,
`GET /api/devices/:mac/events?from=&to=`, `POST /api/devices/:mac/locate`, `POST /api/devices/:mac/restart`.
`issues` per device: offline, overheat (≥ tempWarnC), high_cpu/high_mem (≥ settings), firmware_available,
unexpected_reboot (last 24 h). `port_issue`/`bottleneck` come in WP9/WP10 (leave the hooks).
Series bucket: 24h → raw minutes aggregated to 5 min; 7d → hourly; 30d/90d → hourly averaged to 6 h.
Dashboard: fill `DashboardSummary.infra` (`openIncidents: 0`, `incidents: []` until WP11).

## 8. Rule engine
Implement triggers `infra.offline` (fires once the device has been offline for `minutes`; 0 = immediately;
cancel if it comes back first), `infra.online`, `infra.rebooted` (`unexpectedOnly`), `infra.overheat`
(threshold from the trigger, not settings), `infra.firmware`; `mac: null` = any device. Implement action
`device.locate`. Synthetic test events for `POST /api/rules/:id/test`. Placeholders for notify/webhook
templates: `{{device}}`, `{{mac}}`, `{{model}}`, `{{temp}}`, `{{version}}`, `{{downtime}}`.
Triggers/actions/conditions belonging to WP9–WP11 must validate and save, and simply never fire until then
(their `test` returns a run with a `not_implemented` result message).

## 9. Mock controller (`server/unifi/mock/`) — important for Claude's UI work
Model the fleet **exactly on the capture** (build the mock device docs from the fixture's `stat/device` rows:
same types, models, port tables, PoE/`port_overrides`, `downlink_table`, radios, uplink topology), with
friendly mock names: UDM Pro "Dream Machine Pro", USPM16P "Core Switch", USWED35 "Desk Switch", U7 Pro
"AP Living Room", UX7 "AP Study (Express 7)". Add one **extra** mock-only AP with a wireless mesh uplink
(e.g. U6 Mesh "AP Garden", uplink `type:"wireless"`, signal -68) so mesh paths can be developed.
Keep the user's PoE-off ports as `poe_mode:"off"` (ownership tests rely on externally-off ports). Distribute mock clients
over APs (with `ap_mac`, `signal`, `essid`, radio) and switch ports (`sw_mac`, `sw_port`), incl. one
unmanaged-switch port with 3 MACs and the Unifire self MAC on a non-PoE port.
Evolving values each poll (cpu/mem/temp jitter, rates, PoE watts per port), realistic `uptime`.
**Scenario hooks** for UI development, only when the mock controller is active: Nitro route
`POST /api/dev/mock/:scenario` (admin; return 404 when not mock; not part of the shared contract) with
scenarios `reboot-ap`, `offline-switch` (takes its subtree with it), `recover`, `downgrade-port`
(1G → 100M on a client port), `port-errors`, `flap-port`, `roam` (moves a phone between APs), `overheat`,
`firmware-available`. Implement the data side now even if detectors arrive in WP9–WP11.

## 10. Settings
Defaults for the new Settings blocks (see `shared/schemas/system.ts`). PATCH merges whole blocks as today.

## Tests (vitest)
device-shape normalisation against the captured shapes (fixtures from `docs/unifi-wire-shapes-infra.md`);
state map; reboot classification (unexpected vs unifire_restart via ledger vs upgrade); offline after 2
missing polls but not on a failed poll; availability with sample gaps; rollup + retention; overheat
hysteresis; PoE safety reasons (all six); locate expiry after restart of the engine; snapshot redaction of a
rest/device doc; rule triggers fire/cancel (`infra.offline` with minutes and early recovery).

## Done
`pnpm typecheck`, `pnpm test`, and `pnpm test:contract` (add the WP8 endpoints to the smoke script) green.
In mock mode `GET /api/devices` returns the modelled fleet; each scenario hook visibly changes the API output.

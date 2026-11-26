# WP2 — UniFi client, fake controller (mock mode), capabilities, sync cache, read APIs

Read `docs/codex/BRIEF.md` first. WP1 (DB, auth, settings, audit, bus) is already in the repo — reuse it.

## 1. UniFi HTTP client (`server/unifi/client.ts` + `server/unifi/endpoints/*.ts`)
- UniFi OS paths (`/api/auth/login`, `/proxy/network/api/s/{site}/…`, `/proxy/network/v2/api/site/{site}/…`).
  Keep a small path builder so a standalone controller variant could be added later.
- Session: cookie jar (TOKEN etc.), CSRF from `X-CSRF-Token`, replace with `X-Updated-Csrf-Token` when
  present, send `X-CSRF-Token` on writes. Serialized re-login + single retry on 401 /
  `api.err.LoginRequired`; exponential backoff with jitter after login failures; after 3 consecutive auth
  failures stop retrying until config changes or an admin hits "reconnect" (surface `lastError`).
- Response handling: classic `{meta:{rc,msg},data}` (check `meta.rc === 'ok'`), v2 bare arrays/objects,
  HTML responses = controller starting / wrong route → typed error. Timeouts (connect 5 s, total 15 s).
- TLS (`undici` Agent): `fingerprint` mode = accept self-signed but require SHA-256 cert fingerprint ==
  stored value (constant-time compare) — implement via a custom `connect` with
  `rejectUnauthorized:false` + checking `socket.getPeerCertificate()` before sending; `ca` mode = custom
  CA + hostname verification; `insecure` mode only when explicitly chosen. Same trust for the WebSocket.
- `inspectCertificate(url)` → `CertificateInfo` for TOFU (`POST /api/setup/controller/inspect`).
- Typed endpoint functions (loose zod parsing, unknown fields preserved). At least:
  sysinfo, self/sites, networkconf (list), trafficroutes (list/create/update/delete),
  object-oriented-network-configs (list), clients active (`v2/clients/active?includeTrafficUsage=true&includeUnifiDevices=true`)
  + `stat/sta` fallback, known clients (`rest/user`, `stat/alluser`), devices (`stat/device`),
  `cmd/stamgr` (block-sta/unblock-sta/kick-sta), `cmd/devmgr` (restart, power-cycle, speedtest,
  speedtest-status), `rest/user/{id}` PUT (name/fixed ip — full-doc), wlanconf (list/update),
  `v2/system-log/{class}`, stats series, firewall zones/policies (read), portforward, routing,
  static-dns, qos-rules, portconf (read). Write functions are **only** callable through the write gate.
- Event WebSocket client (`server/unifi/ws.ts`, `ws` lib): connects with session cookie + same TLS trust,
  auto-reconnect with backoff, re-login when needed, parses `events` / `sta:sync` / `device:sync` /
  `user:*` messages into typed internal events (`client.connected`, `client.disconnected`,
  `client.roam`, `device.updated`, …) on an internal engine emitter (separate from the UI bus).

## 2. Write gate (`server/unifi/writes.ts`)
- Implements BRIEF rule 6: dry-run, ownership classification, per-site mutex queue, `beforeWrite` hook
  list (snapshots will register here in WP4), audit record per write (actor, target, diff of changed
  fields), read-back verification helper for trafficroutes (`updateRouteEgress(routeId, egressId, ctx)`
  = fetch list → find by `_id` → validate expected source/matching/kill switch unchanged vs baseline →
  set `network_id` → PUT full doc → re-read → verify → return result incl. duration).
- Ownership classifier (`server/services/ownership.ts`): input = UniFi route + DB managed routes +
  settings.excludedRouteIds + probe route ids → `RouteOwnership`. `origin_type` present → `object`;
  `predefined: true` → `predefined`; description starts with `[unifire-probe]` and id known → `probe`.

## 3. Fake UniFi controller (`server/unifi/mock/**`) — used for mock mode AND tests
- An h3 (or node:http) server on `127.0.0.1:<random port>` implementing **the same HTTP + WebSocket
  surface** the client uses (login w/ CSRF + cookie, 401 after session expiry option, all endpoints
  above). Mock mode (`NUXT_MOCK_CONTROLLER=true`) starts it in-process and points the real client at
  it, so the full code path is exercised. Mock controller defaults to `live` mode (safe — it's fake).
- Synthetic, fictional dataset (no real names/MACs/IPs from the user): UDM Pro "Dream Machine Pro",
  Network 11.0.99, site `default`, timezone Asia/Taipei; 3 WANs ("Fiber Static (WAN1)", "Cable (WAN2)",
  "LTE Backup (WAN3)"); 8 VPN clients (mix wireguard/openvpn: "Tokyo WG", "Osaka WG", "Singapore WG",
  "Frankfurt OVPN", "Los Angeles OVPN", "Seoul WG", "Taichung Home WG", "Office WG");
  LAN networks (Core, IoT, Guest, Kids, Lab) with subnets/VLANs; ~35 clients with realistic hostnames,
  vendors (Apple, Samsung, Google, Sonos, Synology, Raspberry Pi, Espressif, Ubiquiti, Nintendo, Sony,
  LG, Xiaomi, Intel), a few randomized MACs, wired clients on a USW-Pro-24-PoE with port table incl.
  PoE ports/power and uplink port, APs (U7 Pro, U6 Lite); ~20 traffic routes incl. 3 `object_pbr`
  routes and 1 predefined; wlanconf (Home, IoT, Guest SSIDs); networkconf shapes per
  `docs/unifi-wire-shapes.md`.
- Simulation (deterministic seedable PRNG so tests are stable; lively in dev): client traffic counters
  increase, clients connect/disconnect over time (emits WS events), a "new" unknown device appears every
  few minutes in dev mode, routes PUT persist in memory, block-sta flips `blocked`, power-cycle makes
  the port go down/up, speedtest produces results after a delay. For probe simulation expose a hook so
  WP3 can ask "is egress X up / what latency / what public IP" — each egress has a synthetic latency
  profile, public IP + country (JP, JP, SG, DE, US, KR, TW, TW for the VPNs; TW for WANs), and a
  scriptable outage schedule (e.g. one VPN flaps occasionally in dev).
- Test controls: helpers to inject failures (expire session, return HTML, 429 on login, wrong
  fingerprint).

## 4. Controller service + capability matrix (`server/services/controller.ts`, `server/unifi/capabilities.ts`)
- Load config from DB (or mock), build client, connect, detect versions (sysinfo), auto-detect self
  MAC/IP (local socket address used to reach the controller → find in active clients; override from
  settings), keep status for `ControllerStatus`.
- Capability probe (all `CapabilityKey`s): read checks per endpoint; write checks (`routes.create`,
  `routes.update`, `routes.delete`) by creating a **disabled** scratch route
  `[unifire-probe] capability-check` targeting the self MAC with matching IP 192.0.2.1 (TEST-NET),
  updating its description, deleting it — only when mode is live, otherwise `skipped`. `websocket`
  by connecting briefly. Distinguish 404 / empty / 401 / HTML.
- Endpoints: `GET/PUT /api/controller`, `POST /api/controller/probe`, `PUT /api/controller/mode`,
  `POST /api/controller/sync`, `POST /api/setup/controller/inspect`, `POST /api/setup/controller/test`.
  Saving a new real controller sets mode `dry-run`. Audit config changes.

## 5. Sync cache (`server/services/cache.ts`)
- Polls networkconf (5 min), routes (30 s), active clients (15 s), devices (60 s), wlans (5 min);
  WS events trigger targeted refreshes. In-memory snapshot with change detection → emits engine events
  and UI bus events (`client.changed`, `controller`). Exposes getters used by later WPs.
- Upserts `clients` rows (first/last seen, vendor via a bundled compact OUI table for common vendors +
  locally-administered-bit detection for randomized MACs).

## 6. Read APIs
- `GET /api/networks`; `GET /api/egresses` (from networkconf WAN + vpn-client; colors auto-assigned
  from a fixed palette in a stable order, persisted; health `unknown`/source `none` until WP3; routeCount);
  `PATCH /api/egresses/:id`; `GET /api/routes` (UnifiRoute with ownership + destinations summary);
  `GET /api/clients`, `GET /api/clients/:mac`, `PATCH /api/clients/:mac` (alias/person/note in DB),
  `POST /api/clients/:mac/action` (block/unblock/kick via write gate; manual blocks recorded in `blocks`
  with source `manual`); `GET /api/wlans`.
- `GET /api/dashboard` with what exists now (wans, egress counts, clients, routes counts, recentAudit,
  throughput from gateway stats); fill other fields with empty arrays/zeros — later WPs complete it.

## 7. Mock-mode demo seed (`server/services/seed.ts`)
- Only in mock mode and only when the DB has no people/managed routes: seed 4 people (with emoji
  avatars, colors, devices from the fake clients), 1 group "Kids". (Managed routes/rules/quotas are seeded
  by later WPs — leave a hook.)

## 8. Tests (against the fake controller)
- login + CSRF rotation, 401 → single re-login, HTML response, login backoff/lockout guard,
  fingerprint pin accept/reject, route full-doc update preserves unknown fields + read-back, ownership
  classification table, write gate blocks excluded/object/predefined/unadopted routes, dry-run produces
  audit but no controller change, capability matrix in live vs dry-run, WS event parsing.

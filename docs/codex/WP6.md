# WP6 — Notifications, rule engine, PoE watchdog, guest Wi-Fi rotation, Wake-on-LAN

Read `docs/codex/BRIEF.md` first. WP1–WP5 are in the repo; they emit engine events and call notification
hooks — implement the real notifier behind those hooks now.

## 1. Notifier (`server/engine/notifiers/`)
- Channels CRUD per `shared/api.ts`. Secrets encrypted at rest; on read, mask secrets (`••••` + last 4).
  On PATCH, a masked value means "keep existing".
- Routing: an event is sent to every enabled channel whose `events` include it (rule `notify` actions can
  target specific channel ids). Text rendered with `server/utils/i18n.ts` using the locale of the first
  admin user (fallback zh-TW). Add all notification keys to `docs/backend/i18n-keys.md`.
- **Web Push**: VAPID keys generated once and persisted (encrypted settings row); `GET /api/push/vapid`,
  `POST /api/push/subscribe|unsubscribe` (per user). Payload = `PushPayload` (shared/schemas/system.ts).
  Admin-only events go to admin subscriptions; member events (their request decided, their quota warning) go
  to that member. Remove subscriptions on 404/410.
  Actions: `new_device` → approve / block; `extension_request` → approve / deny; `route_drift` → open.
  Each action carries a signed, single-use, 24 h token; the action `endpoint` MUST be `/api/push/action?token=<token>` (the service worker POSTs `{token}` to it); `POST /api/push/action {token}` executes it
  (public endpoint, token is the auth) and audits with actor = the admin the token was minted for.
- **Telegram**: `sendMessage` (HTML parse mode) with inline keyboard when `interactive`; long-polling
  `getUpdates` loop (one per bot token, backoff on errors) handling `callback_query` from the configured
  `chatId` only → execute the same actions as push tokens → `answerCallbackQuery` + edit message to show the
  outcome.
- **Discord** webhook (embed with colour per severity), **generic webhook** (JSON `{event, title, body,
  data, ts}`, header `X-Unifire-Signature: sha256=<hmac>` when secret set), **ntfy** (POST to
  `server/topic`, headers Title, Tags, Priority, optional `Actions` http buttons using push tokens, bearer token).
- `POST /api/notifications/channels/:id/test`; record `lastSentAt` / `lastError`.
- Badge count: include pending approvals + pending requests in push payload `badgeCount`.

## 2. Rule engine (`server/engine/rules/`)
- CRUD + `GET /api/rules/:id`, `POST /api/rules/:id/test` (synthetic event, `dryRun` flag), `GET
  /api/rules/runs` (cursor). Triggers subscribe to engine events: client.connected/disconnected (WP2 cache/WS),
  client.new, person.arrived/left, egress.down/up/ip_changed, quota.warning/exceeded, device.offline (watch
  last_seen ≥ minutes), traffic.threshold (sliding window from usage minutes), schedule (croner per rule
  with timezone). Filters inside triggers (macs, personId, egressId, quotaId) applied before conditions.
- Conditions (all must pass): time window (may cross midnight, settings tz), person.home, anyone.home,
  egress.health, client.online.
- Actions executed in order through existing services (never bypass the write gate): route.override /
  clear_override, block/unblock (client|person|group, optional minutes → source `rule`), pause/resume, notify
  (render `{{placeholders}}` from the event: name, mac, person, egress, quota, ip …), webhook (template body,
  10 s timeout), poe.cycle, wlan.toggle, wol, device.restart, delay. Stop on first failure? No — continue and
  record each result. Cooldown per rule. Persist `rule_runs` (keep 30 days). Audit runs that changed state.
- Global dry-run respected (actions that write to UniFi become "would …").

## 3. PoE watchdog (`server/engine/watchdogs.ts`)
- CRUD, `GET /api/watchdogs/ports` (from `stat/device` port tables: PoE capability, link, power, uplink
  detection, connected client via `sw_mac/sw_port`), `POST …/:id/cycle`, `GET …/:id/events`.
- Per watchdog loop at `intervalSec`: ICMP (`ping -c1 -W2`) or TCP connect; state machine
  ok → failing → cycling → cooldown (→ ok on recovery), `limit` when `maxCyclesPerDay` reached (reset at
  local midnight). Refuse to cycle uplink or non-PoE ports. Power-cycle via write gate (`cmd/devmgr
  power-cycle`). Events + audit + notification `poe_cycle`. Mock transport via fake controller.

## 4. Guest Wi-Fi (`server/engine/guest-wifi.ts`)
- `GET/PUT /api/guest-wifi`, `POST /api/guest-wifi/rotate`, `POST /api/guest-wifi/kiosk-token`,
  `GET /api/wlans`, public `GET /api/kiosk/:token` (rate-limited, constant-time token compare).
- Passphrase generator: `words` (bundled ~600-word list of short, unambiguous English words, joined by `-`,
  plus 2 digits, padded to `length`), `digits`, `random` (no look-alike characters). Apply via write gate:
  fetch full wlanconf doc, change only `x_passphrase`, PUT, verify. Store current passphrase encrypted.
  Cron rotation (croner, tz). `kioskUrl` uses `settings.siteUrl` when set. Notification `guest_wifi_rotated`.

## 5. Wake-on-LAN (`server/engine/wol.ts`)
- CRUD + `POST /api/wol/:id/wake`. Magic packet (6×0xFF + 16×MAC) over UDP with `setBroadcast(true)` to the
  effective broadcast: target override → `settings.broadcastOverrides[networkId]` → derived from the
  client's network subnet (networkconf `ip_subnet`). Optional cron schedule. `online` from cache.
  Audit wakes.

## 6. Mock seed
- Web Push channel (events default set), 3 rules (VPN down → notify; kid arrives home → webhook to a local
  echo URL; 22:00 schedule → pause Kids group 60 min — disabled), 2 watchdogs on fake PoE cameras (one
  flapping in simulation so it cycles occasionally), guest Wi-Fi on the fake Guest SSID with weekly rotation,
  2 WoL targets.

## 7. Tests
- channel masking & keep-on-masked-patch; push action token single use + expiry; telegram callback
  authorization (wrong chat ignored); webhook HMAC; rule trigger filtering, conditions (midnight crossing),
  cooldown, action continuation on failure, dry-run; watchdog state machine incl. daily limit & uplink
  refusal; passphrase generator properties; WoL packet bytes & broadcast derivation.

## WP5 review follow-ups (from Claude — do these too)
- **Human labels in access audit rows.** `audit.block.*` / `audit.approval.*` rows use the MAC as both
  `target.label` and the only param. Use the client's display name (alias → hostname → vendor → MAC) as
  `target.label` and add a `name` param next to `mac`; for `audit.extension.*` add `person` and `minutes`
  params. Update `docs/backend/i18n-keys.md` (Claude will reword the messages to use `{name}`).
- **Quota egress routes vs managed routes.** A `[unifire-quota]` INTERNET route for a person can overlap a
  managed route that targets the same client MAC. Detect the overlap when a quota egress action fires and
  surface it (audit warning `audit.quota.routeOverlap` {person, route}); do not create a second route for a
  MAC that a managed route already targets — instead apply the quota egress as a route override on that
  managed route (reason `rule`, until the quota resets).

## Hard rule for this package: no real outbound notifications
- Never send a real HTTP request to Telegram, Discord, ntfy, any webhook URL or a Web Push endpoint while
  developing or testing. Tests and smoke scripts must use an in-process fake HTTP server (or inject a
  transport) and assert on the captured requests. Do not create bots, tokens or VAPID subscriptions against
  real services; generate VAPID keys locally only.
- Mock mode must never start Telegram long-polling against the real API.

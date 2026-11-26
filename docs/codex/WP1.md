# WP1 — Backend foundation: DB, crypto, settings, auth, audit, live events

Read `docs/codex/BRIEF.md` first. Scope:

## 1. Test & build plumbing
- `vitest.config.ts` (node env, `tests/server/**/*.test.ts`, path aliases `#shared` → `./shared`,
  `~~/server` style imports as you need). Make `pnpm test` work.

## 2. Database (`server/db/`)
- Drizzle schema for **all** tables listed in PLAN.md → 資料模型 so later WPs only add columns:
  users, passkeys (webauthn credentials), controller (single row, encrypted password, verify mode,
  fingerprint, ca pem, site, mode dry-run/live, self mac/ip override, capabilities json, versions),
  egresses (networkconf id, color, probe enabled/ip/route id), egress_samples, egress_ip_checks,
  managed_routes (+ baseline fingerprint of the UniFi doc, default egress, failover json, enabled, state,
  created_by_unifire flag), route_schedules, route_overrides, route_switch_log, people, groups,
  person_groups, person_devices (mac, presence flag), clients (mac, alias, note, approval state,
  first/last seen, detected_at, vendor, randomized), blocks (mac, source, ref id, until, applied flag),
  pause_schedules (or JSON on people), allowances, quotas, usage_minutes (mac, minute bucket, rx, tx,
  active), usage_hourly, usage_daily, extension_requests, rules, rule_runs, poe_watchdogs,
  watchdog_events, guest_wifi, wol_targets, snapshots, snapshot_items (encrypted doc + hash + label),
  audit_events, presence_sessions, notification_channels (encrypted config), push_subscriptions,
  push_action_tokens, settings (kv json), leases, speedtests.
- Sensible indexes (ts columns, mac, managed_route_id). WAL mode, foreign keys on.
- Migration runner that works in dev, tests (`:memory:` or temp file) and the built bundle.
- `useDb()` accessor + a way for tests to create an isolated DB.

## 3. Secrets & keys (`server/utils/crypto.ts`, `server/utils/keys.ts`)
- AES-256-GCM `encrypt(json|string)` / `decrypt` with key from `NUXT_UNIFIRE_SECRET` or
  `<dataDir>/secret.key` (generated 32 random bytes, 0600).
- Session password: if `NUXT_SESSION_PASSWORD` is empty, generate/persist `<dataDir>/session.key` and
  make nuxt-auth-utils use it (set `runtimeConfig.session.password` before the first request). Verify
  it works in a production build (`pnpm build && node .output/server/index.mjs`).

## 4. Settings service (`server/services/settings.ts`)
- Typed get/patch over the `Settings` schema with defaults: timezone `Asia/Taipei`, probe
  `{ intervalSec: 30, ipPool: ['9.9.9.9','149.112.112.112','8.8.8.8','8.8.4.4','208.67.222.222','208.67.220.220','94.140.14.14','94.140.15.15','185.222.222.222','45.11.45.11','76.76.2.0','76.76.10.0','194.242.2.2','193.110.81.0','185.253.5.0','86.54.11.1'], sweepIntervalMin: 60, method: 'tcp', failThreshold: 3 }`,
  approval `{ mode: 'notify', matchRandomizedByHostname: true }`, presence `{ graceMinutes: 10 }`,
  usage `{ activeThresholdBytes: 51200, retainRawDays: 14 }`, snapshots
  `{ cron: '0 3 * * *', retainDays: 90, preWrite: true }`, broadcastOverrides `{}`, selfMacOverride null,
  excludedRouteIds `[]`, siteUrl null.
- Endpoints: `GET/PATCH /api/settings`.

## 5. Auth (`server/api/auth/**`, `server/api/setup/**`, `server/api/users/**`, `server/utils/auth.ts`)
- `GET /api/setup/status`, `POST /api/setup/admin` (only when no admin exists; creates admin, logs in).
- `POST /api/auth/login` (rate limit: per-IP + per-username sliding window, generic error message),
  `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/password`.
- Passkeys via nuxt-auth-utils: `/api/auth/webauthn/register` (logged in) and
  `/api/auth/webauthn/authenticate` (public) using `defineWebAuthnRegisterEventHandler` /
  `defineWebAuthnAuthenticateEventHandler`; store credentials in `passkeys`; `User.hasPasskey`.
- Users CRUD (admin). Prevent deleting/demoting the last admin.
- Session `user` payload = `SessionUser` schema. Declare the `#auth-utils` `User` type augmentation in
  `server/types/auth.d.ts` (or `shared` is off-limits — put it under server/).
- Member scoping helper: `requireMember` returns `{ user, personId }` and throws 403 if a member has no
  bound person.

## 6. Live event bus + SSE (`server/utils/bus.ts`, `server/api/events.get.ts`)
- Typed in-process emitter over `LiveEvent` from `shared/schemas/system.ts`.
- `GET /api/events`: `createEventStream`, send `hello`, heartbeat comment every 20 s, members only get
  events for their own person (filter by personId where present; drop admin-only events).

## 7. Audit service (`server/services/audit.ts`, `GET /api/audit`)
- `audit.record({ actor, category, action, severity, target, messageKey, messageParams, diff, dryRun })`
  → insert + emit `audit` live event. Cursor pagination + filters per `AuditQuery`.
- Record auth events (login ok/failed, user created, password changed, settings changed).

## 8. Tests
- crypto round trip + tamper detection; settings defaults/patch; auth flows (setup → login → me →
  logout, rate limiting, last-admin protection) using an isolated DB (call handlers via a small h3 app
  or test the services directly); audit pagination; SSE member filtering logic (unit level).

Out of scope for WP1: anything talking to UniFi (WP2).

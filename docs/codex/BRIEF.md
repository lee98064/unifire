# Codex brief — Unifire backend (read this first, every work package)

You are implementing the **Nitro backend** of Unifire, a Nuxt 4 app that extends UniFi Network
(UniFi OS gateway, Network 11.x) with features UniFi lacks (scheduled per-device egress routing,
egress health failover, quotas, approvals, rule engine, snapshots/diff/rollback, …).
Claude (the architect) owns the plan, the shared API contract and the entire UI, and reviews your work.

## Read before coding
- `docs/PLAN.md` — the approved plan (Traditional Chinese). Architecture section is binding.
- `docs/PLAN-infra.md` — phase 2 plan (switches/APs: fleet, ports, PoE, topology, rooms/roaming, incidents). Binding for WP8+.
- `shared/api.ts` — **the HTTP API contract** (every endpoint: method, path, auth, input/output zod schema).
- `shared/schemas/*.ts` — domain schemas. Responses MUST validate against the output schema.
- `docs/unifi-api-research.md` — UniFi API research (endpoints, payloads, pitfalls).
- `docs/unifi-wire-shapes.md` — real field names captured from the user's controller (Network 11.0.99).
- `docs/reference-gost-egress.py` + `docs/reference-egress-schedule.json` — the user's working hourly
  egress script. Its login/CSRF flow and "full-document PUT of trafficroute, change only network_id,
  then read back" logic is proven on the real controller — port it faithfully.

## Hard rules
1. **Do not edit** `app/`, `i18n/`, `public/`, `service-worker/`, `shared/`. If the contract must change,
   do NOT change it — write a "Contract change requests" section in your final report instead and
   implement the closest compliant behaviour. You may edit `nuxt.config.ts` only inside the `nitro` and
   `runtimeConfig` blocks (say so in the report).
1b. Keep `server/api/[...slug].ts` (JSON 404 for unknown /api paths — added by Claude). Keep
   `service-worker/sw.ts` untouched (Claude's). Push action endpoints must be `/api/push/action?token=…`.
2. Your files: `server/**`, `tests/**`, `vitest.config.ts`, `docs/backend/**`, deployment files
   (`Dockerfile`, `docker-compose.yml`, `ecosystem.config.cjs`, `deploy/**`) when a WP asks.
3. TypeScript strict. No `any` unless unavoidable at the UniFi wire boundary (prefer `unknown` + zod
   parsing with `.passthrough()`/loose objects so unknown UniFi fields survive round-trips).
4. Validate every request with the zod schema from `shared/` (`readValidatedBody(event, S.parse)`,
   `getValidatedQuery`, `getValidatedRouterParams`). Return objects that satisfy the output schema.
   Errors: `throw createError({ statusCode, message, data: { code: 'SOME_CODE' } })`.
5. Auth helpers in `server/utils/auth.ts`: `requireAdmin(event)`, `requireMember(event)` (member or
   admin; returns session user + bound personId), `requireAny(event)`. Use them in every handler per the
   `auth` field of `shared/api.ts`.
6. **Production-network safety (non-negotiable):**
   - All UniFi writes go through ONE gate (`server/unifi/writes.ts` or equivalent) that enforces:
     global dry-run mode (default ON for a newly configured real controller; mock controller defaults to
     live), ownership checks (never write a route whose ownership is `excluded`, `object`, `predefined`,
     or an `external` route that is not adopted), a per-site serialized mutex queue, pre-write hooks
     (snapshots, added in a later WP), audit logging, and read-back verification where applicable.
   - Read-modify-write: always fetch the freshest document right before a PUT, change only the intended
     fields, keep unknown fields.
   - Login: serialize re-login, retry once on 401/`api.err.LoginRequired`, exponential backoff with
     jitter after failures, stop and surface an error after repeated 401/403/429 (UDM locks accounts
     after ~5 bad logins).
7. Secrets: controller password, channel tokens and full snapshot documents are encrypted at rest
   (AES-256-GCM) with the app secret. Never log secrets. Redact `x_*` fields and known secret keys in
   anything returned to the UI.
8. i18n: user-facing strings produced by the server (audit messages, notification texts, diff summaries,
   toasts) are **i18n keys + params**, never hard-coded Chinese/English. Append every key you introduce,
   with a short English description and the param names, to `docs/backend/i18n-keys.md` (Claude writes
   the translations). Notification channels (Telegram/Discord/…) need final text server-side: use
   `server/utils/i18n.ts` (a tiny lookup that reads `i18n/locales/<locale>.json` at runtime — Claude
   maintains those files; fall back to the key if missing).
9. Time: store epoch ms (UTC). Schedules evaluate in an IANA timezone (default from settings,
   `Asia/Taipei`). Weekday index everywhere: 0 = Monday … 6 = Sunday.
10. Single process, single writer: a SQLite lease row prevents two instances from running the engine.

## Stack / conventions
- Nuxt 4.7 / Nitro (node-server preset), `nuxt-auth-utils` (sessions, `hashPassword`/`verifyPassword`,
  WebAuthn), `drizzle-orm` + `better-sqlite3` (WAL mode), `undici` for HTTP(S) to UniFi, `ws` for the
  UniFi event WebSocket, `croner` for cron, `web-push`, `zod` v4.
- Data dir from `useRuntimeConfig().dataDir` (default `./.data`): `unifire.db`, `secret.key`,
  `session.key` (auto-generated 0600 when env vars are absent).
- Migrations must work from the built `.output` bundle (inline SQL migrations in TS, or Nitro server
  assets) and run automatically at boot.
- Engine/background work starts from a Nitro plugin (`server/plugins/`), never during `nuxt prepare`/build.
  Guard so tests can construct services without booting the plugin.
- Tests: `vitest` (node environment) under `tests/server/**`. The fake UniFi controller is the test double
  for all UniFi interactions.

## Definition of done (every WP)
- `pnpm typecheck` and `pnpm test` pass (paste the summary lines in the report).
- New endpoints from `shared/api.ts` that the WP covers are implemented and return schema-valid data in
  mock mode (`NUXT_MOCK_CONTROLLER=true pnpm dev`) — verify with a quick request script or test.
- Final message (your `-o` report) in English, containing: summary, files added/changed, endpoints done,
  deviations, contract change requests, i18n keys added, known gaps/TODOs, and exact commands you ran.

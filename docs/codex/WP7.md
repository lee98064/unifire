# WP7 — Reports, dashboard completion, contract smoke test, deployment

Read `docs/codex/BRIEF.md` first. WP1–WP6 are in the repo.

## 1. Reports
- `GET /api/reports/isp?month=YYYY-MM` → `IspReport`: per WAN from `egress_samples` (+ UniFi WAN status):
  uptime % (down samples / known samples; gaps excluded), latency p50/p95, avg loss, outages (contiguous
  down spans with duration), daily series, public IPs seen (from ip checks); `vpns` summary; `speedtests` of
  the month.
- Speed tests: `POST /api/reports/speedtest` triggers `cmd/devmgr speedtest` (capability `speedtest`,
  else 409 `SPEEDTEST_UNSUPPORTED`), poll status / read results (speedtest-status or the v2 aggregated
  dashboard widget), store in `speedtests`; `GET` returns `SpeedtestStatus`. Optional daily auto-test is
  out of scope.
- `GET /api/reports/usage?range=7d|30d|month` → `UsageReport` from rollups (totals, daily, top clients with
  person, per person (union minutes), hour-of-week heatmap in settings tz).

## 2. Dashboard completion
- Every field of `DashboardSummary` real: WAN rx/tx rate + throughput ring buffer (60 × 1-min points from
  the gateway uplink stats), egress counts, recent audit (10), etc. Response < 150 ms (cache what's needed).

## 3. Ops endpoint
- `GET /api/health` (public): `{ ok: true, version, uptimeSec, db: 'ok', controller: 'connected'|'disconnected'|'unconfigured' }`
  (no secrets). Used by Docker healthcheck. (Claude will add it to the contract.)

## 4. Contract smoke test (`tests/server/contract-smoke.ts` + `pnpm test:contract` script)
- Against a running server in mock mode: complete setup (admin), log in, then call **every GET endpoint in
  `shared/api.ts`** (fill path params from list responses; sensible query params) and validate each
  response with its `output` schema; then exercise key mutations (create managed route, schedule, override,
  pause person, approve device, create rule + test, snapshot + diff + dry-run restore, rotate guest Wi-Fi,
  wake WoL, channel test) and validate outputs. Print a pass/fail table. It must pass.

## 5. Deployment files
- `Dockerfile`: multi-stage `node:22-bookworm-slim`; pnpm via corepack; build; runtime stage with only
  `.output`, `iputils-ping`, `tini`, non-root user, `NUXT_DATA_DIR=/data`, `VOLUME /data`, `EXPOSE 3000`,
  `HEALTHCHECK` on `/api/health`. `.dockerignore`.
- `docker-compose.yml`: `network_mode: host` (needed for probe source MAC + WoL broadcast), env
  (`NUXT_UNIFIRE_SECRET`, `NUXT_SESSION_PASSWORD` optional — auto-generated into /data otherwise, `PORT`,
  `TZ`), volume `./data:/data`, restart unless-stopped.
- `ecosystem.config.cjs` (pm2) and `deploy/unifire.service` (systemd, `EnvironmentFile`, hardening flags
  that still allow raw ping via `AmbientCapabilities=CAP_NET_RAW`).
- `deploy/nginx.conf.example`: HTTPS reverse proxy incl. SSE (`/api/events`: `proxy_buffering off`,
  `proxy_read_timeout 1h`), `X-Forwarded-*` headers. Make sure the app trusts `X-Forwarded-Proto/Host`
  when building absolute URLs (push links, kiosk URL).
- `docs/DEPLOY.md` in Traditional Chinese: requirements, env vars, Docker & bare Node steps, HTTPS
  requirement for PWA/push (use the existing Nginx), creating a dedicated local UniFi account, first-run
  wizard, dry-run → live checklist, putting externally-automated routes (e.g. the go-gost hourly route) in
  the never-touch list, backup/restore of the data dir, upgrading.

## 6. Final hardening
- Graceful shutdown (stop engine loops, close WS, flush DB). Startup must not crash if the controller is
  unreachable. Log level via env. Ensure no secrets in logs (grep test).
- `pnpm typecheck`, `pnpm test`, `pnpm build`, run the production build in mock mode and pass the contract
  smoke test. Report everything.

## WP6 review follow-ups (from Claude — do these too)
- `group.pause` / `group.resume` rule actions were added by Claude (contract + engine branch + test).
  Add them to any rule validation/reference checks (e.g. reject a rule whose `groupId` no longer exists,
  and clean up rule actions when a group is deleted, mirroring what you do for persons).
- The `extension_decided` notification-event contract request is declined for now; keep the variant.
- `docs/backend/i18n-keys.md` never listed the server-rendered `notification.<event>.title/body` keys and
  their params. Claude added them; from now on list every server-rendered key there.

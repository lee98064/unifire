# WP5 — Access control: usage sampling, approvals, blocks, people, quotas, extensions, presence, member portal

Read `docs/codex/BRIEF.md` first. WP1–WP4 are in the repo.

## 1. Usage sampler (`server/engine/samplers/usage.ts`)
- Every 60 s read active clients (traffic counters). Per MAC compute deltas of rx/tx since last sample;
  if a counter decreased (reconnect/reset) treat the current value as the delta; ignore absurd spikes
  (> 10 Gbit/s equivalent). A minute is **active** if rx+tx delta ≥ `settings.usage.activeThresholdBytes`.
- Write `usage_minutes` (mac, minute bucket, rx, tx, active). Roll up to `usage_hourly` / `usage_daily`;
  delete raw minutes older than `retainRawDays`. Optionally cross-check with the stats engine when the
  capability is ok, but Unifire's own sampling is the source of truth.
- Person active minutes = **union** of active minutes across the person's devices (count a minute once).

## 2. Clients (complete WP2 endpoints)
- `Client.today` (activeMinutes, bytes since local midnight in settings tz), `blockReasons`, `blocked`,
  `managedRouteIds`, `personId`, `approval`.
- `GET /api/clients/:mac/usage?range=24h|7d|30d` → hourly buckets for 24h, daily for 7d/30d.

## 3. Approvals
- **Baseline first:** on the first successful client sync for a controller (or after switching controllers),
  every client already known to UniFi (`rest/user` + active) is imported as `approved` silently. Only MACs
  first seen *after* the baseline become `pending`. (WP2 currently marks everything pending — fix it and add a
  migration that approves clients whose `first_seen` in UniFi predates Unifire's first sync.)
- When the cache sees a MAC never seen before (not in `clients`) and `settings.approval.mode != 'off'`:
  approval `pending`, `detected_at`. If `matchRandomizedByHostname` and the MAC is locally administered and
  an approved client has the same hostname → auto-approve (audit it). Strict mode → desired block with
  source `approval` (quarantined). Engine event `client.new` (rules) + notification hook `new_device` (WP6
  adds actions) + live `approval.new`.
- `GET /api/approvals` (pending, newest first), `POST /api/approvals/:mac` approve (alias/person, remove
  approval block) / block (persistent manual block) / ignore (state ignored, remove approval block).

## 4. Block reconciler (`server/engine/blocks.ts`)
- Desired blocked set = union of: person pause (until), bedtime windows (person tz = settings tz, windows may
  cross midnight), quota exceeded with action block, approval (strict), rule blocks (until), manual blocks
  (until or indefinite). A person **allowance** (until) suppresses pause/bedtime/quota blocks (not
  approval/manual).
- Reconcile every 30 s + on changes: block/unblock through the write gate (`cmd/stamgr`). Record which
  blocks Unifire applied; **never unblock a client blocked in UniFi by someone else** — those appear as
  `blockReasons: [{source:'unifi'}]`. Audit each change with i18n keys. Dry-run honoured.

## 5. People & groups
- CRUD + `pause` (minutes|null), `resume`, `allow` (minutes), group pause/resume (applies to members),
  `GET /api/people/:id/quotas`. `Person.presence`, `pause`, `allowanceUntil` filled. Live events.

## 6. Quotas
- CRUD; status per person in scope (group → each member; client scope → single status with personId of
  that client). Period boundaries in settings tz: daily 00:00, weekly Monday 00:00, monthly 1st 00:00.
  `weekdayLimits` override the daily limit. `bonus` = approved extensions for this quota in the current
  period. `pct`, `state` ok/warning(≥warnAtPct)/exceeded(≥100%), `resetsAt`.
- Transitions emit engine events `quota.warning` / `quota.exceeded` (once per period per person), live
  `quota`, notification hooks. Actions: `block` (block source quota until period end), `egress` (create or
  reuse a Unifire-owned trafficroute `[unifire-quota] <person>` targeting the person's devices → egress;
  enable while exceeded, disable at period reset; it is `managed`-like ownership: Unifire-created),
  `notify`.
- `GET /api/quotas` returns quotas with `statuses[]`.

## 7. Extension requests
- Member `POST /api/me/requests` (one pending at a time per person → else 409 `REQUEST_PENDING`), admin
  `GET /api/extension-requests?status=`, `POST /api/extension-requests/:id` approve (amount override) /
  deny. Approve → time quota bonus for current period, or an allowance of `amount` minutes when the request
  has no quota. Pending requests expire at period end. Live `extension.request`; notification hook
  `extension_request` (WP6 adds approve/deny buttons).

## 8. Presence
- Person is home if any `presenceMacs` client is online; leaving only after offline ≥ `graceMinutes`.
  Store `presence_sessions`; engine events `person.arrived` / `person.left`; live `presence`.
- `GET /api/presence/timeline?from&to`.

## 9. Member portal
- `GET /api/me/summary` (person, devices, quota statuses, requests, blockedNow + reasons, next bedtime
  window). Members can only ever see their own person's data (also in SSE filtering from WP1).

## 10. Dashboard
- Fill `clients` (online, known, pendingApproval, blocked) and `people` (home, total, paused).

## 11. Mock seed
- Kids group with a weekday 2 h / weekend 4 h time quota, bedtime 22:00–07:00 for kids, one 20 GB monthly
  data quota, 2–3 pending approvals (one randomized MAC), one pending extension request, presence sessions
  for the last 7 days, 7 days of usage history (synthetic but plausible) so charts look alive.

## 12. Tests
- counter reset handling; union of active minutes; period boundaries incl. weekly/monthly & tz; weekday
  limits; block reconciliation never unblocks foreign blocks; allowance precedence; bedtime crossing
  midnight; presence grace; one pending request rule; member data isolation.

## WP4 review follow-ups (from Claude — do these too)
- **`SnapshotDiff.unavailableResources`** (contract accepted, already in `shared/schemas/insight.ts` as an
  optional array): populate it with every collection that could not be read (stored or live) instead of
  silently omitting it, so the UI can warn "these collections weren't compared".
- **One audit row per route switch.** A reconciler egress switch currently produces two rows:
  `audit.route.switched` and the gate's `audit.unifi.writeApplied` for the same PUT. Keep only
  `route.switched` (attach the gate's field diff to it); suppress the gate row for reconciler switches the
  same way `quietProbe` does, but keep failures loud.

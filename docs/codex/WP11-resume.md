# WP11 (resume) — finish the incident correlation work package

Read `docs/codex/BRIEF.md` and `docs/codex/WP11.md` (the full spec, including §6 follow-ups). A previous run of
WP11 was **interrupted (out of credits) at roughly 70 %**. Its partial work is in the working tree, uncommitted —
do **not** discard it; continue from it. Inspect `git status` / `git diff` first to see what exists:
`server/engine/infra/incidents/{signals,correlate,store}.ts`, `server/engine/reports/infra.ts`,
`server/api/incidents/**`, `server/api/reports/infra.get.ts`, migration `0010-incidents.ts`, and edits across the
sampler, device views, poe-state, notifiers, rules, mock, wan, ws.

## Known state when it stopped
- `pnpm typecheck` passes.
- `pnpm test`: **4 failing tests** in existing suites (caused by the partial changes, most likely the mock uptime
  persistence and planned-PoE-off handling). Fix the code or update the tests where the new behaviour is the
  intended one per WP11 §6 — explain each in the report:
  - `wp8-devices.test.ts` › samples identical polls and ignores failed polls, with WS device reads spaced ten seconds apart
  - `wp8-devices.test.ts` › classifies unexpected, ledger-backed, upgrade, and offline-return reboots, and records firmware changes
  - `wp8-devices.test.ts` › detects a boot during an outage even without a prior uptime reading
  - `wp9-port-energy.test.ts` › ignores a reset and the absolute error floor and detects flaps from native and observed counts
- No WP11 tests exist yet.

## To finish
1. Review the partial implementation against `docs/codex/WP11.md` §1–§6 and complete anything missing
   (correlation rules, root cause, suspects + diff snapshot pair, impact, severity escalation, resolution with
   quiet period, notifications incl. escalation, `incident.opened` trigger, live events, dashboard fields,
   `GET /api/reports/infra`, mock scenarios `offline-switch` / `reboot-ap` / `config-then-outage`, planned
   PoE-off never creating incidents, mock uptime surviving restarts).
2. Make all tests green and add the WP11 tests listed in `docs/codex/WP11.md`.
3. Register every new i18n key in `docs/backend/i18n-keys.md` (`incident.title.*`, `incident.signal.*`,
   `notification.incident_opened.*`, `notification.incident_resolved.*`, any errors).
4. `pnpm typecheck`, `pnpm test`, `pnpm test:contract` (WP11 endpoints added; run against the built server as in
   earlier WPs — `pnpm dev` hits EMFILE here), `pnpm build`.

Final report as described in the brief, plus a short "resumed from" note listing what you found incomplete.

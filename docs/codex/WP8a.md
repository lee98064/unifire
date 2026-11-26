# WP8a — Read-only, de-identified wire capture of UniFi infrastructure devices

Read `docs/codex/BRIEF.md` first. This WP is small and **must not change any runtime behaviour** of the app.

## Why
Phase 2 (switches/APs — see `docs/PLAN-infra.md`) needs the real Network 11.0.104 field shapes of
`stat/device` (gateway, switches, APs), `rest/device`, port tables, radio stats and WebSocket device/roam
events. `docs/unifi-wire-shapes.md` only covers routes and clients. Claude will run your script **once** on
the production host (`/opt/unifire`, data dir `/var/lib/unifire`, source checkout `~/unifire-src` with
`node_modules` installed), then feed the de-identified output to later work packages and the mock controller.

## Deliverable: `scripts/capture-wire.ts`
Run as: `pnpm tsx scripts/capture-wire.ts --data-dir /var/lib/unifire --out /tmp/unifire-wire.json [--ws-seconds 180] [--max-clients 15]`

1. **Strictly read-only towards UniFi.** Only GET requests, plus the existing login POST and the WebSocket
   subscription. No `cmd/*`, no PUT/POST/DELETE of any resource. Add a hard guard in the script's transport
   wrapper that throws if any non-GET (except login) is attempted.
2. **Strictly read-only towards the Unifire DB.** Open `<data-dir>/unifire.db` with better-sqlite3
   `{ readonly: true, fileMustExist: true }`; do not run migrations, do not take the engine lease, do not
   write settings. The production service keeps running in parallel. Read the controller row (`controller`
   table, id 1) and decrypt the password with the app secret (`UNIFIRE_SECRET` env, else
   `<data-dir>/secret.key`), reusing `server/utils/crypto.ts` helpers. Reuse `server/unifi/client.ts`
   (+ `tls.ts` pinned-fingerprint/CA trust exactly as the app does) for login/CSRF; do not weaken TLS checks.
   If importing server modules drags in Nitro auto-imports, write a minimal standalone equivalent instead,
   but keep the same TLS pinning semantics.
3. Capture (each wrapped in try/catch; record `{ ok:false, status, error }` on failure — never abort the run):
   - `stat/sysinfo`, `stat/health`
   - `stat/device` (full), `stat/device-basic`, `stat/device/<mac>` for one device of each `type`
   - `rest/device` (config docs), `rest/portconf`, `rest/wlanconf` (names/ids/flags only — drop all other keys)
   - `stat/sta` and `v2/api/site/<site>/clients/active?includeTrafficUsage=true&includeUnifiDevices=true`:
     keep at most `--max-clients` wireless + `--max-clients` wired rows
   - `v2 .../device` or `v2 .../devices` if they exist (probe both; record 404s)
   - WebSocket `wss://…/proxy/network/wss/s/<site>/events` for `--ws-seconds`: for every distinct
     `meta.message` (and, for `events`, every distinct `data[].key`), count occurrences and keep up to 3
     de-identified samples.
4. **De-identification (mandatory, applied to everything before writing the file):**
   - Remove every key starting with `x_`, and every key whose name matches
     `/pass|secret|token|psk|key$|auth|cookie|serial|license|anon_id|device_id|ssh|fingerprint/i` (keep the key
     with value `"<redacted>"` so the shape stays visible).
   - MACs (any string matching a MAC, any case, `:` or `-` separated, also inside larger strings): map to
     stable pseudonyms `02:00:00:00:HH:LL` (counter-based), consistent across the whole file so `uplink_mac`,
     `sw_mac`, `ap_mac`, `last_connection.mac`, etc. still line up.
   - IPv4: private addresses keep structure via a stable /24 map to `10.<n>.<m>.<same-last-octet>`; public
     addresses map to `203.0.113.<n>`. IPv6 → `2001:db8::<n>`. Apply inside larger strings too.
   - Human names: values of `name`, `hostname`, `display_name`, `essid`, `ssid`, `desc`, `description`, `note`,
     `uplink_device_name`, `device_name`, `last_uplink.uplink_device_name`, `wlan`… → `<field>-<n>` stable map.
     Keep `model`, `model_name`, `shortname`, `type`, `version`, `board_rev`, numeric stats, enums untouched.
   - Hostnames/domains in other strings (e.g. `*.local`, `ryan-lab.cc`) → `host-<n>.example`.
   Add `tests/server/capture-deidentify.test.ts` covering MAC/IP/name mapping consistency and key redaction.
5. Output JSON: `{ capturedAt, networkVersion, site, summary, resources: {...}, ws: { seconds, kinds: {...} } }`
   where `summary` lists every device: `{ pseudoMac, type, model, version, state, portCount, poePorts,
   sfpPorts, uplinkType, uplinkPseudoMac, radioBands, numSta }`. Also print `summary` as a table to stdout.
   Write the file with mode 0600.
6. Document usage in `docs/backend/capture-wire.md` (how to run on the host with `sudo -u unifire`, what is
   removed, that the output is safe to share for development).

## Done
`pnpm typecheck` + `pnpm test` green. Run the script against the mock controller once if feasible
(e.g. a `--mock` flag that uses `server/unifi/mock` instead of the DB) and include the summary output in your
report. Do not touch anything else.

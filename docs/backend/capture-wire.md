# Capture UniFi infrastructure wire shapes

Run the collector on the Unifire host while the service is running. Use the source checkout (typically `~/unifire-src`), with `node_modules` installed. The `unifire` account needs access to the checkout, its dependencies, and `pnpm`.

```sh
sudo -u unifire -- pnpm --dir "$HOME/unifire-src" tsx scripts/capture-wire.ts \
  --data-dir /var/lib/unifire --out /tmp/unifire-wire.json \
  --ws-seconds 180 --max-clients 15
```

The collector opens the existing `unifire.db` in read-only mode and gets the connection settings from controller row 1. It uses `UNIFIRE_SECRET` if set, then `NUXT_UNIFIRE_SECRET` (the service's environment variable), then the existing `secret.key` file. If the service uses an environment secret, make the same value available in the collector's environment through your usual secret-loading mechanism. `sudo` may clear the caller's environment, so preserve the appropriate variable if your sudo policy allows it. Keep the secret out of command arguments and shell history.

The collector uses the saved TLS trust configuration for HTTPS and WSS, the existing login POST, and a fixed set of GET requests. It subscribes to the event stream for 180 seconds by default. `--ws-seconds 0` skips the stream. Each client endpoint defaults to at most 15 rows of each connection class. If the connection type is absent, a client with a switch MAC counts as wired and other clients count as wireless. The output path must be new. The JSON file is created with mode `0600`.

## What the capture contains

- `summary` lists the pseudonymous devices with model, firmware, state, observed port counts, uplink, radio bands, and station count. The same summary is printed to stdout. Radio bands keep the controller's `band` or `radio` values.
- `resources` contains the device, health, configuration, and client reads. Detail resource names use pseudonymous MACs. Each failure records `ok: false`, the HTTP status when available, and a fixed error code. A 404 on an optional probe is a valid outcome.
- `ws.kinds` counts frames by `meta.message`, with up to three samples per kind. `ws.kinds.events.eventKeys` counts individual event rows and keeps up to three samples per event key. Event labels such as `EVT_WU_Roam` appear as bucket names, and the `key` field in the sample is redacted. An interrupted subscription records the failure alongside any samples collected.

The output is de-identified for sharing with the development team. It drops `x_*` fields and masks the values of sensitive keys, including passwords, tokens, session data, serial numbers, and fingerprints. Names, custom site labels, object IDs, and common free-text message fields receive placeholders. MACs, hostnames, and IP addresses receive consistent replacements across the file, including addresses embedded in other strings. Private IPv4 `/24` groupings and host octets are preserved. IPv4 and MAC values beyond the pseudonym ranges are masked. WLAN documents retain name, ID, and flag fields only. Hardware models, firmware versions, telemetry, and capture time are retained to support fixture and parser work.

## Run locally with the mock controller

With the Nuxt types prepared by `pnpm install` or `pnpm typecheck`, run the following. The mock sends its first simulated client events after 20 seconds.

```sh
capture_dir=$(mktemp -d)
pnpm tsx --tsconfig .nuxt/tsconfig.server.json scripts/capture-wire.ts \
  --mock --out "$capture_dir/unifire-wire.json" --ws-seconds 22 --max-clients 3
```

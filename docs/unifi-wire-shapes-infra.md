# UniFi infrastructure wire shapes — Network 11.0.104 (captured 2026-11-27)

Source: `scripts/capture-wire.ts` was run once, read-only, against the user's production UDM Pro. The output was
de-identified, and geo/ISP fields were scrubbed in a second pass. Fixture:
`tests/fixtures/wire/infra-capture-11.0.104.json`. **This file is authoritative for WP8+.** MACs are
pseudonyms (`02:00:00:00:xx:yy`), and names are placeholders (`name-12`, `essid-71`, …). Timestamps such as
`last_seen` and `last_connection.last_seen` are **epoch seconds**.

## Fleet

| pseudo MAC | `type` | `model` | What it is | Ports | PoE | Uplink |
|---|---|---|---|---|---|---|
| `…00:01` | `udm` | `UDMPRO` | UDM Pro, **the gateway** (has `wan1/wan2/wan3`, no `gateway_mac`) | 11 (2 × SFP+) | 0 | none (uplink = WAN) |
| `…00:03` | `usw` | `USPM16P` | USW Pro Max 16 PoE | 18 (16 × PoE, 2 × SFP+) | 16 | UDM port 11, SFP+ 10G |
| `…00:13` | `usw` | `USWED35` | USW Flex 2.5G 5 | 5 | 0 | USPM16P port 15, 2.5G |
| `…00:11` | `uap` | `U7PRO` | U7 Pro AP | — | — | USPM16P port 13, 2.5G (PoE 9.13 W) |
| `…00:1f` | **`udm`** | `UDMA69B` | **UniFi Express 7 in mesh/AP mode**: `device_mode_override:"mesh"`, `is_access_point:true`, has `gateway_mac` and radios | 2 | 0 | Flex port 4, 2.5G (wired) |

**Gateway detection must not rely on `type`.** A device is the gateway only if `type ∈ {udm, ugw, uxg}`,
it is not `is_access_point`, it has no `gateway_mac`, and it has `wan1` or no `uplink.uplink_mac`. The
current `isGateway()` in `server/services/cache.ts` (type only) happens to work because the UDM Pro is listed
first. Fix it in WP8. The UX7 is an **AP** (`DeviceType 'ap'`).

## `stat/device` fields used

- `state` 1 = online (all devices). `adopted`, `_id` (needed for `rest/device/{_id}` writes), `ip`, `version`,
  `upgradable` (bool), `upgrade_to_firmware` (absent when up to date), `uptime` (s), `last_seen` (epoch s),
  `locating` (bool), `led_override` (`"off"` on the U7 Pro).
- `system-stats`: `{ cpu: "12.8", mem: "66.3", uptime: "1128845" }` — **strings**. The switch omits `uptime`.
- Temperature: switch → `general_temperature: 44` plus `has_temperature: true`. UDM/UX7 → `temperatures:
  [{ name, type: "cpu" | "board", value }]`. The U7 Pro and Flex report none (null).
- `num_sta` (U7 Pro 5, UX7 14, UDM 39).
- `total_max_power: 180`, `total_used_power: 13.17` on the PoE switch.
- `uplink` (wired example): `{ type: "wire", uplink_mac, uplink_remote_port, port_idx (local), speed,
  max_speed, full_duplex, media ("SFP+", "2P5GE"), "rx_bytes-r", "tx_bytes-r", uplink_device_name,
  uplink_source, rx_errors, tx_errors, … }`. The gateway's `uplink` describes its WAN (`speed 10000`,
  `latency`, `xput_down`, `speedtest_*`) and has no `uplink_mac`. The U7 Pro also has
  `uplink_port_poe_caps`.
- `downlink_table: [{ mac, port_idx, speed, full_duplex }]` lists devices hanging off a port (UDM → switch on
  11; USPM16P → U7 Pro on 13 and Flex on 15). `downlink_lldp_macs` is present on USPM16P.
- `port_overrides` **is present in `stat/device`** (the UDM, the switches; not the APs). Each entry holds the
  full per-port config, e.g. `{ port_idx, name, poe_mode: "auto" | "off", native_networkconf_id, forward,
  autoneg, setting_preference, … }`. Ports without an entry have no override.

## `rest/device`

`GET rest/device` → **404 `UNIFI_NOT_FOUND`** on this build. There is no collection read. For the PoE
read-modify-write, take the freshest `port_overrides` from `stat/device/<mac>`, then
`PUT rest/device/{_id}` with `{ port_overrides: [...] }` (the full array, every entry preserved). Read back via
`stat/device`. The PUT path itself is **unverified** on 11.0.104 and must go through PoE qualification (see
the plan). For snapshots of device config, use `stat/device` and store only config-like keys (`name`,
`port_overrides`, `radio_table`, `led_override`, `config_network`, `mgmt_network_id`, `ethernet_overrides`);
do not store the volatile stats.

## `port_table[]` (USPM16P has the richest set)

`port_idx, name, media ("GE" | "2P5GE" | "10GE" | "SFP+"), enable, up, speed (0 when down), full_duplex,
autoneg, speed_caps, is_uplink, port_poe (bool, PoE capable), poe_caps (3), poe_mode ("auto" | "off" |
null on non-PoE), poe_enable, poe_good, poe_power (STRING "9.13"), poe_voltage, poe_current, poe_class
("Class 4" | "Unknown"), rx_/tx_bytes, rx_/tx_packets, rx_/tx_errors, rx_/tx_dropped, "rx_bytes-r",
"tx_bytes-r", stp_state ("forwarding" …), stp_state_change_count: [{ change_count, mst }], link_down_count
(native flap counter — USPM16P only), mac_table_count (MACs behind the port), last_connection: { connected,
mac, ip, last_seen (s), connected_at (s) } (the peer!), satisfaction (0–100) and satisfaction_reason,
anomalies, sfp_found, sfp_part, sfp_vendor, sfp_compliance, sfp_rxfault/sfp_txfault`.

- **Peer detection**: use `last_connection.mac`, or `downlink_table` for UniFi devices. Then match clients'
  `sw_mac/sw_port` (or `last_uplink_mac/last_uplink_remote_port`). `mac_table_count > 1` means an unmanaged
  switch, a hub or VMs.
- **Flapping**: prefer deltas of `link_down_count` where present. Otherwise count `up` transitions between
  polls.
- **PoE already off**: USPM16P ports 9, 10, 12 and 14 have `poe_mode: "off"`, set by the user in UniFi. Per the
  ownership rule, Unifire never turns these on.
- `speed_caps` bitmask (verified against the media types): `1=10H 2=10F 4=100H 8=100F 16=1000H 32=1000F
  64=2500F 128=5000F 256=10000F`. Bit `0x100000` = autoneg. Examples: GE `0x10002F` → max 1000, 2P5GE
  `0x10006F` → 2500, SFP+ `0x100120` → 10000, UX7 10GE `0x1001EC` → 10000.
- The UDM ports carry `poe_power: "0.00"` and `poe_class: "Class 0"`, but `port_poe: false`, so they are not
  PoE capable.

## Radios (U7 Pro, UX7)

- `radio_table[]`: `{ name, radio: "ng" | "na" | "6e", channel: number | "auto", ht: "20" | 40 | 240 | 320
  (string or number!), tx_power, tx_power_mode, min_rssi_enabled }`.
- `radio_table_stats[]`: `{ name, radio, channel (actual), bw, cu_total, cu_self_rx, cu_self_tx,
  cu_interf, tx_power, tx_retries, tx_retries_pct, tx_packets, num_sta, user-num_sta, guest-num_sta,
  satisfaction (-1 = n/a), state, gain, last_channel, last_bw }`.
- Map `ng → 2.4`, `na → 5`, `6e → 6`. Interference % = `cu_interf` when present, else
  `cu_total − cu_self_rx − cu_self_tx` (clamped at 0 or above). Width = `bw` (actual), else `ht`.

## Clients (`stat/sta`, `v2 clients/active`)

Wireless rows carry `ap_mac, bssid, essid, radio, radio_proto, channel, signal (dBm), rssi, noise,
satisfaction, tx_rate/rx_rate (kbps), tx_retries, wifi_tx_retries_percentage, last_uplink_mac,
last_uplink_name, last_uplink_remote_port, uptime, assoc_time, latest_assoc_time, is_11r, is_mlo,
powersave_enabled`. There is **no `roam_count`**. Wired rows carry `sw_mac/sw_port` (or `last_uplink_*`).

## WebSocket (`/proxy/network/wss/s/<site>/events`, 180 s sample)

`meta.message` counts: `device:sync` 161, `unifi-device:sync` 162 (both about 1/s, full device docs),
`sta:sync` 94 (client docs incl. `ap_mac`), `vpn-connection:sync` 208, `vpn-users:sync` 67,
`speed-test:update` 67, `device:update` 1 (`firewall_hits_state`), `session-metadata:sync` 1.
**No `events` frames arrived** (so no `EVT_WU_Roam`). Roaming detection must not depend on WS events:
watch `ap_mac` changes in `sta:sync` payloads plus the per-minute client poll, and dedupe.
`device:sync` arrives about every second, so cache refreshes triggered by it must stay throttled
(cache-level debounce ≥ 10 s).

## `v2/api/site/<site>/device`

Returns `{ network_devices[], unmanaged_devices[] (empty here), access_devices, protect_devices, … }`.
`network_devices[]` has `is_access_point`, `device_type: "MANAGED"`, `product_line`, `restarting`,
`displayable_version`, `model_in_eol`, `model_in_lts`, `sys_stats`. It is not needed for WP8, but it is a
good fallback for AP detection and unmanaged-device topology later. `v2/devices` returns HTML (unsupported).

# Backend i18n keys

## WP1 audit messages

| Key | English description | Params |
|---|---|---|
| `audit.auth.login` | A user signed in. | `username`, `method` (password or passkey) |
| `audit.auth.loginFailed` | A sign-in attempt failed. | `method` (password or passkey) |
| `audit.auth.userCreated` | A user account was created. | `username` |
| `audit.auth.userUpdated` | A user account was updated. | `username` |
| `audit.auth.userDeleted` | A user account was deleted. | `username` |
| `audit.auth.passwordChanged` | A user's password was changed. | `username` |
| `audit.auth.passkeyRegistered` | A user registered a passkey. | `username` |
| `audit.config.settingsChanged` | Application settings were updated. | `keys` (comma-separated setting names) |

## WP1 API errors

| Key | English description | Params |
|---|---|---|
| `errors.invalidInput` | The request failed validation. | None |
| `errors.invalidCursor` | The audit pagination cursor is invalid. | None |
| `errors.invalidTimezone` | The time zone is not a supported IANA identifier. | None |
| `errors.authRequired` | Sign in to continue. | None |
| `errors.forbidden` | This action requires an administrator. | None |
| `errors.memberUnbound` | This member account has no linked person. | None |
| `errors.invalidCredentials` | Sign-in credentials could not be verified. | None |
| `errors.loginRateLimited` | Wait before trying to sign in again. | None |
| `errors.setupComplete` | An administrator has already been created. | None |
| `errors.userNotFound` | This account could not be found. | None |
| `errors.usernameTaken` | That username is already in use. | None |
| `errors.personNotFound` | The selected person could not be found. | None |
| `errors.lastAdmin` | Keep at least one administrator account. | None |
| `errors.userChanged` | The account changed during the password update. Retry with the current password. | None |
| `errors.webAuthnBusy` | Wait before starting another passkey attempt. | None |
| `errors.webAuthnChallengeInvalid` | Start a new passkey attempt. The previous challenge is invalid or expired. | None |
| `errors.webAuthnRegistrationFailed` | The passkey could not be registered. | None |
| `errors.webAuthnAlreadyRegistered` | This passkey is already registered. | None |

## WP2 audit and client block messages

| Key | English description | Params |
|---|---|---|
| `audit.config.controllerSaved` | Controller settings were saved. | `site` |
| `audit.config.controllerModeChanged` | The controller write mode was changed. | `mode` |
| `audit.unifi.writeApplied` | UniFi accepted the requested change. | `action`, `target` |
| `audit.unifi.writeUnchanged` | No controller write was needed. | `action`, `target` |
| `audit.unifi.writeDryRun` | Unifire evaluated a write in dry-run mode. | `action`, `target` |
| `audit.unifi.writeFailed` | A controller write was refused, failed, or could not be verified. | `action`, `target`, `error` (error code) |
| `audit.egress.updated` | An egress's Unifire settings were updated. | `egress` |
| `audit.client.updated` | A client's Unifire details were updated. | `mac` |
| `block.manual` | An administrator blocked this device in Unifire. | None |
| `block.unifi` | This device was blocked directly in UniFi. | None |

## WP2 API errors

| Key | English description | Params |
|---|---|---|
| `errors.unifiInvalidUrl` | Enter a controller HTTPS origin without a path or credentials. | None |
| `errors.unifiInvalidSite` | Enter a valid UniFi site identifier. | None |
| `errors.unifiInvalidFingerprint` | Enter a valid SHA-256 certificate fingerprint. | None |
| `errors.unifiCaRequired` | Supply a CA certificate in PEM format. | None |
| `errors.unifiPasswordRequired` | Enter a password for the controller account. | None |
| `errors.unifiInactive` | The Unifire controller service is temporarily unavailable. | None |
| `errors.unifiNotConfigured` | Configure a UniFi controller first. | None |
| `errors.unifiTimeout` | The controller request timed out. | None |
| `errors.unifiNotFound` | UniFi could not find the requested resource. | None |
| `errors.routeNotOwned` | This route is outside Unifire's write ownership. | None |
| `errors.unifiRouteDrift` | The route differs from its accepted baseline. | None |
| `errors.unifiBlockNotOwned` | Manage this block directly in UniFi. | None |
| `errors.unifiQualificationRequired` | Run the controller's live capability probe before writing to UniFi. | None |
| `errors.unifiClientStateUnknown` | UniFi did not report the client's current block state. | None |
| `errors.clientNotFound` | The client could not be found. | None |
| `errors.egressNotFound` | The egress could not be found. | None |
| `errors.unifiRequestFailed` | The controller request failed. | None |

## WP2 controller status and capability details

| Key | English description | Params |
|---|---|---|
| `controllerError.authRequired` | The controller rejected the session or credentials. | None |
| `controllerError.authLocked` | Automatic login stopped after three rejected attempts. | None |
| `controllerError.loginBackoff` | Unifire is waiting before the next login attempt. | None |
| `controllerError.loginResponse` | The login response lacked a session cookie or CSRF token. | None |
| `controllerError.forbidden` | The controller refused this operation. | None |
| `controllerError.rateLimited` | The controller is rate limiting requests. | None |
| `controllerError.fingerprintMismatch` | The certificate does not match the trusted fingerprint. | None |
| `controllerError.tls` | The controller TLS connection could not be established. | None |
| `controllerError.html` | The controller returned an HTML page. | None |
| `controllerError.http` | The controller returned an unexpected HTTP status. | None |
| `controllerError.timeout` | The controller request timed out. | None |
| `controllerError.notFound` | The requested controller endpoint or resource is unavailable. | None |
| `controllerError.invalidResponse` | The controller response did not match the expected format. | None |
| `controllerError.api` | The controller API rejected the request. | None |
| `controllerError.websocket` | The controller event stream could not be opened. | None |
| `controllerError.verifyFailed` | Reading the controller back did not confirm the change. | None |
| `capability.empty` | The controller returned an empty result. | None |
| `capability.authRequired` | Connect to the controller before testing this capability. | None |
| `capability.dryRun` | The test would write to the controller, so dry run skipped it. | None |
| `capability.reprobeRequired` | Probe the controller to verify this write capability. | None |
| `capability.selfMacRequired` | Detect or enter the Unifire host MAC first. | None |
| `capability.wanRequired` | The scratch route requires an enabled WAN. | None |
| `capability.routesRequired` | The controller must support listing routes for the scratch test. | None |
| `capability.scratchUnavailable` | A verified scratch route was unavailable for this step. | None |
| `capability.requiresAction` | Verification requires running the actual controller command. | None |
| `capability.speedtestStatusOnly` | The controller supports querying speed-test status. | None |

## WP3 managed routes and egress health

| Key | English description | Params |
|---|---|---|
| `audit.route.managedChanged` | A managed route was created, adopted, updated, released, scheduled, overridden, or resumed. | `route`, `action` |
| `audit.route.drift` | Unifire suspended writes after detecting a change to a managed route's forwarding criteria. | `route` |
| `audit.route.switched` | Unifire evaluated a switch between egresses. The audit severity and dry-run flag indicate the outcome. | `route`, `from`, `to`, `reason` |
| `audit.egress.ipChanged` | A sweep verified a different public IP for the egress. | `egress`, `from`, `to` |
| `audit.egress.sweepDryRun` | Dry run skipped the public IP sweep. | `total` |
| `errors.managedRouteNotFound` | The managed route could not be found. | None |
| `errors.routeCreateUnsupported` | UniFi route creation is unavailable. Create the route in UniFi, then adopt it. | None |
| `errors.routeExternallyAutomated` | Recent external egress changes suggest this route is already automated. | None |
| `errors.routeShapeUnsupported` | This route uses forwarding criteria that the managed route editor cannot represent. | None |
| `errors.routeReservedName` | The name is reserved for automatic probe or quota routes. | None |
| `errors.routeDestinationsRequired` | Add at least one destination for this matching target. | None |
| `errors.overrideInvalidEnd` | The override must end in the future. | None |
| `route.unnamed` | Default label for a route without a description. | None |
| `route.state.drift` | This route's forwarding criteria have changed. Review them before resuming. | None |
| `route.state.missing` | UniFi no longer lists this route. | None |
| `route.state.dryRun` | This route is a dry-run preview. | None |
| `probe.detail.drift` | The UniFi probe route differs from its expected configuration. | None |
| `probe.detail.ipPoolExhausted` | No unused IPv4 probe destination is available. | None |
| `probe.detail.selfMacRequired` | Detect or enter the Unifire host MAC to use probe routes. | None |
| `probe.detail.dryRun` | Dry run skipped the live sweep. | None |
| `probe.detail.traceTimeout` | The trace did not confirm a stable distinct public IP within 20 seconds. | None |

## WP4 snapshots and configuration audit

| Key | English description | Params |
|---|---|---|
| `snapshots.summary.routeEgress` | A traffic route changed egress. | `route`, `from`, `to` |
| `snapshots.summary.routeToggled` | A traffic route was enabled or disabled. | `route`, `state` (boolean string) |
| `snapshots.summary.added` | An item was added. | `resource`, `label` |
| `snapshots.summary.removed` | An item was removed. | `resource`, `label` |
| `snapshots.summary.modified` | One or more fields were modified. | `resource`, `label`, `fields` (count) |
| `snapshots.summary.wifiPassword` | A Wi-Fi credential changed. | `ssid` |
| `snapshots.summary.firewallToggled` | A firewall policy was enabled or disabled. | `name`, `state` (boolean string) |
| `audit.snapshot.created` | A configuration snapshot was captured. | `trigger`, `failed` (empty) |
| `audit.snapshot.incomplete` | Some collections were unavailable during capture. | `trigger`, `failed` (resource ids) |
| `audit.snapshot.deleted` | A snapshot was deleted. | None |
| `audit.snapshot.restoreApplied` | A restore step was applied and verified. | `action`, `target` |
| `audit.snapshot.restoreFailed` | A restore step failed. | `action`, `target`, `error` (error code) |
| `audit.snapshot.restoreSkipped` | A restore step was skipped. | `action`, `target`, optional `reason` (reason code) |
| `audit.snapshot.restoreCompensated` | The original DNS record was recreated after its replacement failed. | `target` |
| `audit.config.externalChange` | A controller configuration item changed outside Unifire. | `resource`, `label` |
| `audit.unifi.log` | A UniFi system event was recorded. | `message` (safe event code or redaction marker), `key` (UniFi event code) |
| `audit.egress.sweepDone` | An egress public-IP sweep finished. | `total`, `ok`, `changed`, `failed` |
| `audit.egress.probesProvisioned` | Probe routes were created, repaired, or removed. | `created`, `repaired`, `removed` |
| `audit.egress.probeOverlap` | An unowned route overlaps the requested probe. | `egress` |
| `errors.snapshotNotFound` | The snapshot could not be found. | None |
| `errors.snapshotItemNotFound` | The item could not be found in the snapshot. | None |
| `errors.snapshotScopeMismatch` | The snapshot belongs to a different controller or site. | None |
| `errors.invalidSnapshotCron` | The snapshot schedule is not a valid cron expression. | None |
| `errors.unifiSnapshotIncomplete` | The collection could not be captured before writing to UniFi. | None |

### WP5 access control

| Key | Description | Params |
|---|---|---|
| `errors.groupNotFound` | The selected group could not be found. | None |
| `errors.invalidPresenceDevices` | Presence devices must belong to this person. | None |
| `errors.quotaNotFound` | The selected quota is unavailable to this user or could not be found. | None |
| `errors.quotaScopeNotFound` | The person, group, or client selected for the quota could not be found. | None |
| `errors.approvalNotPending` | This client already has an approval decision. | None |
| `errors.requestPending` | This person already has an extension request awaiting a decision. | None |
| `errors.requestNotFound` | The selected extension request could not be found. | None |
| `errors.requestNotPending` | This request already has a decision or has expired. | None |
| `block.pause` | Internet access is paused for the person or their group. | None |
| `block.bedtime` | The person is in a scheduled bedtime window. | None |
| `block.quota` | The person or client has reached a blocking quota. | None |
| `block.approval` | This client is waiting for approval in strict mode. | None |
| `block.rule` | An automation rule blocked this client. | None |
| `audit.approval.hostnameMatched` | Unifire approved a randomized MAC that matched an approved hostname. | `mac`, `name`, `hostname` |
| `audit.approval.approved` | An administrator approved the client. | `mac`, `name` |
| `audit.approval.blocked` | An administrator selected a persistent block for the client. | `mac`, `name` |
| `audit.approval.ignored` | An administrator dismissed the client's approval request. | `mac`, `name` |
| `audit.block.applied` | Unifire applied a client block. The dry-run flag identifies previews. | `mac`, `name` |
| `audit.block.released` | Unifire released its client block. The dry-run flag identifies previews. | `mac`, `name` |
| `audit.extension.approved` | An administrator approved an extension request. | `requestId`, `person`, `minutes` (request or grant amount) |
| `audit.extension.denied` | An administrator denied an extension request. | `requestId`, `person`, `minutes` (request or grant amount) |

## WP6 notification titles and bodies

| Keys | English description | Params |
|---|---|---|
| `notification.new_device.title`, `notification.new_device.body` | A newly discovered device is waiting for approval. | `displayName`, `mac` |
| `notification.route_switch.title`, `notification.route_switch.body` | A managed route switched egress successfully. | `route`, `from`, `to`, `reason`, `managedRouteId` |
| `notification.route_drift.title`, `notification.route_drift.body` | A managed route changed outside its accepted baseline. | `route`, `managedRouteId` |
| `notification.egress_down.title`, `notification.egress_down.body` | An egress became unavailable. | `egress`, `egressId` |
| `notification.egress_up.title`, `notification.egress_up.body` | An egress recovered. | `egress`, `egressId` |
| `notification.egress_ip_changed.title`, `notification.egress_ip_changed.body` | An egress public address changed. | `egress`, `egressId`, `previousIp`, `ip` |
| `notification.quota_warning.title`, `notification.quota_warning.body` | Usage reached the quota warning threshold. | `quota`, `quotaId`, optional `person`, `personId` |
| `notification.quota_exceeded.title`, `notification.quota_exceeded.body` | Usage exceeded the quota. | `quota`, `quotaId`, optional `person`, `personId` |
| `notification.extension_request.title`, `notification.extension_request.body` | A member submitted a request for an extension. | `person`, `personId`, `requestId` |
| `notification.extension_decided.title`, `notification.extension_decided.body` | An administrator decided the recipient's request. | `person`, `personId`, `requestId`, `minutes` (request or grant amount), `status` (approved or denied) |
| `notification.poe_cycle.title`, `notification.poe_cycle.body` | Unifire requested a PoE port cycle. | `name`, `switchMac`, `portIdx`, optional `watchdogId` |
| `notification.external_change.title`, `notification.external_change.body` | Unifire observed an external controller configuration change. | `resource`, `itemId`, `label` |
| `notification.guest_wifi_rotated.title`, `notification.guest_wifi_rotated.body` | The guest Wi-Fi passphrase was rotated. | `ssid`, `wlanId` |
| `notification.controller_error.title`, `notification.controller_error.body` | The configured controller reported a new connection error. | `error` (translated controller status) |
| `notification.test.title`, `notification.test.body` | A channel test message. | None |

Rule notifications use the administrator-provided templates. The test action uses the two test keys even when the channel is subscribed to other events.

## WP6 action, status, audit, and error messages

| Key | English description | Params |
|---|---|---|
| `notification.action.approve` | Approve the device or request. | None |
| `notification.action.block` | Block the device. | None |
| `notification.action.deny` | Deny the extension request. | None |
| `notification.action.open` | Open the route in Unifire. | None |
| `notification.action.succeeded` | The notification action succeeded. | None |
| `notification.action.failed` | The notification action failed or expired. | None |
| `notification.delivery.failed` | A channel failed to deliver a message. | None |
| `notification.delivery.noSubscription` | This account has no reachable push subscription for the test. | None |
| `rule.result.would` | Dry-run preview of this action. | None |
| `rule.result.failed` | The action failed. | None |
| `rule.result.webhookFailed` | The rule webhook request failed. | None |
| `watchdog.event.fail` | The target stopped responding. | None |
| `watchdog.event.cycle` | UniFi accepted a PoE cycle. | None |
| `watchdog.event.recovered` | The target started responding again. | None |
| `watchdog.event.limit` | The port reached its daily cycle limit. | None |
| `watchdog.event.error` | The monitor or PoE command reported an error. | None |
| `audit.push.routeOpened` | An administrator used the route-drift notification action. | None |
| `audit.rule.run` | A rule ran and changed state. | `name`, `initiatedBy` (empty for scheduled or event-driven runs) |
| `audit.watchdog.cycle` | A watchdog port was power-cycled. | `name` |
| `audit.guestWifi.rotated` | UniFi confirmed the new guest passphrase. | `ssid` |
| `audit.wol.woke` | A Wake-on-LAN packet was sent. | `name`, `mac`, `broadcast` |
| `audit.wol.preview` | Dry-run preview of a Wake-on-LAN request. | `name`, `mac`, `broadcast` |
| `audit.wol.failed` | A Wake-on-LAN request failed. | `name`, `mac`, `broadcast` |
| `audit.quota.routeOverlap` | The quota egress overlaps a managed route. | `person`, `route` |
| `errors.invalidChannelSecret` | Enter a secret when configuring a new channel. | None |
| `errors.channelNotFound` | The notification channel could not be found. | None |
| `errors.pushActionInvalid` | The notification action is invalid, expired, or already used. | None |
| `errors.invalidAutomationCron` | Enter a valid cron expression. | None |
| `errors.ruleNotFound` | The rule could not be found. | None |
| `errors.watchdogNotFound` | The watchdog could not be found. | None |
| `errors.watchdogDuplicatePort` | The port already has a watchdog. | None |
| `errors.watchdogDailyLimit` | The daily power-cycle limit was reached. | None |
| `errors.watchdogCooldown` | The watchdog's port is cooling down. | None |
| `errors.unsafePoePort` | Select a downstream PoE-capable port. | None |
| `errors.guestWlanRequired` | Select a WLAN to rotate. | None |
| `errors.wlanNotFound` | The WLAN could not be found. | None |
| `errors.wlanPskRequired` | Select a WLAN configured for a shared WPA passphrase. | None |
| `errors.kioskNotFound` | This kiosk link is invalid or unavailable. | None |
| `errors.kioskRateLimited` | Wait before requesting the kiosk again. | None |
| `errors.wolNotFound` | The Wake-on-LAN target could not be found. | None |
| `errors.wolBroadcastUnknown` | Configure a broadcast address for this target or its network. | None |
| `errors.wolSendFailed` | The Wake-on-LAN packet could not be sent. | None |

## WP7 reports and operations

| Key | Description | Params |
| --- | --- | --- |
| `errors.speedtestUnsupported` | Gateway speed testing is unavailable on the configured controller. | None |
| `errors.databaseUnavailable` | The local database health check failed. | None |

## WP8 device fleet and health

| Key | Description | Params |
| --- | --- | --- |
| `infra.issue.offline` | The device is offline. | None |
| `infra.issue.overheat` | The device temperature is at or above the configured warning threshold. | `temp` (°C) |
| `infra.issue.high_cpu` | CPU utilization is at or above the configured warning threshold. | `cpu` (%) |
| `infra.issue.high_mem` | Memory utilization is at or above the configured warning threshold. | `mem` (%) |
| `infra.issue.firmware_available` | The controller offers a firmware update. | `version` |
| `infra.issue.unexpected_reboot` | An unexpected reboot occurred in the last 24 hours. | None |
| `diff.device.port_override` | A device port override field changed. | `device`, `port`, `field`, `from`, `to` |
| `diff.device.name` | The device name changed. | `device`, `from`, `to` |
| `diff.device.radio` | A device radio setting changed. | `device`, `radio`, `field`, `from`, `to` |
| `errors.deviceNotFound` | The infrastructure device could not be found. | None |
| `errors.gatewayConfirmationRequired` | Restarting the gateway requires explicit confirmation. | None |
| `rule.result.not_implemented` | A rule uses a trigger, condition, or action from a later work package. | None |
| `notification.device_firmware.title` | Title for an available device firmware update. | `device`, `version`, `mac` |
| `notification.device_firmware.body` | Details for an available device firmware update. | `device`, `version`, `mac` |

## WP9 — port health, PoE schedules and energy

| Key | Meaning | Params |
| --- | --- | --- |
| `port.event.downgrade` | A port negotiated below its baseline for the same peer. | `switch`, `port`, `from`, `to`, `peer`, `rate`, `flaps` |
| `port.event.recovered` | A downgraded link returned to its baseline. | Same as downgrade |
| `port.event.errors` | A port exceeded the hourly error threshold. | Same as downgrade |
| `port.event.flapping` | A port exceeded the hourly link-down threshold. | Same as downgrade |
| `port.event.new_device` | An unapproved peer appeared on this port. | Same as downgrade |
| `port.event.peer_changed` | An approved peer appeared on this port for the first time. | Same as downgrade |
| `infra.issue.port_issue` | A device has active port issues. | `count` |
| `poe.reason.port_missing` | The controller did not report the target PoE port or its mode. | — |
| `poe.reason.not_poe` | This port does not provide PoE. | — |
| `poe.reason.uplink` | This port is an uplink. | — |
| `poe.reason.downstream_devices` | Adopted devices depend on the port. | — |
| `poe.reason.unifire_host` | The Unifire host depends on the port. | — |
| `poe.reason.gateway_path` | The port is on the route to the gateway. | — |
| `poe.reason.ack_required` | Confirm that powering down the attached AP is intended. | — |
| `poe.reason.externally_off` | UniFi already had PoE disabled on this port. | — |
| `poe.reason.unqualified` | PoE writes require qualification on this Network version. | — |
| `poe.reason.drift` | The port was enabled in UniFi while Unifire held it off. | `name`, `switch`, `port` in audit and notifications |
| `poe.reason.blocked` | A PoE schedule is blocked by a safety check. | `name`, `switch`, `port`, `reason` in audit and notifications |
| `poe.reason.error` | A PoE operation failed. | `error` when available, `name`, `switch`, `port` in audit and notifications |
| `notification.port_issue.title`, `notification.port_issue.body` | Port health notification. | `switch`, `port`, `kind`, `description` (localized event), plus event params |
| `notification.poe_schedule.drift.title`, `notification.poe_schedule.drift.body` | A schedule or override yielded to a UniFi change. | `name`, `switch`, `port`, `reason` |
| `notification.poe_schedule.blocked.title`, `notification.poe_schedule.blocked.body` | A safety condition blocks a schedule. | `name`, `switch`, `port`, `reason` |
| `notification.poe_schedule.error.title`, `notification.poe_schedule.error.body` | PoE reconciliation failed. | `name`, `switch`, `port`, `reason`, `error` when available |
| `diff.device.port_overrides` | The device's port override array changed. | `device` |
| `errors.poeNotOwned` | The requested action requires a port currently held by Unifire. | — |
| `errors.poeUnsafe` | The requested power-off failed safety checks. | — |
| `errors.poeAckRequired` | The AP power-off acknowledgement is required. | — |
| `errors.poeNotQualified` | The current Network version lacks PoE write qualification. | — |
| `errors.poeHeld` | A Unifire hold or boot grace period prevents a watchdog cycle. | — |
| `errors.poePortNotFound` | The controller did not report this port. | — |
| `errors.poeScheduleNotFound` | This PoE schedule does not exist. | — |
| `errors.poeScheduleExists` | The port already has a PoE schedule. | — |
| `errors.portEventNotFound` | This port event does not exist. | — |
| `errors.dryRun` | This operation needs live mode to complete safely. | — |

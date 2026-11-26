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
| `errors.routeReservedName` | The name is reserved for probe routes. | None |
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

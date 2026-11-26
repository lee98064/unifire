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

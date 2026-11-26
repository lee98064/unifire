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

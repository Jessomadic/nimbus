# Username, password and required passkey

The owner is **Jessomadic**. The existing password remains unchanged. Named-owner mode requires both the username/password and a verified passkey; a correct password alone never issues an app session. The first passkey is created directly on the sign-in device after verifying the username/password. Once enrolled, a password alone cannot register another key.

## First enrollment

Open **https://nimbus.jessecopas.com** in Safari on the iPhone or a passkey-capable browser on the PC. Enter **Jessomadic** and the existing password, then choose **Continue**. Nimbus opens the device's passkey creation prompt automatically. Approve on the device or security key to finish signing in. No enrollment link is needed.

The device must perform user verification. Nimbus stores only the public credential; its server never generates or saves the device's private key. This final physical-device step must be completed by the owner. If the native prompt is cancelled or the browser requires another gesture, choose **Create passkey** on the displayed step to retry. No app access is granted until verification succeeds.

Automatic first enrollment is allowed only while both the credential count and the durable owner credential version are zero. The first completed registration increments that version and invalidates other pending first-enrollment challenges. Losing keys or deleting database credential rows later does not reopen automatic enrollment.

For later sign-ins, enter the username/password and choose **Continue**. Nimbus automatically opens the passkey verification prompt; a **Verify passkey** button remains available for retry. Passkeys are bound to this exact HTTPS origin and `nimbus.jessecopas.com` relying-party ID. A key registered here is not a localhost key; localhost login shows the canonical sign-in address.

## Owner recovery

If every registered device/key is lost, run this on the trusted Nimbus PC:

```powershell
node --no-warnings --env-file-if-exists=.env bin/passkeys.mjs enroll
```

Open the resulting **one-time, 15-minute HTTPS recovery link**, enter **Jessomadic** and the existing password, then approve creation on the replacement device. The local administration interface is required to issue this recovery link. The normal public sign-in page cannot replace an already enrolled key using just the password.

The recovery link is consumed when the correct username/password starts registration. Cancelling the native prompt can retry that short-lived challenge. If recovery is reloaded or restarted, generate a fresh link. The browser removes the recovery secret from its address bar and keeps it only in the login module's closure. No recovery link is involved in ordinary first enrollment.

Until the first key is registered, the app stays locked rather than accepting the password alone. The trusted Windows administration API remains available locally for setup and recovery. The old `bin/nimbus.mjs OPEN` browser shortcut is disabled in this mode.

## Additional keys and removal

After signing in, open **You → Passkeys**. Within five minutes of a complete sign-in, enter the current password and choose **Add passkey** to register another device/key. Each addition or removal invalidates other sessions and pending challenges; the current session rotates securely. Removal requires a fresh complete sign-in and the password. The last registered key cannot be removed.

If all devices are lost, the Windows owner can generate another one-time enrollment link with the command above, then provide the username/password and register a replacement. This is a local recovery path, not a public password fallback. After recovery, remove lost credentials from the Passkeys panel. Windows owner/admin access remains trusted as documented in [security](SECURITY.md).

## Implementation and verification

- Fixed `NIMBUS_USERNAME=Jessomadic` and `NIMBUS_PUBLIC_ORIGIN=https://nimbus.jessecopas.com` in the ignored local `.env`. Username matching is case-insensitive; username-only or password-only sign-in is rejected.
- Standards verification uses pinned `@simplewebauthn/server` and a locally bundled `@simplewebauthn/browser`. Registration uses resident credentials, user verification required and no identifying attestation. Authentication requires user presence/verification, the exact origin/RP ID, the saved credential key and valid counter behavior.
- Five-minute, single-use challenges are bound to the password credential version, passkey version, ceremony kind and a separate HttpOnly/Secure host-only browser cookie. Pending registration has no access to private APIs. Management also binds to its originating authenticated session before and after cryptographic verification.
- SQLite retains public keys, random owner user handle, counters, labels and timestamps. The normal encrypted backup includes this public credential state. Restores discard browser sessions and require a new sign-in; using the same hostname/RP ID preserves the registered key relationship. Changing hostname requires an explicit new enrollment plan.
- `tests/passkeys.test.mjs` uses real P256-signed assertions and CBOR none-attestation fixtures. HTTP integration tests exercise the actual server with isolated credentials and temporary databases. Synthetic test credentials are never enrolled on production.
- `bin/verify-owner-auth.mjs` checks the public deployment, including rejection of password-only and fake-passkey attempts. It performs no passkey registration and prints no credentials. `data/verification/owner-auth-*.json` records live results.

Library integration and synthetic signatures do not establish that a physical iPhone/Windows authenticator has been enrolled. That status is complete only after the owner approves the ceremony and Nimbus records the credential and a successful subsequent password-plus-passkey sign-in.

References: [SimpleWebAuthn server verification](https://simplewebauthn.dev/docs/packages/server), [Web Authentication specification](https://www.w3.org/TR/webauthn-3/).

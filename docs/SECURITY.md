# Nimbus access security

The public deployment requires **Jessomadic, the existing password and a passkey**, followed by a valid server-issued session for worker state, chats, tasks, files, browsers, terminals, tools, settings, updates and activity streams. First physical passkey enrollment is an owner action; see [setup and recovery](PASSKEYS.md). The login page, minimal `{ "ok": true }` health response and public branding/offline assets are intentionally public. The tunnel stays on HTTP `127.0.0.1:8787`; browsers connect through `https://nimbus.jessecopas.com`.

## Authentication and sessions

- Password guesses reserve a durable limit **before** awaiting the request body: eight attempts per client IP per 15 minutes, an identity limit, and a global 60-per-minute ceiling. A correct password resets only password counters. Passkey/MFA verification has separate eight-attempt client limits; MFA also retains its account and ticket limits. These verification counters reset only after full sign-in. Options retrieval and native prompt cancellation do not count as password guesses or verification failures; authentication request traffic still has a 60-per-minute client/global ceiling. Limit responses include `Retry-After`.
- Remote sessions use a random 256-bit `__Host-nimbus_session` cookie with `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`, a 24-hour absolute lifetime and an eight-hour idle lifetime. Local HTTP uses a separate `nimbus_session` cookie. The database retains SHA-256 token digests rather than bearer tokens.
- Sessions are HMAC-bound to current username/password/account credentials and second-factor version. The authentication key uses Windows CurrentUser DPAPI. Password/account/MFA/passkey changes invalidate affected sessions; password/environment changes take effect when the process reloads configuration. The dashboard password is unchanged. Moving from password-only to named-owner mode also revokes old sessions.
- Logout revokes its session immediately, closes its open event streams and requests browser cache clearance. Streams also check authorization before broadcasts and every ten seconds; passive streams do not extend idle expiry. Authenticated responses and files use `Cache-Control: no-store`. Public offline caching excludes private data and commands. Previously downloaded copies cannot be revoked from a device.
- Named-owner mode requires a passkey after username/password, with no legacy shared-password or TOTP bypass. First enrollment starts directly after correct username/password only for a never-enrolled owner; device approval and verified registration are required before access. The durable credential version closes this enrollment path after the first key. Recovery later requires a protected local administrator link. The local one-use browser sign-in shortcut is unavailable in this mode. Separate legacy email-account mode also disables shared-password fallback and requires local provisioning.
- Passkey tickets are short-lived, browser-bound, credential-bound and single-use; required user verification and cryptographic challenge/origin/RP checks fail closed. Adding/removing keys requires fresh complete authentication and the current password. The last key cannot be removed. Legacy email-account authenticator tickets remain short-lived and credential-bound; their enrollment/enable/disable checks prevent revoked-session resurrection.

## HTTP boundary

Forwarded non-HTTPS requests are refused. Proxy protocol and client IP information are trusted only over loopback. Requests carrying forwarding headers cannot use `data/admin.token` or redeem localhost sign-in tickets. Cross-origin writes are rejected; no cross-origin API access is enabled.

Responses include framing denial, MIME sniffing denial, a restrictive Content Security Policy, and HTTPS HSTS. Login/passkey scripts and QR generation are served locally rather than from script CDNs; inline scripts would require a per-response nonce. Untrusted HTML/SVG uploads download as attachments with a sandboxed policy and cannot execute as app pages. Login JSON is bounded to 16 KB; request/header timeouts bound incomplete requests. Cloudflare must continue to forward to loopback and must not cache authenticated responses.

## Windows trust and backup

`Secure-Nimbus.ps1` restricts this physical checkout to its Windows owner, SYSTEM and local Administrators. It checks descendants, repairs inherited/explicit broad access, saves prior descriptors under `data/verification/windows-acl-*.json`, and refuses to traverse filesystem links. `Setup-Nimbus.ps1` and `Start-Nimbus.ps1` run this step. Newly created files inherit protected permissions. Link targets or data configured outside the checkout require their own permission review.

The Windows owner and administrators remain trusted: they control the process, source, local administration token and DPAPI account. A compromised owner/admin account is outside the web password boundary. Run Nimbus under its intended Windows account; CurrentUser DPAPI credentials are not portable to another account without the encrypted backup/restore process. The per-host authentication key and local administrator token are excluded from portable backups, and restores discard sessions.

Before the Server 2025 migration, reapply permissions, restore under the intended service account, validate tunnel forwarding, and repeat the live authentication checks. Hyper-V is not required for this boundary.

## Verification

Run `npm test` for isolated unit/integration regressions. `tests/security-auth.test.mjs` covers session storage, expiry, credential binding, durable limits and stream invalidation. `tests/security-http.test.mjs` exercises the real server with synthetic credentials and separate temporary databases, including concurrent login bodies, remote admin rejection and MFA mutation races.

`bin/verify-security.mjs` records the older shared-password deployment checks. The named-owner deployment uses `node --no-warnings --env-file-if-exists=.env bin/verify-owner-auth.mjs` to check required factors, protected APIs, fake-passkey rejection and migration session revocation without enrolling a device. Public DNS resolution retains normal hostname/certificate validation; neither script submits worker tasks or prints passwords. Physical passkey creation and a subsequent real-device sign-in remain owner actions.

These checks establish the tested boundaries; they are not a guarantee against every future vulnerability. Keep dependencies and Windows updated and keep the dashboard password private.

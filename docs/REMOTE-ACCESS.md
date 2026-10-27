# Nimbus on iPhone and outside the home network

Open **https://nimbus.jessecopas.com** in Safari and sign in with **Jessomadic, the existing Nimbus password, then a passkey**. Complete [first passkey enrollment](PASSKEYS.md) on your device before normal sign-in. The same URL works through the user's Cloudflare Tunnel from home or cellular/another network once that network's DNS resolver has the published hostname.

For an app-style Home Screen icon, use Safari **Share → Add to Home Screen → Open as Web App → Add**. See [Apple's current instructions](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios). Home-screen installation happens on the user's iPhone; it has not been performed remotely from this PC.

## Tunnel and origin

- Public hostname: `nimbus.jessecopas.com` over HTTPS.
- Cloudflare Tunnel service: **HTTP → `127.0.0.1:8787`**.
- Nimbus remains bound to loopback. No router port forwarding or public Nimbus listener is needed.
- Cloudflare/cloudflared installation, credentials and service setup are managed by the user. The revoked token supplied during setup was not used by this implementation and is not included in source/configuration.
- The Nimbus PC, Nimbus process and cloudflared connector must be running. The Windows supervisor keeps Nimbus running; optional sign-in startup remains a separate setup step. Windows Server 2025 unattended operation still requires destination validation.

## Mobile behavior

The responsive web app exposes worker chats, instruction entry, task steps/results, approvals, artifacts and the team overview. The GitHub coordinator and its specialists are nested in the menu. A live connection indicator shows connected/reconnecting/offline state. Returning to the app or regaining connectivity reconnects the event stream and reloads current state.

The installable manifest includes PNG icons and an Apple touch icon rendered from Nimbus's existing SVG brand. The service worker caches only public icons and an offline notice. It never caches authenticated pages, API state, uploads, instructions or connector responses, and it never queues commands for background execution. Offline instruction submission keeps the draft and asks the user to reconnect. A retry after an uncertain response reuses the request ID; the server returns the original message/task rather than executing a duplicate.

This version verifies live activity while the app is open. It does not claim to provide background iOS push delivery while the app is closed.

## Authentication and proxy boundaries

The tunnel does not disable Nimbus login. Remote sessions use a host-only Secure, HttpOnly, SameSite=Lax cookie and expire after 24 hours or eight idle hours. Password changes revoke affected sessions after configuration reload; logout also closes the associated activity streams. Proxy HTTPS/client-IP headers are trusted only from the loopback connector. Forwarded requests cannot use the local administrator token or one-time local sign-in route. Cross-origin writes are rejected. Authenticated responses and files use `Cache-Control: no-store`; do not configure a Cloudflare rule that caches them. Public offline caching includes only branding, the offline notice and its reconnect helper. See [security details](SECURITY.md) for rate limits, account/MFA protections and Windows permissions.

## Verified results and DNS boundary

**User-confirmed device result:** the iPhone opens `https://nimbus.jessecopas.com` on both home Wi-Fi and cellular. Both requested access paths are confirmed. Home Screen installation remains an optional device action and has not been reported complete.

The public Cloudflare HTTPS route returned Nimbus health and login successfully. Anonymous API requests were rejected. A real remote login obtained a secure session, streamed activity, loaded the twenty-worker roster and submitted an instruction that completed on OpenAI. Sending the same request ID twice produced one task. Cross-origin writes and remote local-admin requests were rejected. The manifest, offline page, service worker and icons were served successfully. The interface was also checked at 390 × 844 pixels; this is a responsive browser check, not a physical iOS device test.

At verification, public Cloudflare DNS returned the new A records while this PC's home resolver (`192.168.1.1`) returned NXDOMAIN. Clearing the PC's DNS cache did not change that result. A negative cache or local DNS override/filter may explain the disagreement; the exact resolver cause has not been established. If a device fails only on home Wi-Fi, check that resolver's cache/overrides; cellular/another resolver can distinguish that condition from a tunnel failure. Verification used public DNS resolution with the real hostname and normal TLS certificate checking; certificate validation was not bypassed.

Evidence: `data/verification/remote-1793067928500.json` and `data/verification/mobile-github-team.png`.

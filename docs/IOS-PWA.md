# iOS PWA frontend — final repair candidate

Evidence date: 2026-10-27 (America/New_York).
Branch: `frontend/ios-pwa-2026-10-27`.
Inspected base HEAD: `1f6df966f953d7faec0586abd3acaebc85e3904f`.

This source-only receipt supersedes the failed-fixture partial checkpoint.
It describes a passing Chromium candidate, **not deployment or physical iOS
acceptance**. Candidate changes remain uncommitted at this documentation
handoff. This addendum performs no commit, push, merge or deployment.

## Implementation

Preserves Nimbus dark/light tokens, Inter/JetBrains typography, icons,
manifest identity and existing authentication/passkey logic. Adds
`public/mobile.css` and `public/mobile-shell.js`, wired through app/login
pages and the PWA module. VisualViewport height/offset handling does not
disable pinch zoom; mobile inputs use 16px text. Safe-area padding covers
the header, composer, drawer/footer, activity, sign-in and offline notice;
the public offline dependency list includes the module.

Drawer behavior includes backdrop/Escape dismissal, focus containment and
restoration, expanded/controls semantics and inert hidden/background areas.
Final repair reserves the <=360px header title row and wraps actions.
CSS and JavaScript share the mobile query: <=760px, or landscape <=960px
wide and <=500px high. Thus 844x390 uses Menu and a full-width conversation;
1280x800 retains desktop navigation. Modal scrim CSS uses VisualViewport
geometry, but native keyboard/modal behavior remains unaccepted.

## Retained final evidence — not rerun for this addendum

Command, from the candidate repository:

```powershell
node --test tests/ios-pwa.test.mjs tests/passkey-ui.test.mjs tests/sidebar-layout.test.mjs
```

Final collected repair session `57f0b9c0-a8b6-4348-914e-ddd943e95829`
exited 0: **17 passed, 0 failed, 0 skipped, 0 cancelled**. The saved TAP
summary was re-read for this addendum. Successful repaired-fixture runs
supersede the earlier undefined.length / #msg failure; assertions were
not relaxed. A passing pre-edit run is not final-repair evidence.

The isolated Chromium test intercepts network requests with public source
files and synthetic API fixtures, not live Nimbus data. Service workers are
blocked, so it does not verify offline caching/reconnect.

Source assertions cover 320x568, 390x844, 844x390 and 1280x800:
document overflow, composer containment, mobile input sizing, narrow title
non-truncation, mobile Menu/full-width conversation, drawer/background inert
state, Escape/focus restoration and backdrop dismissal, and desktop sidebar
position. A synthetic 400px VisualViewport signal checks app/composer geometry;
login checks cover input size and overflow, not a real sign-in ceremony.

Four settled final-repair screenshots were produced outside the repository.
The retained receipt records actual final pixel review at **844x390 and
1280x800**: landscape Menu/full-width conversation and desktop sidebar,
contained composer and preserved dark identity. Final-repair 320x568 and
390x844 pixel review remains incomplete despite passing geometry assertions.
Earlier four-image visual review predates the final header/landscape repair
and is not review of those final pixels.

No private screenshots, logs or local artifact paths are embedded here.
Optional screenshot output uses `NIMBUS_PWA_ARTIFACTS` pointed outside the
repository.

## Remaining acceptance gaps

- Complete final-repair pixel review at 320x568 and 390x844.
- Owned-browser interactive journey, drawer Tab cycling/selection close,
  resize/activity-panel interactions and modal keyboard geometry.
- Offline reconnect/dependency-cache behavior (excluded from the fixture).
- Login reachability in short landscape.
- WebKit/Safari/standalone execution. WebKit executable was absent at prior
  canonical verification; not installed or rechecked by this addendum.
- Physical iPhone Home Screen installation, notch/home indicator, native
  software keyboard, pinch zoom, rotation, touch behavior and device passkeys.

These gaps prevent full iOS or production-readiness acceptance. Chromium
viewport simulation and passing passkey source tests do not certify device
behavior. No backend, production configuration or live-data changes are
part of this documentation update.

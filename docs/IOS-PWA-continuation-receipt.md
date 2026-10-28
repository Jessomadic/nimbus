# iOS continuation receipt — 2026-10-27

## Narrow final repair (2026-10-27 America/New_York)

Changed only public/styles.css, public/mobile.css, public/mobile-shell.js, tests/ios-pwa.test.mjs and this receipt. No git commands, staging, root/backend edits or deployment. Worktree HEAD metadata read directly confirms frontend/ios-pwa-2026-10-27.

At <=360px the title now reserves the first row beside Menu and actions wrap below, preserving identity rather than O... . Mobile CSS and drawer JS share the same query: <=760px, or landscape <=960px wide and <=500px high. Thus 844x390 has a full-width conversation and a Menu-controlled drawer with inert background/Escape/backdrop/focus behavior, while 1280x800 retains desktop navigation. Existing colors/type/branding are unchanged.

Final collected process 57f0b9c0-a8b6-4348-914e-ddd943e95829 exited 0: 17 tests passed, 0 failed, 0 skipped. Command: node --test tests/ios-pwa.test.mjs tests/passkey-ui.test.mjs tests/sidebar-layout.test.mjs (NIMBUS_PWA_ARTIFACTS set outside worktree). New assertions require the 320px fixture title not to truncate and mobile Menu/full conversation width at 844x390; drawer checks now run there too. No assertions relaxed. A preceding 17/17 run was pre-edit and is not final repair evidence. Initial patch preparation was rejected before writing; corrected exact-context patches succeeded.

Final log: F:\Nimbus\data\bots\11\artifacts\ios-pwa-final-repair-verification-2.log. Four settled screenshots: F:\Nimbus\data\bots\11\artifacts\ios-pwa-final-repair\{320x568,390x844,844x390,1280x800}.png. These private artifacts remain outside the worktree; nothing staged. Actual final pixels inspected at 844x390 and 1280x800: landscape Menu/full-width conversation and desktop sidebar respectively, contained composer and preserved dark identity. The 320 image returned raw data without rendering in that first tool call; do not claim its pixel inspection or final 390 pixel inspection. Both viewport geometry checks passed. Tool action budget prevented completing all four pixel reviews.

Limitations retained: WebKit executable absent at prior canonical verification (not installed/rechecked here); physical iOS, Safari/standalone install, native keyboard/notch/rotation/passkey, modal keyboard geometry and offline reconnect remain unverified. This is a passing Chromium repair, not full iOS acceptance. No pending test process.

## Prior canonical receipt (preserved)

Candidate: F:\Nimbus\data\bots\15\ios-pwa, branch frontend/ios-pwa-2026-10-27. No commit/push/deploy, root or backend edits.

Canonical checkpoint said no pending child processes. The saved fixture already contains plugins:[] and stack diagnostics. Its prior undefined.length/#msg failure did NOT reproduce: first collected run 24bae256-65f6-4384-9173-7226a1df0134 exit 0, 17/17. No assertions removed or relaxed.

Narrow changes this continuation: public/mobile.css aligns modal scrim to VisualViewport height/offset; under 360px allows header wrapping rather than crowding the title. tests/ios-pwa.test.mjs waits finite animations before screenshots and asserts desktop sidebar x>=0. Initial screenshots were taken during sidebar transition, showing clipped content; this was capture timing, not demonstrated steady-state clipping.

Final command (PowerShell, cwd candidate):
$env:NIMBUS_PWA_ARTIFACTS="F:\Nimbus\data\bots\11\artifacts\ios-pwa"; node --test tests/ios-pwa.test.mjs tests/passkey-ui.test.mjs tests/sidebar-layout.test.mjs
Final collected session b3d7d6c4-4259-4cb7-b6b4-3d569ce854c2 exit 0: 17 tests passed, 0 failed. Log: F:\Nimbus\data\bots\11\artifacts\ios-pwa\verification.log.

Rendered Chromium fixture checks 320x568,390x844,844x390,1280x800: no document overflow; composer within viewport; mobile 16px inputs; drawer inert background/closed drawer, Escape and focus restoration, backdrop; desktop sidebar not inert/not negatively positioned; synthetic VisualViewport400px composer; login input size. Screenshots at artifact directory named WIDTHxHEIGHT.png.

Visual evidence: actual initial screenshot pixels inspected at320x568,844x390,1280x800. Nimbus dark branding retained; 320 header title very abbreviated, motivating wrap; initial wide sidebar screenshots clipped during transition, motivating settled captures/assertion. Final image tool returned data but images were rejected as could-not-be-processed by image channel: do NOT claim final visual acceptance.

NOT ACCEPTED as finished iOS app: no owned browser-group interactive fixture journey (file URL navigation explicitly rejected, no HTTP fixture launched), no WebKit/mobile Safari or standalone-mode execution, no physical iPhone keyboard/notch/rotation/install/passkey testing. Synthetic Chromium viewport is not device QA. Drawer Tab cycling/selection close, modal keyboard geometry and offline reconnect still lack behavioral acceptance. Need final screenshot pixel review on compatible image route. This is a passing Chromium candidate with explicit remaining acceptance, not ready to merge based solely on17 tests. No pending process remains.

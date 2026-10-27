# Windows verification record

Live records below were collected on the current Windows PC on October 26, 2026 (receipts use UTC October 27). Windows Server 2025 has not been exercised.

## Publication checks — October 27, 2026

Before publishing the changes from base commit `c373399`, a fresh `npm test` run passed **321/321 tests**, with zero failures, cancellations or skips. This run includes authentication/passkeys, real HTTP fixtures, orchestration, display-group isolation, tool development, provider safety, tool budgets, specialist tools and source maintenance. The local test log is retained at `.dev/commit-preflight-tests.txt`, outside Git.

A concurrent health-probe repair was subsequently included as its own follow-up fix: expected network failures and probe-owned timeouts produce completed read-only observations; caller cancellation and uncertain mutations retain their existing review boundary. Its 12 new regressions and seven operations checks passed, followed by a fresh full-suite run of **333/333 tests**, with zero failures, cancellations or skips. The final full-suite log is `.dev/commit-final-tests.txt`; the focused log is `.dev/publication-health-probe-tests.txt`. These local evidence logs remain outside Git.

All **110 changed JavaScript files** passed syntax checks, and all **7 PowerShell scripts/modules** passed parsing after replacing a smart apostrophe that broke the optional sign-in task installer. All **26 local Markdown links** resolved. The current registry was inspected using isolated state: **67 native tools**, including **48 specialist tools**, and **21 role profiles**. These counts describe registration, not full Codex parity or connected external accounts.

The live model, public-network and deployment records below are historical evidence. Those live workflows were not rerun for commit publication; their recorded limitations still apply. Test counts in the individual records describe their respective checkpoints.

## Results

### Public access security hardening

The hardened server was deployed through the existing Windows supervisor without interrupting active work (none was running). The existing dashboard password was retained; old 90-day sessions were revoked once. The complete suite passed **130/130 tests**, including **19 session/rate-limit/stream tests** and **9 isolated real-HTTP security tests**. The HTTP fixtures exercised concurrent delayed-body guesses, shared/account-mode separation, forwarded admin rejection, safe upload downloads, credential revocation and MFA mutation races. `npm audit` reported zero known vulnerabilities, including development dependencies.

Public HTTPS verification passed **11/11 checks** with normal certificate validation: minimal public health; nonce-based CSP and response headers; anonymous data/execution denial; blocked commands/signup; forged and pre-deployment session rejection; remote local-ticket refusal; wrong-password rejection; correct existing-password login with a hashed stored token and protected cookie; authenticated app assets/state; admin/cross-origin rejection; and logout closing an already-open public event stream and rejecting cookie replay. No worker/model inference or external account mutations were performed for these checks.

Windows ACLs were restricted and verified across the physical checkout, including source, config, database and administrator/authentication secrets. Only the checkout owner, SYSTEM and local Administrators receive access. A second browser check confirmed the password form works, the authenticated dashboard reaches **Live · connected**, and its Log out control returns to the password form under the restrictive CSP. This browser check used the existing trusted local one-use administrator link; the public check independently used the real dashboard password.

Evidence:

- `data/verification/security-automated-tests.txt`
- `data/verification/security-hardening-live.json`
- `data/verification/windows-acl-1793070669116.json` (prior descriptors and verified coverage)
- `data/verification/security-login.png`
- `data/backups/nimbus-2026-10-27T03-12-22-886Z.nbak` (pre-deployment encrypted state backup)

These results cover the tested web/password boundary. The Windows owner and administrators remain trusted host operators. Login/branding/health remain public, downloaded copies cannot be revoked, and MFA has not been enabled for the current shared-password deployment. See [security details](SECURITY.md).

### Resource fallback, GitHub hierarchy and public mobile access follow-up

The current suite passes **28/28 automated tests**. The resource fallback live check passed **2/2** cases: a blocked local router resumed its retained task on OpenAI, and an explicit local execution route that failed VRAM admission completed real file tools through OpenAI. The 90% ceiling was retained; the worker settings were restored after verification.

Six GitHub roles were added, producing twenty workers total, with five specialists linked to the GitHub coordinator. A real parent/child task completed read-only Git inspection and returned its verified result. A separate `get_me` call completed through the GitHub connector and identified Jessomadic. No repository or remote GitHub mutations were made in these checks. An initial test exposed Codex's reserved `mcp__` prefix; the adapter was repaired to use stable aliases and the native registration, delegation and connector execution then passed.

Public Cloudflare access passed **5/5 live checks**: HTTPS/auth boundary; secure login/team state; streaming and request isolation; installable app assets; and an instruction completing once despite a duplicate submission. Mobile navigation and the nested GitHub family were inspected at 390 × 844. The user subsequently confirmed that the actual iPhone opens the app on **both Wi-Fi and cellular**. Home Screen installation has not been confirmed. The PC-specific DNS disagreement observed earlier does not block the confirmed iPhone access.

Evidence:

- `data/verification/vram-fallback-1793066816055.json`
- `data/verification/team-upgrade-1793067820569.json`
- `data/verification/github-team-1793068027134.json`
- Nimbus run #9 and its completed `mcp__github__get_me` journal entry
- `data/verification/remote-1793067928500.json`
- `data/verification/automated-tests.txt`
- `data/verification/mobile-github-team.png`

### Specialist prompts and Codex session isolation follow-up

The current automated suite passes **20/20 tests**. Fourteen role profiles are installed with versioned shared instructions, specialist workflows and editable model preferences. A second upgrade run added zero duplicate workers. The original three worker IDs and histories remain intact.

A real explicitly selected Luna task completed using the new standing instructions and host file tools. Native Codex confirmed ephemeral mode with no saved history path; after disconnect the session was unavailable, and the app's normal task list contained zero Nimbus internal test threads. Twelve positively identified older persistent test threads were archived through the app rather than deleted. Nimbus retains the canonical history needed for recovery.

The fresh local routing/artifact check **paused at resource admission**: measured GPU memory was 11,990 MB of 16,303 MB and the configured projected model load would exceed the 90% ceiling. No other GPU workloads were stopped and the guard was not bypassed. This follow-up therefore records two passed live checks and one resource-blocked local check, not a fully passing local smoke run. Earlier local execution receipts below predate this prompt upgrade.

Follow-up evidence:

- `data/verification/team-upgrade-1793064790547.json`
- `data/verification/team-upgrade-1793064883057.json` (repeat upgrade, zero additions)
- `data/verification/team-check-1793064857020.json`
- `data/verification/codex-session-isolation.json`
- `data/verification/specialist-settings.png`

### Original port acceptance

- **17/17 automated tests:** native Windows model-list parsing; serialized local capacity; resource admission configuration; valid JSON redaction; model-authored routing; quota-unavailable routing; explicit overrides; common tool forwarding; actual file operations; journal replay prevention; approval rules; restart checkpoints; receipt reconciliation; actual host-process cancellation; encrypted backup/restore and tamper rejection; real browser context/tab/cookie ownership and group limits.
- **9/9 live acceptance checks:** two local workers sharing one inference slot; OpenAI subscription file tools; local routing; cloud browser click/snapshot; cloud-to-local worker handoff; request idempotency; hardware sampling; encrypted archive creation.
- **4/4 additional live checks:** Terra, Sol and Astra each wrote and read an actual file through subscription inference. A Luna host command was cancelled after its marker appeared; its uncertain outcome was retained and an unreviewed resume was rejected.
- **2/2 process recovery checks:** a real Nimbus process stopped while local inference was active. A new process resumed its checkpoint and completed the retained queued task.
- A real live backup was restored into a separate empty folder, and its reprotected local credential was decrypted and compared successfully. The recovery key and credential values were not printed.
- The supervised normal instance at `http://127.0.0.1:8787` completed a fresh automatic route, wrote `data/bots/2/startup-receipt.txt`, and read back `NIMBUS_WINDOWS_READY`. Its supervisor also restarted the server successfully.
- JavaScript syntax checks passed; `npm audit --omit=dev` reported zero vulnerabilities at verification time.

## Observed model access

| Family | Successful exact model |
| --- | --- |
| Local | `nimbus-local` backed by the configured Gemma shared pool |
| Luna | `gpt-5.6-luna` |
| Terra | `gpt-5.6-terra` |
| Sol | `gpt-5.6-sol` |
| Astra | `gpt-6-astra` |

The account rejected `gpt-6-luna`. Family mappings therefore resolve against the native account catalogue, with the successful exact model recorded per task. Model access can change; catalogue visibility alone is not execution proof.

During the nine live checks, peak sampled RAM was approximately **38.79%**, and peak sampled VRAM approximately **32.95%**, below the configured 90% ceiling. These are observations from that run, not guaranteed future usage.

## Evidence locations

Development evidence was moved intact from `data/` to the ignored `.dev/` folder after all development servers stopped. Paths embedded inside older receipts describe their locations at execution time.

- `.dev/dev-check/verification/live-2026-10-27T00-08-18-852Z.json`
- `.dev/dev-check/verification/models-1793060014075.json`
- `.dev/dev-check/verification/portable-restore.json`
- `.dev/restart-check/verification/restart-1793060133615.json`
- `.dev/restore-check/` contains the independent restored snapshot.
- `.dev/dev-check/` retains earlier failed receipts and logs, including the Windows empty-array parsing failure that was repaired and regression-tested.

## Remaining deployment boundaries

Lumos/Hermes/OpenBubbles integration remains disconnected. Third-party MCP connectors require their own configuration and credentials; no claim is made that those external accounts were connected or tested. Optional local speech tools require separate Windows executables/models. Browser groups isolate browser sessions; Nimbus shell/file tools remain host tools. The optional sign-in startup script is supplied but has not been registered. Unattended Windows Server operation needs its own account, driver, startup and restore checks.

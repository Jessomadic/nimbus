# Nimbus capability coverage

The target is the full practical Codex feature set. **Nimbus does not yet have full Codex parity.** Query `/api/capabilities` or use the `capabilities` worker tool for an explicit implementation inventory. An implementation entry is not proof of a successful live model turn or a connected account.

## Implemented foundations

The [specialist tool directory](TOOLS.md) describes 48 specialist tools within the 67-tool native registry and assignments for every built-in role. This includes real code/Git inspection and test execution, research capture/source registers/citation audits, dataset validation/query/export, document checks/report composition, browser table/responsive audits, Windows diagnostics, task history and worker-owned schedule management. Context7 library resolution/documentation tools can be integrated through the existing MCP transport.

Workers can use host files and shell commands, make exact-context patches, run and poll piped terminal sessions, retain task plans, ask questions through dashboard answer forms, inspect actual local image/browser screenshot pixels, discover Nimbus skills, use browser groups, retain private/shared memory, and hand work to registered workers. Model and tool policy, checkpoints and uncertain-action receipts remain owned by Nimbus across local/cloud fallback.

`view_image` and browser screenshots deliver pixels through the cloud dynamic-tool protocol. Retained image references include a content hash and are attached again when reconstructing inference context. The selected local endpoint must accept image input; a text-only model is not a vision implementation.

`skills` discovers `SKILL.md` under immediate child folders of `skills/` and `data/skills/`. It returns real paths; workers read the instructions and supporting files through host tools. Codex plugins, skills and account connections are not automatically imported.

## Self-updates

For a user-authorized Nimbus code change:

1. Use `self_update` with `action: status` to discover the source root and supervisor state.
2. Use `action: snapshot` **before editing**, and keep `snapshotId`.
3. Read and edit the source using file/patch/terminal tools. Existing dirty work is part of the snapshot, not reset to Git HEAD.
4. Use `action: validate` with that ID. JavaScript syntax and the full Node test suite must pass against an unchanged source hash.
5. Use `action: apply`. Nimbus waits for current/queued tasks, including the requesting task, and terminal sessions to finish, then exits through its Windows supervisor. Stop an intentionally persistent terminal session explicitly before applying an update.
6. Return from the requesting task promptly. `restart_pending` is not completion. After reconnecting, inspect `status` with the ID: `applied` records the new process and validated boot hash.

Local administration uses the same workflow:

```powershell
node --env-file-if-exists=.env bin/update.mjs status
node --env-file-if-exists=.env bin/update.mjs snapshot
node --env-file-if-exists=.env bin/update.mjs validate SNAPSHOT_ID
node --env-file-if-exists=.env bin/update.mjs apply SNAPSHOT_ID
node --env-file-if-exists=.env bin/update.mjs status SNAPSHOT_ID
```

Source snapshots cover the root JavaScript/PowerShell/package files and `runtime`, `scripts`, `bin`, `public`, `tests`, `docs`, and `skills`. They exclude runtime data, secrets, active config, Git metadata, installed dependencies and Android build state. A source update that changes dependencies, database schemas, active configuration or the Android application needs separate compatible deployment/recovery. It is not an atomic packaged-release installer and does not promise automatic rollback after a crash.

For offline source recovery, first stop Nimbus with `Stop-Nimbus.ps1`, then run `node bin/update.mjs restore SNAPSHOT_ID`. Recovery refuses source drift, verifies baseline hashes, preserves the failed candidate in another source snapshot and restores only the candidate's source files. Runtime data/credentials/database are retained. Verify database compatibility and restart with `Start-Nimbus.ps1`.

Each new snapshot also records `recoveryScript`: a frozen standalone runner under `data/updates/SNAPSHOT_ID/recovery/restore.mjs`. Run it directly with Node when the candidate has broken the normal update CLI, maintenance module or root package file. It requires Nimbus to be stopped and does not import the candidate's application modules.

## Remaining parity work

| Area | Boundary |
| --- | --- |
| Windows desktop/app control | Browser automation exists; arbitrary Windows app control needs a desktop backend and adapter. |
| Web research | Browser navigation and separately configured search MCP exist; hosted search/citation behavior is not bundled. |
| Managed projects/Git review | Git through terminal and GitHub MCP exist; managed worktree lifecycle, diff panel and PR attachment integration remain. |
| Conversation orchestration | Persistent workers, bounded handoffs, owned task history and cron worker tools exist; arbitrary fork/steer APIs, automatic context compaction and complete heartbeat/notification behavior remain. |
| Documents and spreadsheets | Structured CSV/TSV/JSON analysis/export, text checks and report tools exist; binary office extraction, native document sessions, live spreadsheets and cloud canvas adapters remain. |
| Skills/plugins | Local instruction discovery exists; automatic skill matching and complete plugin packaging/marketplace lifecycle remain. |
| Media | Vision input exists; image/video/audio generation and editing require a supported provider and integration. |
| External accounts | MCP transport exists; every service needs independently configured Nimbus access. |
| Codex/ChatGPT services | Sidebar/task management, Spaces/Sites, hosted artifact sessions, account resets and other private platform services need public integrations or Nimbus equivalents. The CLI does not supply them. |

The Codex app-server is an integration harness, not a bundle of all Codex desktop and ChatGPT services. See the [official OpenAI explanation](https://developers.openai.com/blog/codex-as-a-platform). Model access alone does not implement these product features.

# Nimbus specialist tool directory

Nimbus includes 48 specialist tools within its 67-tool native registry. Every built-in role receives domain tools plus `tool_catalog`; existing custom workers receive the catalogue without guessing a specialist role. Workers see only enabled native tools and their configured MCP connectors.

## Agent coverage

| Agent | New domain tools |
| --- | --- |
| Orchestrator | `team_status` |
| Researcher | `research_search`, `scholar_search`, `research_fetch`, `source_register`, `evidence_audit`, `check_links`, `citation_format`, `document_compare` |
| Builder | `code_search`, `project_map`, `run_checks`, `dependency_graph`, `text_statistics` |
| Reviewer | `git_diff`, `change_impact`, `security_scan`, `code_search` |
| Architect | `project_map`, `dependency_graph`, `change_impact` |
| QA Engineer | `test_discover`, `run_checks`, `change_impact`, `health_probe`, `log_read` |
| Security Reviewer | `security_scan`, `dependency_graph`, `git_diff`, `connector_inventory`, `file_manifest` |
| Windows Operator | `host_snapshot`, `process_inspect`, `service_inspect`, `health_probe`, `log_read`, `file_manifest` |
| Automation Engineer | `automation_schedule`, `health_probe`, `log_read`, `task_history`, `connector_inventory` |
| Data Analyst | `dataset_profile`, `dataset_query`, `dataset_validate`, `dataset_compare`, `table_export` |
| Technical Writer | `research_fetch`, `source_register`, `citation_format`, `check_links`, `document_compare`, `document_structure`, `document_check`, `report_compose`, `table_export` |
| Frontend Designer | `browser_inspect`, `responsive_audit`, `browser_table` |
| Browser Operator | `browser_inspect`, `browser_table`, `responsive_audit` |
| Knowledge Curator | `knowledge_search`, `source_register`, `evidence_audit`, `document_compare`, `citation_format`, `research_fetch`, `check_links`, `file_manifest`, `artifact_inventory` |
| Office Assistant | `office_checklist`, `report_compose`, `table_export`, `document_check`, `automation_schedule`, `artifact_inventory`, `task_history` |
| GitHub | `git_inspect`, `github_pr_inspect`, `github_actions_inspect`, `connector_inventory`, `task_history` |
| GitHub Sync | `git_sync_plan`, `git_inspect` |
| GitHub Commits | `git_commit_plan`, `git_diff` |
| GitHub Push | `git_push_preflight`, `git_inspect` |
| GitHub Pull Requests | `github_pr_inspect`, `git_diff` |
| GitHub Actions | `github_actions_inspect`, `test_discover`, `run_checks` |

## Installed integrations

Context7 can be attached with `node bin/upgrade-capabilities.mjs --apply --context7`. This preserves existing connector assignments and adds library resolution and documentation lookup. Both remote tools were exercised through the actual Nimbus MCP transport; transport discovery alone is not an execution test. See the [Context7 tool contract](https://context7.com/docs/resources/all-clients). Access/rate limits depend on the service.

Research can search any configured supported read-only search MCP connector, while `scholar_search` uses the public [Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/). General web search is reported unavailable when no search connector exists. No search credentials are borrowed from another app. GitHub tools use the existing configured GitHub MCP or independently authenticated `gh` CLI.

## Using the tools

Start with `tool_catalog` and a query such as `dataset`, `source`, `git` or `schedule`; pass `details: true` for the exact input schema. The worker settings panel lists searchable tool descriptions and preserves enabled selections. `/api/capabilities` also returns tool and role coverage.

Every tool uses the common journal/checkpoint path. Read-only adapters report observed status and do not perform a proposed write. `run_checks` executes repository code and observes existing command approval rules, including npm lifecycle bodies; it is not a sandbox. Source registers use optimistic revisions, authored artifacts refuse unintended overwrites, inspections report bounds/truncation, and scans retain their stated limits.

Scheduling is limited to the calling worker. Preview the effective host timezone and dates. A newly created routine remains disabled until an explicit enable action passes the host approval policy. This tool never deletes schedules or sends messages.

## Engineering and Git

### `code_search`

Search source with ripgrep using literal text or a bounded regular expression. Returns exact paths, line numbers and redacted matching lines. Excludes dependencies, Git metadata, build/runtime state and known credential files; use include globs to narrow scope. No shell interpolation.

Inputs: `path`; `query` (required); `regex`; `caseSensitive`; `include`; `maxResults`.

### `project_map`

Map a real project directory with file sizes, source-language counts, package entrypoints/scripts and repository instruction paths. Bounded traversal skips symlinks, dependencies and build/runtime state; reports truncation and unreadable paths.

Inputs: `path`; `maxFiles`; `maxDepth`.

### `dependency_graph`

Build a bounded static local import graph for JavaScript/TypeScript/Python sources and read declared package dependencies. Reports resolved local edges, external imports and unresolved imports. Static parsing is approximate; dynamic runtime behavior and dependency vulnerability status are not inferred.

Inputs: `path`; `maxFiles`.

### `change_impact`

Trace reverse local import dependencies for proposed changed files. Returns direct/transitive dependents and nearby test candidates from the real project. This is a bounded static impact estimate, not proof of complete test coverage.

Inputs: `path`; `files` (required); `maxFiles`.

### `test_discover`

Discover test files and configured npm scripts, Python test configuration, and CI workflow files without running them. Reports exact executable test paths and runner hints, including whether inventory limits were reached.

Inputs: `path`; `maxFiles`.

### `run_checks`

Execute a structured repository check through Node test, a named existing npm script, or Python unittest discovery. This runs repository code and may have its side effects; use only within task authority. Returns the real command, exit code, output, timeout/failure evidence and duration. Does not install dependencies or invoke arbitrary shell strings.

Inputs: `path`; `runner` (required) — node_test, npm_script, python_unittest; `script`; `files`; `testDirectory`; `timeoutSeconds`.

### `security_scan`

Scan bounded text source for exposed-secret patterns and risky execution/TLS/configuration constructs. Findings contain rule, path and line, never matched secret values. Heuristic candidates require review; this is not a complete security audit or a vulnerability database lookup.

Inputs: `path`; `maxFiles`; `paths`.

### `git_inspect`

Read repository identity, branch/HEAD, upstream tracking, dirty paths, recent commits, worktrees and sanitized remote URLs. No fetch, checkout, staging, commit, push or file changes.

Inputs: `repoPath`; `limit`.

### `git_diff`

Inspect a bounded staged, working-tree or two-ref Git diff with file stats and whitespace-check results. External diff/textconv programs are disabled. Paths and refs are separate arguments; no repository state is changed.

Inputs: `repoPath`; `staged`; `base`; `head`; `paths`; `contextLines`; `maxCharacters`.

### `git_commit_plan`

Prepare an evidence-backed commit plan for explicitly selected paths. Separates requested changes from unrelated dirty work and currently staged paths, reports whitespace issues and candidate secret findings. It never stages or commits.

Inputs: `repoPath`; `paths` (required).

### `git_sync_plan`

Inspect local branch/upstream divergence and optional live remote tip before planning a sync. Does not fetch, pull, merge, rebase, reset or write refs. Local tracking evidence can be stale and is labeled separately from a live remote check.

Inputs: `repoPath`; `remote`; `branch`; `checkRemote`.

### `git_push_preflight`

Inspect an explicit remote and target branch before a separately authorized push. Reads the live remote tip, local HEAD, outgoing range and ancestry when objects are locally available. Never pushes; missing remote objects/protection evidence remain unresolved.

Inputs: `repoPath`; `remote` (required); `branch` (required).

### `github_pr_inspect`

Use independently authenticated GitHub CLI access to inspect one explicit pull request, exact head/base, merge readiness, reviews and check summary. Read-only. Missing CLI/auth/account access is returned as a setup dependency; no credentials are borrowed from another app.

Inputs: `repository` (required); `number` (required).

### `github_actions_inspect`

Use independently authenticated GitHub CLI access to inspect one explicit Actions run and its jobs. Optionally read bounded failed-job logs. Reports actual status/conclusion and commit; never dispatches, reruns or cancels a workflow.

Inputs: `repository` (required); `runId` (required); `failedLogs`; `maxLogCharacters`.

## Research and evidence

### `research_fetch`

Fetch an HTTP(S) source without cookies or credentials. Returns bounded source text, exact response/redirect provenance, captured-byte hash and links. HTML extraction removes scripts/styles and is not browser rendering. Optional saveAs preserves an evidence JSON file inside your workspace without overwriting.

Inputs: `url` (required); `maxBytes`; `maxChars`; `timeoutMs`; `saveAs`.

### `research_search`

Search through an actually advertised read-only web-search MCP connector. Discovers its query/limit schema and returns provider results marked discovery-only. If no suitable connector is available, reports the exact setup gap; never invents results. Use scholar_search for public scholarly metadata.

Inputs: `query` (required); `limit`; `connector`.

### `scholar_search`

Search Crossref public scholarly metadata by query, DOI or bibliographic terms. Returns titles, DOIs, authors and publication date precision. Metadata is discovery evidence, not full-text reading or proof of a claim. No API key required; outages/rate limits are reported.

Inputs: `query` (required); `limit`; `timeoutMs`.

### `source_register`

Maintain a versioned evidence/source register. read returns its revision; add records a new URL/file plus optional research_fetch evidence JSON; annotate appends review/dispute notes without deleting history. Existing registers require expectedRevision for mutations. Paths stay in the selected private/shared knowledge area.

Inputs: `action` (required) — read, add, annotate; `path`; `scope` — private, shared; `expectedRevision`; `source`; `sourceId`; `note`; `reviewStatus` — unreviewed, reviewed, disputed, superseded.

### `knowledge_search`

Search actual private/shared knowledge text with literal terms and line-numbered context. Traversal skips symlinks and Git/dependency directories, bounds files/bytes, and reports skipped/truncated evidence. It does not infer knowledge from filenames.

Inputs: `query` (required); `scope` — private, shared; `path`; `mode` — all, any, phrase; `limit`; `maxFiles`; `contextLines`.

### `evidence_audit`

Audit claim-to-source links against a source register and retained evidence hashes. Detect missing citations, unread/disputed sources, changed capture files, unsupported exact quotations and explicit claim conflicts. An evidence-linked result is provenance coverage, not an automatic semantic fact check.

Inputs: `registerPath`; `scope` — private, shared; `claims` (required); `saveAs`.

### `document_compare`

Compare two real UTF-8 text documents with hashes, line numbers and bounded change hunks. Uses line alignment for small files and an explicitly labelled changed-region comparison for large ones. No files are modified; optional saveAs retains a new comparison receipt.

Inputs: `before` (required); `after` (required); `ignoreWhitespace`; `maxChanges`; `saveAs`.

### `check_links`

Check up to 25 HTTP(S) links with response codes, redirect trails and error evidence. HEAD is attempted first, with a bounded GET fallback for servers that reject HEAD. Availability does not verify a quotation, fragment target, or factual claim.

Inputs: `urls` (required); `timeoutMs`.

### `citation_format`

Format registered source metadata into Markdown references, JSON or BibTeX without inventing authors/dates. Includes only supplied/observed metadata and review status. Optional saveAs writes a new artifact; existing artifacts are preserved.

Inputs: `registerPath`; `scope` — private, shared; `sourceIds` (required); `format` — markdown, json, bibtex; `saveAs`.

## Data, documents and browser inspection

### `dataset_profile`

Profile a local CSV/TSV/JSON/JSONL dataset: grain, columns, missing values, duplicates, observed types and bounded numeric summaries. CSV values stay strings unless types explicitly declares conversion. Malformed rows and invalid conversions are reported, not silently dropped. Maximum 8 MiB / 100,000 rows.

Inputs: `path` (required); `format` — csv, tsv, json, jsonl; `types`.

### `dataset_query`

Query a local dataset without executable code. Filter, select, group and aggregate declared numeric columns, sort and limit output. CSV numeric comparisons require types. Returns source hash, matched count and bounded rows.

Inputs: `path` (required); `format` — csv, tsv, json, jsonl; `types`; `limit`; `select`; `filters`; `groupBy`; `aggregates`; `sort`.

### `dataset_validate`

Validate required columns, nonempty cells, unique compound keys, declared types, allowed values and numeric bounds. Reports counts and row-numbered failures with capped samples; never edits the source.

Inputs: `path` (required); `format` — csv, tsv, json, jsonl; `types`; `requiredColumns`; `notNull`; `uniqueBy`; `rules`.

### `dataset_compare`

Compare two datasets by explicit compound keys and report added/removed/changed records and column drift. Duplicate or empty keys are rejected. CSV numeric equivalence requires the same explicit types. Source files are unchanged.

Inputs: `path` (required); `otherPath` (required); `format` — csv, tsv, json, jsonl; `otherFormat` — csv, tsv, json, jsonl; `types`; `keys` (required); `sampleLimit`.

### `table_export`

Create a real CSV/TSV/Markdown/HTML/JSON table artifact from structured rows. HTML is escaped. CSV/TSV spreadsheet formula prefixes are neutralized by default and the changed-cell count is reported. Writes within your workspace and refuses overwriting unless requested.

Inputs: `output` (required); `overwrite`; `rows` (required); `columns`; `format` (required) — csv, tsv, markdown, html, json; `title`; `neutralizeFormulas`.

### `document_structure`

Inspect a local UTF-8 Markdown/plain-text document: heading hierarchy and anchors, links, code fences, word/paragraph counts and estimated reading time. This does not extract binary PDF/DOCX files or claim visual layout inspection.

Inputs: `path` (required).

### `document_check`

Check Markdown/text document structure for skipped heading levels, duplicate anchors, broken relative file/heading links, unfinished markers, missing image alt text and very long paragraphs. External URLs are inventoried, not claimed verified.

Inputs: `path` (required); `maxParagraphWords`.

### `report_compose`

Compose a structured Markdown or self-contained HTML report with sections, bullets, tables and source links. HTML content is escaped and source links accept HTTP(S) only. Writes within your workspace; this does not publish or send the report.

Inputs: `output` (required); `overwrite`; `format` (required) — markdown, html; `title` (required); `sections` (required); `sources`.

### `office_checklist`

Maintain your private structured checklist: list, add, update or summarize items with stable IDs, status, priority and optional ISO due date. Changes are stored in artifacts/checklist.json in your own workspace; this does not schedule jobs or send messages.

Inputs: `action` (required) — list, add, update, summary; `id`; `title`; `notes`; `status` — pending, in_progress, done, cancelled; `priority` — low, normal, high; `dueDate`.

### `browser_inspect`

Inspect an owned browser tab for actual headings, links, form controls and basic accessibility warning evidence. Password/control values are omitted. These heuristics are not a full accessibility certification. Start with the browser tool to obtain your tabId.

Inputs: `tabId` (required); `limit`.

### `browser_table`

Extract an actual HTML table from your owned browser tab into structured rows and headers. tableIndex is zero-based. Cell spans are reported; merged cells are not guessed or silently expanded. Source page is unchanged.

Inputs: `tabId` (required); `tableIndex`; `limit`.

### `responsive_audit`

Measure an owned browser tab at explicit viewport widths, collect horizontal-overflow evidence and save real screenshots. Restores the original viewport. It does not claim you visually reviewed the resulting files; actual pixels of the last screenshot are returned.

Inputs: `tabId` (required); `widths` (required); `height`.

## Host, automation and discovery

### `tool_catalog`

Search tools actually enabled for this worker, including connected MCP tools. Return descriptions and optionally full input schemas. Tool presence does not prove account entitlement or a successful operation.

Inputs: `query`; `details`; `limit`.

### `connector_inventory`

Inspect this worker's discovered MCP servers/tools, read-only annotations and discovery errors. Does not return credentials, environment variables or transport headers.

Inputs: .

### `host_snapshot`

Read host OS, Node, uptime, CPU and live RAM/GPU resource measurements. This does not start/stop software or change model configuration.

Inputs: .

### `process_inspect`

Read a bounded process inventory with PID/name/CPU/memory. Optional literal name filter or PID. Command lines and environment secrets are omitted.

Inputs: `name`; `pid`; `limit`.

### `service_inspect`

Read Windows service status/start type without changing services. Optional literal name filter. Reports unsupported platforms honestly.

Inputs: `name`; `limit`.

### `health_probe`

Perform a bounded HTTP GET health check. Reports status, redirect chain, timing, response content type and a limited textual body. No credentials/headers can be supplied; redirects cannot introduce credentials.

Inputs: `url` (required); `timeoutMs`; `maxBytes`.

### `log_read`

Read the tail of a local text log without loading the whole file. Optional literal contains filter. Reports byte offsets, truncation and line numbers relative to the tail.

Inputs: `path` (required); `lines`; `maxBytes`; `contains`.

### `file_manifest`

Inventory regular files with sizes, timestamps and optional SHA-256, bounded recursion/visited entries and explicit skipped-file reasons. Does not follow symlinks or alter files. Useful for migration/integrity evidence.

Inputs: `path` (required); `recursive`; `hash`; `maxFiles`; `maxHashBytes`; `maxEntries`.

### `artifact_inventory`

Find this worker's saved artifacts, including paths, sizes and SHA-256 hashes. Keeps inspection within the worker workspace. No files are created or deleted.

Inputs: `path`; `maxFiles`.

### `task_history`

Inspect this worker's own recent tasks, status/usage, and optional bounded event evidence for one owned run. Does not resume, stop or replay actions.

Inputs: `runId`; `limit`.

### `automation_schedule`

Preview, list, create, enable or disable this worker's own Nimbus cron routines. workerId, if provided, must equal your ID. Five-field cron uses the reported host timezone. Creation stays DISABLED; enabling requires explicit action/host approval. Duplicate definitions are retained once. No deletion or automatic run.

Inputs: `action` (required) — list, preview, create, enable, disable; `workerId`; `scheduleId`; `cron`; `task`; `quiet`.

## Coordination and generated tools

### `team_status`

Read the live roster, enabled tool names, hierarchy/display groups and bounded task-status metadata before delegating. Private prompts, results, memory, credentials and approval bodies are excluded. Metadata alone does not establish a delegated task's outcome; collect that with `worker_result`.

Inputs: `query`; `limit`; `runLimit`; `includeRecent`.

### `text_statistics`

Count words, Unicode code-point characters and logical lines in inline text, bounded to 1,000,000 UTF-16 code units. Empty input has zero words, characters and lines. CRLF, CR and LF are supported as line separators. This generated native tool is assigned to Builder.

Inputs: `text` (required).

## Verification and limits

The automated suite includes real local HTTP servers, Git repositories/bare remotes, ripgrep, Node test execution and Playwright browser fixtures. Live deployment verification records model tool calls, assigned role coverage, generated artifacts and the running source hash under `data/verification/`. Read the current receipt for counts and any blocked checks.

Static source/security/accessibility analysis is approximate. CSV/JSON tools do not extract binary XLSX, DOCX or PDF files; document checks cover ordinary text/Markdown. Browser tools operate only on owned tabs and do not control arbitrary Windows applications. General-purpose media generation and native document sessions remain separate integrations.

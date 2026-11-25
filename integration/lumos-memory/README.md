# lumos-memory — Lumos memory MCP server for Nimbus

A stdio MCP server that gives the Nimbus Lumos bot the same memory surface it had on
Hermes. It runs against a **copy** of the Hermes home taken at cutover (a lumos-home
generation folder) and never reads or writes the Hermes originals.

| Tool | Effect | Backed by |
|---|---|---|
| `memory` | write | `<home>/memories/MEMORY.md`, `USER.md` (Hermes `memory_tool` semantics) |
| `fact_store` | write (all actions accepted; `search`/`probe`/... only read) | `<home>/memory_store.db` (pinned holographic plugin) |
| `fact_feedback` | write | `<home>/memory_store.db` |
| `session_search` | read | `<home>/state.db`, opened `mode=ro` (`immutable=1` when no `-wal` exists) + `query_only` |

After every successful `memory` write the server (1) mirrors the write into facts the way
the plugin's `on_memory_write` does: `add` ops become facts, `category=user_pref` for
`target=user` and `general` otherwise, while replace and remove ops are not mirrored; and
(2) re-renders the `--render` file. That file holds a `MEMORY (your personal notes)` block
followed by a `USER PROFILE (who the user is)` block, in Hermes' system-prompt format, with
poisoned on-disk entries shown as `[BLOCKED: …]`. The render also happens once at server
startup.

## Files

```
server.py            entry point: MCP stdio server + CLI modes
lumos_memory.py      memory store port, fact/feedback handlers, session_search, render
pinned/              byte-identical Hermes copies + PINS.json (sha256); verified at import
  store.py retrieval.py holographic.py   plugins/memory/holographic/*
  threat_patterns.py                     tools/threat_patterns.py (the content scanner)
effect-hash.mjs      prints the reviewedEffects transportHash for the config entry
tests/               unittest suite (synthetic temp homes only)
```

Hermes commit pinned: `5307e93252ac655cd13fadbd561c0995142138c6`. If a pinned file's
hash differs from `PINS.json`, the server refuses to start (`PinMismatch`). To take a
Hermes update on purpose: copy the new files, update the hashes, and re-run the tests.
`store.py` imports two Hermes helpers lazily (`hermes_state_wal.apply_wal_with_fallback`,
`hermes_cli.sqlite_util.add_column_if_missing`). `lumos_memory.py` installs equivalents in
`sys.modules`. The WAL shim never changes the journal mode, so a WAL-mode copy stays WAL
and a new DB stays DELETE.

## Register in `nimbus.config.json`

Add under `mcpServers` (replace `7` with the Lumos bot id):

```json
"lumos-memory": {
  "enabled": true,
  "command": "F:/Projects/Lumos/HermesPilot/integrations/.venv/Scripts/python.exe",
  "args": [
    "-B",
    "F:/Nimbus/integration/lumos-memory/server.py",
    "--home", "F:/Nimbus/data/bots/7/lumos-home",
    "--render", "F:/Nimbus/data/bots/7/MEMORY.md"
  ],
  "cwd": "F:/Nimbus/integration/lumos-memory",
  "initTimeoutMs": 30000,
  "env": { "PYTHONDONTWRITEBYTECODE": "1" },
  "scope": { "allow": { "workerIds": [7] } },
  "reviewedTools": ["memory", "fact_store", "fact_feedback", "session_search"],
  "reviewedEffects": {
    "memory":         { "effect": "write", "transportHash": "<effect-hash.mjs output>" },
    "fact_store":     { "effect": "write", "transportHash": "<effect-hash.mjs output>" },
    "fact_feedback":  { "effect": "write", "transportHash": "<effect-hash.mjs output>" },
    "session_search": { "effect": "read",  "transportHash": "<effect-hash.mjs output>" }
  }
}
```

`--home` accepts either a generation folder (`…/lumos-home/gen-<UTC>`) or the lumos-home
root. Given the root (no `memories/` there but a `current.json`), the server follows the
pointer: the first string among the keys `current`, `generation`, `path` or `dir`, resolved
relative to the root. The pointer is read once at startup, so restart the server after
switching generations.

`transportHash` is Nimbus' `effectTransportHash(server, def)`. It covers every field except
`scope` and `reviewedEffects`, including `reviewedTools`, so it must be computed after the
rest of the entry is final:

```powershell
node F:/Nimbus/integration/lumos-memory/effect-hash.mjs F:/Nimbus/nimbus.config.json lumos-memory
```

The same hash goes into all four rules. Only `session_search` is `read`. `fact_store` is
`write` because one tool carries both read and write actions.

## CLI modes for the Nimbus host

| Command | Output (one JSON line on stdout, UTF-8) |
|---|---|
| `server.py --home H --prefetch "<query>"` | `{"query", "facts": [{fact_id, content, category, trust, score}]}`: the top 5 facts with `min_trust` 0.3, as in the plugin's `prefetch`. The process finishes within 5 s; if the budget runs out it prints `"timed_out": true` with empty facts. It never creates `memory_store.db`. Measured at about 0.4 s on a 300-fact store. |
| `server.py --home H --extract < msgs.json` | Reads `[...]` or `{"messages": [...]}` and runs the plugin's auto-extract categories over `role=user` messages: preferences become `user_pref`, decisions become `project`, and each fact keeps the first 400 chars. It returns `{"extracted", "scanned", "errors", "truncated"}`. Limits: 8 MiB of input, 500 messages, 50 facts, 10 s (`--max-extract-*`, `--extract-budget-s`). It is best-effort and always exits 0; on bad input it reports an `"error"` key. |
| `server.py --home H --render R --render-now` | Writes the render file and exits. |

The Hermes compaction-summary check is stubbed. A message is skipped when it has a truthy
`compaction_summary`, `_compressed_summary` or `is_summary` key, so Nimbus should set one
of those on its own summary messages. The Hermes merged-summary split
(`_MERGED_SUMMARY_DELIMITER`) is not ported.

Other flags: `--memory-char-limit 2200`, `--user-char-limit 1375`, `--default-trust 0.5`,
`--min-trust 0.3`, `--hrr-dim 1024`, `--hrr-weight 0.3`, `--temporal-decay-half-life 0`
(the Hermes defaults and the values in the Lumos `config.yaml`), and `--transport jsonrpc`
(a built-in newline-delimited JSON-RPC server, also used automatically when the `mcp`
package is missing). Set `LUMOS_MEMORY_LOG=DEBUG` to get diagnostics on stderr. By default
the HRR "near capacity" warning, which repeats on every add past about 256 facts per
category, is suppressed.

## Tool schemas

* **memory**: `{target*: memory|user, action: add|replace|remove, content, old_text, new_text, operations: [{action*, content, new_text, old_text}]}`.
  These are Hermes' `MEMORY_SCHEMA` parameters. The description text is lightly adapted:
  it points to `fact_store` instead of `skill_manage`.
  Behavior: entries are joined by `"\n§\n"`; limits are 2200 chars (memory) and 1375 (user),
  measured on the joined text; an add that would overflow is rejected with
  `current_entries`; `replace` overwrites the whole entry; an exact whole-entry match takes
  priority over a substring match; distinct substring matches are refused as ambiguous;
  batches are all-or-nothing, checked against the final budget, and refuse to empty a
  non-empty store; duplicate adds are idempotent; content is scanned with the strict scope
  (pinned `threat_patterns.py`); files are written through a lock file plus an atomic
  replace; the drift guard writes a `.bak.<ts>`; an existing but unreadable file is never
  overwritten.
  Not ported, because they are Hermes runtime features: the approval gate and staging,
  the background-review delete gate, the per-turn consolidation-failure cap, and the
  frozen-snapshot prompt (Nimbus injects the render file instead).
* **fact_store**: `{action*: add|search|probe|related|reason|contradict|update|remove|list, content, query, entity, entities[], fact_id, category: user_pref|project|tool|general, tags, trust_delta, min_trust, limit}`. This is the plugin's schema and handlers unchanged.
* **fact_feedback**: `{action*: helpful|unhelpful, fact_id*}`. Helpful adds 0.05 to trust and increments `helpful_count`; unhelpful subtracts 0.10. Trust is clamped to [0, 1].
* **session_search**: `{query, limit (default 3, max 10), sort: relevance|newest|oldest, session_id, around_message_id, window (default 20, max 100)}`.
  It has four shapes: discovery (`query`), scroll (`session_id` + `around_message_id`),
  read (`session_id`) and browse (no args). It matches the Hermes v23 `messages_fts`
  layout and the legacy layout, since only `rowid` is used. A malformed FTS expression
  falls back to an OR of quoted tokens. Message content is cut at 1500 chars. This is a
  simplified version of the Hermes tool: there is no `@session` link rendering and no
  trigram or CJK index.

## Cutover note (memory_store.db / state.db)

In the live Hermes home, `memory_store.db` and `state.db` both have non-empty `-wal` files
(about 239 KB and 968 KB on 2026-11-24). A copy that leaves out the `-wal` loses
uncommitted facts and messages. Copy each DB together with its `-wal` and `-shm` while
Hermes is stopped, or produce the copy with the SQLite backup API
(`sqlite3.connect(src).backup(dst)`).

## Tests

```powershell
cd F:/Nimbus/integration/lumos-memory; F:/Projects/Lumos/HermesPilot/integrations/.venv/Scripts/python.exe -B -m unittest discover -s tests -v
```

The suite has 40 tests. Each test builds a synthetic "Hermes home" in a temp dir (two
`§`-delimited memory files, a fact store made with the pinned store, and a state.db with
the v23 FTS layout), copies it to a `lumos-home/gen-…` folder, and works only on the copy.
`TestZZSourceHomeUnchanged` runs every operation, including the CLI subprocesses, and then
checks that the source home's file hashes are byte-identical.

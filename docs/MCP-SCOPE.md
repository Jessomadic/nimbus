# MCP connector scope (candidate)

This candidate is not deployed. Native `status`, `validate` and compare-and-swap `set` use the host configuration policy path. Only explicitly enabled workers may dispatch management calls; the host explicitly enables the original consumer after independent acceptance, without widening the coordination-only template defaults. Independent acceptance and host deployment remain required.

Global `mcpServers` definitions may include `scope: {allow: {workerIds:[22], templates:["orchestrator"], groups:["operators"]}, tools:{raw_tool_name:{allow:{workerIds:[22]},deny:{templates:["reviewer"]}}}}`. The top-level `mcpScopeGroups` map defines groups using only `workerIds` and exact `templates`. Groups cannot nest. Identifiers are not credentials; never place transport secrets in policy.

Selector members are ORed. Server allow AND optional tool allow must match; a matching tool deny wins. Empty allow denies everybody. Unlisted tools inherit the server scope. Missing scope retains legacy assignment access, not deny-all. Null scope is invalid. Templates use stable `bot.template`, not free-text role or UI display groups. Plugin assignment is still required; global/plugin name shadowing is rejected.

Discovery and every submission check trusted worker identity and current config. Revocation prevents future calls but cannot undo a submitted action. Transport generations prevent old bindings reviving after reconnect. Ambiguous normalized server namespaces fail closed without connecting denied servers. Per-tool policies use raw MCP names, not lossy normalized aliases.

The canonical registry retains server schemas and descriptors. Trusted provenance is separate from server metadata. Non-read-only submitted failures are uncertain even when idempotentHint is true; never replay to resolve uncertainty. Journal call IDs retain no-replay protections.

This is a Nimbus runtime boundary, not an OS sandbox against privileged shell/config operators. Back up config independently of source snapshots. Before rollback to a version ignoring scope, disable restricted connectors; otherwise missing enforcement would restore legacy visibility. No Lumos configuration is automatically changed.

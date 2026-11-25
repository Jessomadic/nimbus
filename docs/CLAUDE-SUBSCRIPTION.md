# Claude subscription beside OpenAI

Nimbus can run workers on your Claude subscription (through Claude Code) as well as on your ChatGPT subscription (through Codex). The OpenAI sign-in is unchanged; Claude is added next to it. Paid API keys are not used for either provider.

## Connect Claude

1. In a terminal on the Nimbus machine, run `claude setup-token` and sign in with your Claude account.
2. In Nimbus, open **Settings → Claude subscription**, paste the `sk-ant-oat…` token and choose **Connect Claude**.

The token is encrypted with Windows DPAPI for the Nimbus Windows account (`data/credentials/claude-token.dpapi`) and is never returned by any endpoint. Without a token, Nimbus uses the machine's own `claude` login (`claude auth login`). **Remove token** deletes the stored token.

Nimbus starts Claude Code with a clean environment: inherited `ANTHROPIC_*` and `CLAUDE*` variables are removed, and a run that reports an API key as its credential source is refused.

## How a worker picks a model

When both subscriptions are connected, each task is routed to the model ranked best for the worker's role, and falls back to the next best when a model fails or a subscription reaches its usage limit. The ranking is in `runtime/provider-catalog.js`:

| Role category | Ranking, best first |
| --- | --- |
| Engineering (Builder, Reviewer, QA, GitHub) | Claude Opus → Sol → Astra → Claude Fable → Claude Sonnet → Terra → Claude Haiku → Luna |
| Architecture | Claude Fable → Claude Opus → Astra → Sol → Claude Sonnet → Terra |
| Security | Claude Fable → Astra → Claude Opus → Sol → Claude Sonnet → Terra |
| Research and data | Astra → Claude Opus → Sol → Claude Fable → Claude Sonnet → Terra → Claude Haiku → Luna |
| Writing and design | Claude Opus → Astra → Claude Sonnet → Sol → Claude Fable → Terra → Claude Haiku → Luna |
| Operations, browser, automation | Terra → Claude Sonnet → Sol → Claude Opus → Luna → Claude Haiku → Astra |
| Orchestration | Sol → Claude Opus → Astra → Claude Fable → Claude Sonnet → Terra |

The role's own preference (for example Luna for the Office Assistant) keeps routine roles on lower-cost tiers: candidates closest to that capability class come first. The local router can still choose the shared local model for simple tasks.

Evidence: the engineering and architecture orderings come from current public results (SWE-bench Pro, Terminal-Bench 4.0 and composite indexes, retrieved 2026-11-24; sources are listed in the file). The other categories are inferred from those results and each tier's documented purpose; no head-to-head benchmark was found for Luna, Terra or Claude Haiku 5.5. Override any category in `nimbus.config.json`:

```json
{ "routing": { "providerRanking": { "research": ["claude-opus", "astra", "sol"] } } }
```

A worker's **Model override** (or `/model` in its chat) pins one tier, for example `claude-sonnet` or `sol`.

## How Claude runs

Claude Code is used for subscription authentication and inference only. Its built-in tools, skills, slash commands, settings files and session history are disabled for Nimbus runs. Nimbus offers its own tools through a per-turn MCP bridge (`runtime/claude-bridge.mjs`) on a loopback port with a random token, so approvals, permissions and the action journal are the same as for Codex. Any attempt to use a built-in Claude Code tool holds the task for review.

## Chat commands

These run on the host and use neither subscription: `/help`, `/model`, `/effort`, `/providers`, `/usage`, `/context`, `/stop`, `/rename`, plus the existing `/new` and `/compact`.

## Codex memories and skills

`node bin/import-codex.mjs` previews an import of `~/.codex/AGENTS.md`, the Codex memories and user skills; add `--apply` to write. Instructions and memories go to shared notes under `data/shared/codex/`, user skills to `data/skills/`. Text is redacted before it is written, unchanged files are skipped, and a file changed in Nimbus is reported as a conflict rather than overwritten. Codex's built-in `.system` skills are skipped unless `--include-system-skills` is given. Every worker's instructions then include the imported `AGENTS.md` guidance and a pointer to the imported memories.

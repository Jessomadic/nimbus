# Context and retained evidence

Nimbus bounds aggregate model input automatically. Older completed tool exchanges
leave the inference view as whole call/result pairs, with an explicit retained
action index. All user instructions, ordinary assistant replies and unfinished or
uncertain actions remain. The canonical checkpoint and action journal stay complete.
Models use `task_history` with an indexed `callId` and optional `offset`/`maxChars`
to retrieve exact stored arguments/results without rerunning the action. Retrieval
is restricted to the owning worker. This archive is evidence, not a claim that raw
tool output has become curated semantic memory.

In an idle or paused worker chat, send `/compact`. Nimbus archives exact previous
history and paused/interrupted checkpoints under that worker's `context-archives`
folder before replacing their inference history with the bounded view. It does not
run a model, reset the chat, delete messages, change durable MEMORY.md, resume work
or interrupt an active task. Retrying the same HTTP request ID cannot compact twice.

Server settings → Context and memory controls automatic compression, the maximum
history character budget, and tool-result preview size. Loaded local context,
instruction/tool overhead and output reserve can lower the configured budget.
Disabling automatic compression keeps `/compact` available. If protected user text
or unfinished work alone exceeds capacity, Nimbus retains it and reports the limit
instead of silently cutting user instructions.

Archives and canonical action records remain local Nimbus data. They are not
automatically published to shared knowledge or Hermes/Lumos.

# Use viewer aggregation for trace display

Status: accepted

Harness Trace will use a viewer-side Trace Display Aggregator to render Learn and Deep Agent Loop Streams as readable blocks instead of printing one line per raw trace event. JSONL capture remains unchanged and continues to be the source of truth. Raw JSONL output bypasses the aggregator.

**Context**

The first Agent Loop Stream made trace output more readable than raw JSONL, but it still behaved like a colored log stream. Tool calls, hooks, transcript writes, and stream events can arrive as many low-level events even when they represent one human-level action. Showing each event separately makes live tailing hard to read and obscures the harness loop the trace is meant to teach.

**Decision**

Use a Trace Display Aggregator in the CLI viewer:

- Learn and Deep both render block-style output with blank lines between blocks.
- Learn blocks contain shallow human narration and hide low-level event metadata by default.
- Deep blocks contain event names, short ids, sequence information, and structured summaries.
- Tool start/result/error and related hooks render as one Tool Call Block.
- STORE and STREAM high-frequency events are summarized, merged, or throttled instead of printed one-by-one.
- Live tailing uses Adaptive Trace Flush to decide when to print a pending block.
- Replay can aggregate over historical events before rendering.
- `--raw` remains exact JSONL and does not use aggregation.

**Consequences**

The display layer becomes stateful. It must maintain pending tool calls, hook associations, recent tool timing estimates, and flush timers while preserving deterministic replay behavior. Tests should cover both completed replay aggregation and live tail flush boundaries.

The JSONL event schema remains stable. Any display schema introduced for Deep rendering is a viewer-side ViewModel, not a capture schema change.

**Considered Options**

- One event, one line: simplest and maximally immediate, but reads like a log stream and makes common tool calls noisy.
- Terminal in-place updates: visually compact, but fragile across PowerShell, Windows Terminal, redirected output, and CI.
- Viewer aggregation with adaptive flush: adds state, but gives the clearest human view while keeping raw JSONL available.

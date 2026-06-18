# Use Agent Loop Stream as the default trace view

Status: accepted

Harness Trace defaults to an Agent Loop Stream for `trace tail` and `trace replay` because the project is meant to teach how the Claude Code harness and LLM interact while work is happening. Raw JSONL remains the source of truth behind `--raw`, and the Deep Agent Loop Stream provides richer structured summaries without turning the default view into a log dump.

**Considered Options**

- Keep the Agent Loop Panel as the default: quieter for summaries, but it hides the real-time harness sequence the trace exists to study.
- Show raw JSONL by default: complete and easy to implement, but unreadable during live CLI work.
- Use Agent Loop Stream by default: preserves real-time causality, keeps event names as weak metadata, and uses stable colored Stream Stages for readability.

**Consequences**

`trace tail` opens with the latest turn for orientation, then follows new events. `trace replay` uses the same Stream language over historical turns. `trace tail --deep` and `trace replay --deep` may expand structured prompts, messages, tool inputs, and stream blocks, while `--raw` remains the only exact JSONL display mode.

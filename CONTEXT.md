# Claude Code Harness Lab

This context defines project-specific language for the reverse-engineered Claude Code harness and its local study tooling.

## Language

**Agent Loop Stream**:
A real-time trace view that appends human-readable, colored harness and LLM interaction steps as a conversation runs. When opened during an active session, it starts with the latest turn as orientation and then follows new events.
_Avoid_: Agent Loop Panel, trace panel, log stream

**Stream Stage**:
A stable display category in the Agent Loop Stream, such as USER, PREP, LLM, STREAM, DECISION, TOOL, HOOK, SIDE, STORE, DONE, or ERROR. Stream Stages are colored by meaning rather than by low-level event type.
_Avoid_: raw event type as display category, log level

**Side Task**:
A secondary harness task such as memory extraction, session memory, title generation, or prompt suggestion that runs beside the main user-request loop. Side Tasks appear in the Agent Loop Stream as compressed explanatory summaries.
_Avoid_: treating side task prompts as the main user request

**Store Event**:
A trace-visible persistence action such as transcript append, session start, or session end. Store Events appear in the Agent Loop Stream only as low-noise summaries of meaningful writes.
_Avoid_: full transcript body, high-frequency write spam

**Deep Agent Loop Stream**:
A richer Agent Loop Stream view for local study that expands structured summaries of prompts, messages, tool input, and stream blocks without becoming raw JSON.
_Avoid_: full JSON dump, raw stream

**Raw JSONL Stream**:
The exact append-only trace source view emitted from JSONL events, used when fidelity matters more than readability.
_Avoid_: Deep Agent Loop Stream

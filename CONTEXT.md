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

**Main User Input**:
The original user request that anchors the current main agent loop. Deep Agent Loop Stream may show the complete Main User Input because it explains what the harness is trying to do.
_Avoid_: treating Side Task prompts as Main User Input, truncating the main request when the purpose is local study

**Trace Detail Lookup**:
A focused way to inspect one trace event or one structured section in full after locating it from an Agent Loop Stream. Deep Agent Loop Stream should provide enough identifiers and shape information to lead into Trace Detail Lookup instead of dumping every full system prompt, messages array, or tool input inline.
_Avoid_: making Deep Agent Loop Stream the raw detail dump

**Trace Display ViewModel**:
The viewer-side structured representation that translates raw JSONL Trace Events into intuitive Learn or Deep output. It exists to make the display easy to understand without changing the JSONL source of truth.
_Avoid_: changing trace capture schema just to make one viewer easier to render

**Trace Show Command**:
The proposed CLI command for Trace Detail Lookup: `trace show <session-id> <event-id>`. It displays one trace event in full, with the default output using the project redaction rules and `--raw` reserved for the exact JSONL line.
_Avoid_: using `trace inspect` for single-event detail lookup

**Trace Event Short Id**:
A copyable prefix of a trace event id shown in Deep Agent Loop Stream. Trace Detail Lookup may accept short id prefixes when they identify exactly one event; if a prefix is ambiguous, the CLI should ask for a longer id.
_Avoid_: printing full event ids in every Deep stream line

**Tool Input Summary**:
The Deep Agent Loop Stream representation of a tool request: tool name, operation summary, key fields, input size, and Trace Event Short Id. Full tool input belongs in Trace Detail Lookup.
_Avoid_: printing full `old_string`, `new_string`, command bodies, or MCP payloads inline in the stream

**Tool Call Block**:
A displayed block that groups one tool invocation across started/result/error events. Human narration can be localized, but the tool name itself must remain the original English identifier from the harness, such as `Read`, `Edit`, `Bash`, or an MCP tool name.
_Avoid_: translating tool identifiers into Chinese

**Trace Display Aggregator**:
The viewer-side in-memory component that groups related trace events into intuitive display blocks, such as combining hooks, tool start, and tool result into one Tool Call Block. It exists only for presentation and does not change JSONL capture.
_Avoid_: one-event-one-line output when it makes the stream harder to understand

**Adaptive Trace Flush**:
The Trace Display Aggregator's viewer-side timing strategy for deciding when to print a pending block during live tailing. It should estimate from the current event, tool type, and recent observed timings instead of using one fixed delay for every situation.
_Avoid_: hard-coding one universal flush delay for all tools and sessions

**Learn Agent Loop Stream**:
The default shallow Agent Loop Stream for watching work live beside the CLI. It should prioritize readable stage narration over low-level event metadata. Event names may be shown only when explicitly requested, while Deep Agent Loop Stream keeps event names and Trace Event Short Ids visible for source-level study.
_Avoid_: making Learn look like a colored log stream

**Learn Stream Hint**:
A one-time header hint at the top of Learn Agent Loop Stream that explains the viewing modes in plain language, such as using `--deep` for event ids and `--raw` for JSONL. It should not repeat inside the stream.
_Avoid_: repeating instructions between events

**Bilingual Stage Label**:
The default Stream Stage label format for this project: stable English stage key plus Chinese explanation, such as `PREP 构造上下文` or `TOOL 工具`. The English key keeps the stream aligned with code and open-source usage; the Chinese explanation keeps the local study workflow readable.
_Avoid_: Chinese-only stage labels, changing the English stage key per locale

**Trace Display Locale**:
The language setting for human-facing trace narration. The default local workflow may use Chinese narration, but the stream should be designed so an English narration mode can be added without changing event capture or JSONL schema.
_Avoid_: baking Chinese prose into trace event payloads

**Trace Language Flag**:
The explicit viewer option for Trace Display Locale, proposed as `--lang zh` or `--lang en`. Locale should affect only rendered CLI narration and labels, not trace capture, JSONL schema, or event payloads.
_Avoid_: implicit locale changes based on OS or terminal settings

**Full Trace Mode**:
A trace capture mode that records richer event payloads for later study. Full Trace Mode describes how much the harness records; it does not name the display format. Deep Agent Loop Stream describes how those records are rendered for humans.
_Avoid_: using full and deep as interchangeable terms

**Raw JSONL Stream**:
The exact append-only trace source view emitted from JSONL events, used when fidelity matters more than readability.
_Avoid_: Deep Agent Loop Stream

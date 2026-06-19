# Trace Agent Loop Display Design

本文记录 Harness Trace 下一版显示层设计。它描述 CLI viewer 如何把 JSONL trace 渲染成可学习、可跟随、可深入定位的 Agent Loop Stream。

## Goals

- 让用户在 Claude Code REPL 旁边实时看懂 harness 和 LLM 的交互过程。
- 让 `learn` 默认像“实时讲解”，而不是彩色日志流。
- 让 `deep` 服务源码研究，提供事件定位、结构摘要和跳转入口。
- 保持 `raw` 作为完整 JSONL source of truth。
- 为中文本地学习和未来英文开源用户同时留出显示语言空间。

## Core Terms

- `learn`：浅层学习视图，默认可读、低噪声。
- `full`：trace 采集模式，表示记录更丰富的事件 payload。
- `deep`：显示深度，表示用更丰富的结构化方式渲染 trace。
- `raw`：原始 JSONL 输出。

一句话边界：**full 是“记录多少”，deep 是“怎么看”。**

## Modes

### Learn Agent Loop Stream

默认实时视图。目标是让人顺着 Agent 循环读下去。

特征：

- 默认隐藏低层事件名，例如 `api.request_built`、`tool.started`。
- 可通过 `--events` 显示低层事件名，帮助把 Learn 画面和源码 tracepoint 对上。
- 默认不显示 event id。
- 使用分块缩进结构，和 Deep 保持统一视觉语言。
- 每个块使用固定的人话动作模板。
- 只保留理解流程必要的数字：消息数量、工具数量、工具名、耗时、文件名、大小。
- 顶部只显示一次短提示，说明 `--deep` 和 `--raw` 的用途。

示例：

```text
Trace Learn：实时展示 Agent 循环；用 --deep 看事件 id，用 --raw 看 JSONL。

[TURN 轮次] 1 - 读一下 README.md
  用户说：读一下 README.md

[PREP 构造上下文] 准备模型输入
  messages: 用户 1 条，内部上下文 3 条
  tools: 25 个可用工具

[LLM 模型请求] 请求已发送
  model: deepseek-v4-pro

[STREAM 模型流] 模型请求工具
  tool: Read

[HOOK 钩子] 工具前检查通过
  tool: Read

[TOOL 工具] 读取文件
  path: D:\develop\ClaudeCode\README.md
  result: 6ms, 5031B

[HOOK 钩子] 工具后记录完成
  tool: Read

[DECISION 决策] 工具结果已加入 messages
  next: 回到模型继续

[DONE 完成] 返回最终回复
  duration: 16.1s
```

### Deep Agent Loop Stream

源码研究视图。目标是看到更完整的结构，但不把主流变成 raw JSON dump。

特征：

- 显示事件名和 Trace Event Short Id。
- 显示 Main User Input，但主流输出需要高上限保护。
- 显示 system prompt、messages[]、tool input 的结构摘要、数量、来源、尺寸和关键字段。
- 不在主流中直接铺完整 system prompt、完整 messages[]、完整 tool input。
- 每个可深入查看的事件都能通过 `trace show` 打开。

示例：

```text
[PREP 构造上下文] 准备模型输入 id=ab12cde event=query.loop_start
  sequence: 42
  system prompt: 13 blocks, 18.2KB
  messages: user=1 assistant=3 internal=8 attachments=2
  tools: 25 available

[LLM 模型请求] 请求已发送 id=cd34ef0 event=api.request_built
  provider: firstParty
  model: deepseek-v4-pro
  maxTokens: 32000

[TOOL 工具] 编辑文件 id=ef56ab1 event=tool.started
  file: src/trace/cli.ts
  old: collapsed(420B)
  new: collapsed(690B)
```

Main User Input 显示规则：

- Learn：显示短摘要，约 120 字符。
- Deep：显示较长正文，默认上限约 4000 字符。
- 超过上限时显示截断提示，并指向 `trace show`。
- `trace show` 和 `--raw` 才用于查看完整事件内容。

### Raw JSONL Stream

精确源数据视图。目标是 fidelity，不是可读性。

特征：

- 输出原始 JSONL。
- 不做叙事模板。
- 不做 stream stage 聚合。
- 用于调试 viewer、核对完整 payload、导入外部分析工具。

## Side Task Display

Side Task 不能被误读为主用户请求，但应该在 trace 中可见。

Learn 示例：

```text
[SIDE 旁路任务] session_memory 已压缩
  reason: 会话记忆
```

Deep 示例：

```text
[SIDE 旁路任务] session_memory id=ab12cde
  model: deepseek-v4-pro
  messages: 3
  tools: 25
  output: collapsed
```

规则：

- Learn 默认显示压缩 SIDE 摘要。
- Deep 显示 SIDE 的结构块。
- 不展开 side task prompt。
- 不把 side task prompt 当作 Main User Input。

## Locale

Trace viewer 应支持显式语言参数：

```powershell
bun run dev trace tail --lang zh
bun run dev trace tail --lang en
bun run dev trace tail --deep --lang en
```

原则：

- 默认本地学习流程可以使用中文。
- Stream Stage 默认使用英文 key + 中文解释，例如 `PREP 构造上下文`。
- 英文 key 必须稳定，方便和源码、测试、开源文档对应。
- 语言只影响 CLI 渲染，不影响 JSONL schema、event payload 或 trace capture。
- 不根据 OS / terminal locale 自动切换，避免测试和截图不稳定。

## Learn Narration Templates

Learn 模式必须使用固定模板，避免后续实现随手写出风格不一致的文案。

Learn 和 Deep 都使用分块缩进结构。区别不在布局，而在信息深度：

- Learn block：浅层字段，只保留理解流程必要的信息。
- Deep block：深层字段，包含 event name、Trace Event Short Id、sequence、结构摘要和可跳转详情。
- block 之间保留一个空行，保证实时滚动时仍然能看清阶段边界。
- 高频事件不能逐条刷 block；STREAM delta、transcript append 等应合并、节流或归入当前阶段摘要。
- Learn 中的 STORE 只显示关键摘要，不为每次 transcript append 单独开 block。
- Deep 可以显示更细的 STORE 写入事件，但仍需遵守分块和节流规则。

| Stage | zh 模板 | en 模板 |
| --- | --- | --- |
| `TURN` | `{index} - {userInput}` | `{index} - {userInput}` |
| `USER` | `{userInput}` | `{userInput}` |
| `PREP` | `准备消息：用户 {user} 条，内部上下文 {internal} 条，工具 {tools} 个` | `Prepared messages: user={user}, internal={internal}, tools={tools}` |
| `LLM` | `已发送给模型：{model}` | `Sent request to model: {model}` |
| `STREAM` | `模型请求调用工具：{tool}` | `Model requested tool: {tool}` |
| `HOOK` | `工具前检查通过：{tool}` / `工具后记录完成：{tool}` | `Pre-tool check passed: {tool}` / `Post-tool hook completed: {tool}` |
| `TOOL` | `{operation}：{target}` | `{operation}: {target}` |
| `STORE` | `记录写入：{entryType}，{bytes}B` | `Stored record: {entryType}, {bytes}B` |
| `DECISION` | `工具结果已加入 messages，回到模型继续` | `Tool result appended to messages, looping back to model` |
| `DONE` | `返回最终回复：耗时 {duration}` | `Returned final response: {duration}` |
| `SIDE` | `旁路任务：{source}，已压缩` | `Side task: {source}, collapsed` |
| `ERROR` | `错误：{summary}` | `Error: {summary}` |

## Tool Input Summary

Deep 模式的工具行显示：

- 工具名，必须保留 harness 里的英文原文，例如 `Read`、`Edit`、`Bash` 或 MCP tool name。
- 操作摘要。
- 关键字段。
- input size。
- Trace Event Short Id。

示例：

```text
[TOOL 工具] Read started path=README.md id=ef56ab1
[TOOL 工具] Bash started command="bun test src/trace" timeout=120000 id=cd34ef0
[TOOL 工具] Edit started file=src/trace/cli.ts old=collapsed(420B) new=collapsed(690B) id=ab12cde
```

完整 tool input 通过 Trace Detail Lookup 查看。

## Tool Call Block

工具调用在显示层应合成 Tool Call Block，而不是简单按 `tool.started` / `tool.result` 拆成两个互不相干的块。

这需要 viewer-side Trace Display Aggregator：

```text
tool.detected / stream tool_use -> create pending Tool Call Block
hook.started / hook.result -> attach hook status
tool.started -> attach input summary
tool.result / tool.error / tool.cancelled -> flush completed Tool Call Block
```

聚合器只存在于 CLI viewer 进程内，不改变 JSONL source of truth。

Learn 示例：

```text
[TOOL 工具] Read 读取文件
  pre-hook: passed, 1390ms
  path: README.md
  status: ok
  duration: 6ms
  size: 5031B
  post-hook: completed, 1389ms
```

Deep 示例：

```text
[TOOL 工具] Read call_00_xxx
  started: id=ab12cde event=tool.started
  result: id=cd34ef0 event=tool.result
  hooks:
    PreToolUse: id=1122aaa duration=1390ms
    PostToolUse: id=3344bbb duration=1389ms
  path: README.md
  status: ok
  duration: 6ms
  size: 5031B
```

规则：

- 工具名必须使用英文原文，不翻译。
- 中文/英文 narration 只能修饰动作，例如“读取文件”或 “read file”。
- Learn 默认展示合并后的工具动作。
- Deep 可以暴露 started/result 的 event id，但视觉上仍归属同一个 Tool Call Block。
- Learn 不为 HOOK 单独开 block；PreToolUse / PostToolUse 归入相关 Tool Call Block。
- Deep 在 Tool Call Block 内展示 hook 明细和 event id。
- hook 或 tool 失败时，仍保留 Tool Call Block 的上下文，同时额外输出 ERROR block，让异常在实时流里醒目。
- `trace replay` 可以完整聚合后输出。
- `trace tail` 使用 Adaptive Trace Flush：工具开始后短暂等待，等待时间根据当前工具类型、事件形状和最近观察到的工具耗时推算。如果 result 很快到达则输出完整 Tool Call Block；如果推算窗口后仍未到达，则输出 running block，后续 result 到达时再输出完成块。
- `--raw` 绕过聚合器，保持 JSONL 原样。

第一版 Adaptive Trace Flush 使用可解释启发式：

```text
如果 result 已经到了：
  立即输出完整 Tool Call Block

如果是 Read / Glob / Grep / Edit 这类通常很短的工具：
  最多等 min(最近同工具 p75 耗时, 200ms)，下限 50ms

如果是 Bash / PowerShell / Agent / MCP 这类可能长跑的工具：
  最多等 80ms，然后先输出 running block

如果同工具没有历史数据：
  短工具默认等 120ms
  长工具默认等 80ms

任何 pending block 最晚 250ms 必须输出 running，避免用户感觉 tail 卡住
```

该策略必须保持可测试、可解释，不引入模型预测或不可控异步行为。

失败示例：

```text
[TOOL 工具] Bash 执行命令
  command: bun test src/trace
  status: failed
  duration: 4.2s

[ERROR 错误] Bash 执行失败
  reason: exit code 1
  next: 等待模型处理错误结果
```

## Deep Unified Summary Schema

Deep Agent Loop Stream 在实现前必须先定义统一展示 schema，不能只按当前 payload 临时拼字段。

原因：

- 不同 provider 的 request payload 字段不完全一致。
- `systemPrompt`、`messages[]`、`tools`、`tool input` 的来源和形状不同。
- Deep 是源码研究视图，需要稳定字段，方便测试、截图、文档和后续英文模式。
- 统一展示 schema 只服务 CLI 渲染，不改变 JSONL source of truth。

实现边界：

```text
JSONL TraceEvent -> Trace Display ViewModel -> Learn / Deep / raw viewer
```

直观优先体现在 ViewModel 和渲染层，不体现在修改采集层。JSONL TraceEvent 继续保持原始事实来源；Trace Display ViewModel 负责把不同 provider、不同事件形状翻译成适合人读的结构。

初始 schema 至少覆盖：

```text
TraceDeepSummary
  event
    type
    shortId
    sequence
    timestamp
  request
    provider
    model
    querySource
    maxTokens
    betaCount
  prompt
    systemPromptBlocks
    systemPromptBytes
    userContextState
    systemContextState
  messages
    total
    user
    assistant
    systemOrInternal
    attachments
    approximateBytes
  tools
    total
    names
  toolInput
    toolName
    operation
    keyFields
    collapsedFields
    approximateBytes
```

Provider 特有字段可以进入 `request.providerDetails`，但主渲染不能依赖 provider-specific 字段才能成立。

Deep 渲染形态应优先使用分块缩进结构，而不是把所有字段塞进一条长行。

推荐格式：

```text
[PREP 构造上下文] 准备模型输入 id=ab12cde
  system prompt: 13 blocks, 18.2KB
  messages: user=1 assistant=3 internal=8 attachments=2
  tools: 25 available
```

这让 Deep 更像可读的结构化讲解，而不是日志字段拼接。

## Trace Detail Lookup

新增命令方向：

```powershell
bun run dev trace show <session-id> <event-id>
bun run dev trace show <session-id> seq:<sequence>
bun run dev trace show <session-id> <event-id> --raw
```

规则：

- 默认输出单个事件的脱敏 pretty JSON。
- `--raw` 输出该事件的原始 JSONL 行。
- `<event-id>` 支持 Trace Event Short Id 前缀匹配。
- 如果前缀唯一，直接显示。
- 如果前缀冲突，提示用户输入更长 id。
- `seq:<sequence>` 按 trace sequence 精确查找。
- 不支持裸数字查找，避免和 short id 前缀混淆。
- 不使用 `#<sequence>` 作为推荐语法，因为 PowerShell 会把 `#` 解释为注释。
- 如果找不到，给出明确错误并建议 `trace replay --deep` 查找 id。

## Non-goals

- 不做 Web UI。
- 不把 Deep Agent Loop Stream 变成 full raw JSON dump。
- 不在 Learn 模式默认显示 event metadata。
- 不把中文文案写进 JSONL payload。
- 不根据 OS locale 自动切换显示语言。
- 不把 side task prompt 当成 Main User Input。

## Open Questions

- 是否需要 `trace tail --no-color`，或只遵守 `NO_COLOR`。

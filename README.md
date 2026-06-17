# Claude Code Harness Lab

面向 Claude Code CLI 恢复、裁剪、验证和可观测性实验的工程仓库。

本仓库来源于
[claude-code-best/claude-code](https://github.com/claude-code-best/claude-code)
的代码基础，但当前目标已经不同：这里不是上游项目主页，也不是 Anthropic
官方 Claude Code。当前仓库更关注可运行的本地 harness、严格类型检查、功能门控、
多 provider 兼容、CLI 优先的调试能力，以及可审计的 trace 输出。

## 项目定位

- **恢复核心 CLI 能力**：保留 Claude Code 风格的 REPL、pipe 模式、工具调用、
  会话管理和 provider 适配。
- **裁剪不匹配目标的内容**：上游 README 中的营销文案、社区入口、赞助信息和
  与当前实验目标无关的内容不再作为本仓库说明的一部分。
- **默认保守、显式开启**：新增能力应通过 feature flag 或显式命令开启，避免改变
  默认运行路径。
- **验证优先**：TypeScript strict 必须通过；测试使用 `bun:test`；核心改动需要有
  聚焦测试覆盖。
- **CLI 优先**：当前仓库的主要交互面是 CLI / REPL / JSONL 文件，不把 Web UI
  作为第一版验证界面。

## 当前重点能力

| 领域 | 说明 |
| --- | --- |
| CLI / REPL | `src/entrypoints/cli.tsx` 是真实入口，完整 CLI 逻辑在 `src/main.tsx` |
| Query Loop | `src/query.ts` 与 `src/QueryEngine.ts` 管理模型请求、流式响应、工具调用和 turn 生命周期 |
| Tool System | 内置工具主要来自 `packages/builtin-tools/`，统一经 `src/tools.ts` 注册 |
| Provider 兼容 | 支持 firstParty、Bedrock、Vertex、Foundry、OpenAI、Gemini、Grok 等 provider 适配层 |
| Feature Flags | 统一使用 `import { feature } from 'bun:bundle'` 与 `FEATURE_<FLAG_NAME>=1` |
| ACP / RCS | 保留 Agent Client Protocol、remote control server、自托管远程控制相关模块 |
| Harness Trace | 新增 `HARNESS_TRACE` 观测链路，默认 off，手动 learn/full/off，JSONL 为第一版 source of truth |

## 快速开始

### 环境要求

- [Bun](https://bun.sh/) >= 1.3
- TypeScript strict 约束必须保持通过

Windows PowerShell 安装 Bun：

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

macOS / Linux 安装 Bun：

```bash
curl -fsSL https://bun.sh/install | bash
```

### 安装依赖

```bash
bun install
```

### 开发运行

```bash
# 启动完整 CLI / REPL
bun run dev

# Pipe 模式
echo "say hello" | bun run src/entrypoints/cli.tsx -p

# 调试模式
bun run dev:inspect
```

### 构建

```bash
bun run build
```

构建入口是 `src/entrypoints/cli.tsx`，输出到 `dist/`。构建流程由
`build.ts` 管理，并会处理运行时兼容所需的后处理步骤。

## 常用验证命令

```bash
# 类型检查
bun run typecheck

# 全量测试
bun test

# 指定测试文件
bun test src/trace

# 项目预检查，包含类型、lint/format 修复和测试
bun run precheck
```

提交前至少应根据改动范围运行聚焦测试和 `bun run typecheck`。涉及共享入口、
provider、工具执行、状态管理或 trace 边界的改动，应扩大测试范围。

## Harness Trace

Harness Trace 是本仓库用于观察 CLI / query / API / tool / subagent 运行边界的
JSONL trace 系统。

核心边界：

- 默认关闭。
- `learn` / `full` 必须手动开启，并持续到显式 `off`。
- trace 只能作为 observer，不进入 model messages、system prompt、user context
  或 tool input。
- JSONL 文件是第一版 source of truth。
- 第一版以 CLI 查看为主，不做 Web UI。

开发模式下可用：

```bash
# 查看状态
bun run dev trace status

# 开启精简学习视图
bun run dev trace learn

# 开启更完整的调试视图
bun run dev trace full

# 关闭 trace
bun run dev trace off

# 列出 session
bun run dev trace list

# 回放 session
bun run dev trace replay <session-id>

# 输出 session 摘要
bun run dev trace inspect <session-id>
```

可通过 `CLAUDE_CODE_TRACE_DIR` 指定 trace 输出目录。

## Feature Flags

运行时功能统一通过 feature flag 控制：

```bash
FEATURE_HARNESS_TRACE=1 bun run dev
FEATURE_BRIDGE_MODE=1 bun run dev
```

开发模式和构建模式各自有默认启用列表，集中维护在 `scripts/defines.ts`、
`scripts/dev.ts` 和 `build.ts`。新增功能应遵守现有模式：

- 使用 `import { feature } from 'bun:bundle'`。
- `feature('FLAG_NAME')` 只放在 `if` 条件或三元表达式条件位置。
- 不绕过 feature flag 直接改变默认路径。

## 目录导览

| 路径 | 说明 |
| --- | --- |
| `src/entrypoints/cli.tsx` | CLI 真入口，处理快速路径和完整 CLI 加载 |
| `src/main.tsx` | Commander CLI 定义与主要命令分发 |
| `src/query.ts` | 核心模型请求与工具调用循环 |
| `src/QueryEngine.ts` | REPL 使用的高层 query 编排器 |
| `src/services/api/` | Anthropic 及第三方 provider 兼容层 |
| `src/services/tools/` | 工具执行、权限、hook、streaming executor |
| `packages/builtin-tools/` | 内置工具实现 |
| `src/trace/` | Harness Trace 核心实现与 CLI viewer |
| `src/commands/` | Slash command 实现 |
| `packages/remote-control-server/` | 自托管 Remote Control Server |
| `docs/features/` | 功能说明文档 |
| `docs/superpowers/` | 本地计划、规格和 review 文档 |

## 开发约束

- Runtime 使用 Bun，不按 Node-only 项目处理。
- TypeScript strict 必须保持零错误。
- 生产代码避免 `as any`；优先使用类型守卫、明确 interface 或
  `as unknown as SpecificType`。
- 不要重写 `feature()` 机制。
- 不要把 trace 数据注入模型消息、system prompt、用户上下文或工具输入。
- 不要提交构建产物、临时 trace 数据、个人工作目录或未确认的生成文件。
- 修改已有文件时尊重当前工作树中的用户改动，不做无关回滚。
- Commit message 使用 Conventional Commits，例如：

```text
feat: add harness trace viewer
fix: redact trace token secrets
docs: rewrite project readme
```

## 与上游项目的关系

本仓库保留了上游代码基础中的大量工程模块，但 README、测试策略和后续改动会以
当前 harness lab 目标为准。若发现上游遗留说明与当前目标冲突，以本 README、
`CLAUDE.md` / `AGENTS.md` 和仓库内最新计划文档为准。

## 免责声明

本项目仅用于学习、研究和本地工程验证。Claude Code 与相关商标、产品权利归
Anthropic 所有。本仓库不是 Anthropic 官方项目。

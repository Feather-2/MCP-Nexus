# MCP-Nexus

TypeScript MCP 协议网关平台，提供服务管理、智能路由、负载均衡、认证授权、Orchestrator 编排层。

## Tech Stack

- **Runtime**: Node.js 18+, TypeScript 5.6+ (strict mode)
- **Server**: Fastify 4.x + @fastify/cors + @fastify/helmet + @fastify/rate-limit
- **AI SDK**: Vercel AI SDK (@ai-sdk/*) 多模型支持
- **MCP**: @modelcontextprotocol/sdk 1.0
- **Observability**: OpenTelemetry + Pino logger
- **Testing**: Vitest (coverage: lines 25%, functions 50%, branches 60%)
- **GUI**: React 18 + Vite + Tailwind + shadcn/ui

## Module Index

| Module | Path | Description |
|--------|------|-------------|
| **core** | `src/core/CLAUDE.md` | MCP 协议栈、JSON-RPC 解析、进程状态管理 |
| **gateway** | `src/gateway/CLAUDE.md` | 服务注册、健康检查、负载均衡、熔断器 |
| **server** | `src/server/CLAUDE.md` | HTTP API 服务器、路由处理、SSE 管理 |
| **routing** | `src/routing/CLAUDE.md` | 智能路由、Radix Tree、复杂度分析 |
| **orchestrator** | `src/orchestrator/CLAUDE.md` | 任务编排引擎、子代理调度、规划系统 |
| **security** | `src/security/CLAUDE.md` | AI 审计、行为验证、Canary 系统 |
| **ai** | `src/ai/CLAUDE.md` | AI 客户端、负载均衡、成本追踪、限流 |
| **adapters** | `src/adapters/CLAUDE.md` | 多传输协议适配器 (Stdio/HTTP/Container) |
| **auth** | `src/auth/CLAUDE.md` | 认证层实现 |
| **bootstrap** | `src/bootstrap/CLAUDE.md` | 依赖注入容器、网关启动器 |
| **config** | `src/config/CLAUDE.md` | 配置管理、外部 MCP 导入 |
| **events** | `src/events/CLAUDE.md` | 事件总线、去重器 |
| **hooks** | `src/hooks/CLAUDE.md` | Hook 执行器 |
| **memory** | `src/memory/CLAUDE.md` | 内存存储、向量存储 |
| **message** | `src/message/CLAUDE.md` | 消息计数、修剪器 |
| **middleware** | `src/middleware/CLAUDE.md` | Auth/RateLimit/Security 中间件链 |
| **observability** | `src/observability/CLAUDE.md` | OpenTelemetry 集成 |
| **skills** | `src/skills/CLAUDE.md` | Skill 加载、匹配、审计 |
| **types** | `src/types/CLAUDE.md` | 类型定义 |
| **utils** | `src/utils/CLAUDE.md` | Logger、ErrorHandler、异步工具 |

## Commands

```bash
npm run dev          # 开发服务器 (tsx watch)
npm run build        # TypeScript 编译
npm run test         # Vitest 测试
npm run test:coverage # 带覆盖率测试
npm run lint         # ESLint 检查
npm run typecheck    # tsc --noEmit
npm run gui          # 启动 GUI 服务器
```

## Conventions

- 使用 `pino` logger，禁止 `console.log`
- 错误处理使用 `{ cause }` 保留原始错误
- 新功能需配套 `*.test.ts` 测试文件
- 模块导出通过 `index.ts` 统一管理

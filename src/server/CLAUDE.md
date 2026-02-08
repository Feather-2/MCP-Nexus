# Server Module

HTTP API 服务器，基于 Fastify 实现。

## Structure

```
server/
├── HttpApiServer.ts      # 主服务器类
├── LogBuffer.ts          # 日志缓冲
├── SseManager.ts         # SSE 连接管理
├── handlers/             # 请求处理器
├── routes/               # 路由定义
│   ├── index.ts
│   ├── ServiceRoutes.ts
│   ├── AuthRoutes.ts
│   ├── ConfigRoutes.ts
│   ├── TemplateRoutes.ts
│   ├── MonitoringRoutes.ts
│   ├── OrchestratorRoutes.ts
│   ├── ToolRoutes.ts
│   ├── SkillRoutes.ts
│   └── ...
└── utils/
```

## Key Components

### HttpApiServer

Fastify 服务器，集成：
- `@fastify/cors` - CORS 支持
- `@fastify/helmet` - 安全头
- `@fastify/static` - 静态文件 (GUI)
- OpenTelemetry tracing
- 健康检查：`/health`、`/api/health`（快速）与 `/health/detailed`（详细）

注入依赖：
- `ServiceRegistryImpl`
- `AuthenticationLayerImpl`
- `GatewayRouterImpl`
- `ProtocolAdaptersImpl`
- `OrchestratorManager`

### RouteContext / BaseRouteHandler

路由基类，提供：
- `respondOk/respondError` - 统一响应格式
- `writeSseHeaders` - SSE Header + CORS 反射（避免通配符）

### Routes

| Route Module | Prefix | Description |
|--------------|--------|-------------|
| ServiceRoutes | `/api/services` | 服务实例管理 |
| AuthRoutes | `/api/auth` | 认证 API |
| ConfigRoutes | `/api/config` | 配置管理 |
| TemplateRoutes | `/api/templates` | 模板 CRUD |
| MonitoringRoutes | `/api/monitoring` | 监控指标 |
| OrchestratorRoutes | `/api/orchestrator` | 编排器 API |
| ToolRoutes | `/api/tools` | 工具执行 |
| SkillRoutes | `/api/skills` | Skill 加载/匹配/审核/授权/分发 |
| RoutingRoutes | `/api/route`, `/mcp`, `/events` | 路由、MCP JSON-RPC 转发、SSE 通知 |
| LocalMcpProxyRoutes | `/call`, `/tools` | 本地 MCP 代理（handshake 认证） |
| LogRoutes | `/api/logs` | 日志查询与 SSE 实时推送 |
| SandboxRoutes | `/api/sandbox` | 沙盒检查与安装 |
| ExternalImportRoutes | `/api/import` | 外部 MCP 配置导入 |

### SseManager

管理 Server-Sent Events 连接，支持实时日志推送。

## Middleware Chain

请求经过 `MiddlewareChain` 处理：
1. `AuthMiddleware` - 认证检查
2. `RateLimitMiddleware` - 限流
3. `SecurityMiddleware` - 安全检查

## Common Tasks

```typescript
// 启动服务器
const server = new HttpApiServer(config, logger);
await server.start();

// 注册自定义路由
server.fastify.register(myRoutes, { prefix: '/api/custom' });
```

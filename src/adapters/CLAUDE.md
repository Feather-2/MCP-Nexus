# Adapters Module

多传输协议适配器，支持 Stdio、HTTP 和容器通信。

## Files

| File | Description |
|------|-------------|
| `ProtocolAdaptersImpl.ts` | 适配器工厂和管理器 |
| `StdioTransportAdapter.ts` | Stdio 传输 (本地进程) |
| `HttpTransportAdapter.ts` | HTTP 传输 |
| `StreamableHttpAdapter.ts` | Streamable HTTP (SSE) |
| `ContainerTransportAdapter.ts` | 容器传输 (Docker/Podman) + 运行时加固参数 |

## Protocol Types

| Transport | Use Case | Protocol |
|-----------|----------|----------|
| `stdio` | 本地进程 | stdin/stdout JSON-RPC |
| `http` | RESTful API | HTTP POST |
| `streamable-http` | 实时流 | HTTP + SSE |
| `container` | Docker 服务 | 容器内 stdio |

## Key Classes

### ProtocolAdaptersImpl

适配器工厂：
- `getAdapter(transport)` - 获取适配器实例
- `createConnection(config)` - 创建连接

### StdioTransportAdapter

本地进程通信：
- 使用 `child_process.spawn`
- JSON-RPC over stdin/stdout
- 支持进程生命周期管理

### StreamableHttpAdapter

SSE 流式传输：
- Server-Sent Events
- 实时数据推送

### ContainerTransportAdapter

容器内 stdio 通信，负责拼装运行时参数（`docker run`/`podman run`），并支持安全加固默认值（策略默认值可由 `src/security/SandboxPolicy.ts` 归一化得到）：
- `--pids-limit`（`resources.pidsLimit` 或策略 `defaultPidsLimit`）
- `--security-opt no-new-privileges:true`（默认启用，可被显式关闭）
- `--security-opt seccomp=...`（可选）
- `--cap-drop ...`（`dropCapabilities` 或策略 `defaultDropCapabilities`）

## Common Tasks

```typescript
// 获取适配器
const adapter = adapters.getAdapter('stdio');

// 发送消息
const response = await adapter.send({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'my-tool', arguments: {} }
});
```

# Core Module

MCP 协议栈核心实现，处理 JSON-RPC 通信和服务进程管理。

## Files

| File | Description |
|------|-------------|
| `McpProtocolStackImpl.ts` | MCP 协议栈主实现，管理服务实例和子进程通信 |
| `ProcessStateManager.ts` | 服务状态管理，支持状态转换验证和历史记录 |
| `McpProtocolHandshaker.ts` | MCP 协议握手逻辑 |
| `JsonRpcStreamParser.ts` | JSON-RPC 流式解析器 |

## Key Classes

### McpProtocolStackImpl

管理 MCP 服务实例的核心类：
- `sendMessage(serviceId, message)` - 通过 stdin 发送消息
- `waitForResponse(serviceId, messageId)` - 等待响应
- 维护 `instances` 和 `processes` Map

### ProcessStateManager

服务状态机：
- 支持状态转换验证 (`isValidTransition`)
- 保留最近 10 条状态历史
- 状态类型：`starting`, `running`, `stopped`, `error`

## Dependencies

- `child_process` - 子进程管理
- `../types/index.js` - 类型定义
- `../utils/ErrorHandler.js` - 统一错误处理

## Common Tasks

```typescript
// 发送 MCP 消息
await protocolStack.sendMessage('service-id', {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/list'
});

// 检查服务状态
const state = stateManager.getState('service-id');
```

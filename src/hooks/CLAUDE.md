# Hooks Module

Hook 执行器。

## Files

| File | Description |
|------|-------------|
| `executor.ts` | Hook 执行器 |
| `types.ts` | Hook 类型定义 |
| `index.ts` | 导出 |

## Hook Types

- `PreToolUse` - 工具调用前
- `PostToolUse` - 工具调用后
- `PreRequest` - 请求前
- `PostResponse` - 响应后

## Usage

```typescript
const executor = new HookExecutor(config);
await executor.run('PostToolUse', context);
```

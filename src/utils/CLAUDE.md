# Utils Module

工具函数和日志实现。

## Files

| File | Description |
|------|-------------|
| `PinoLogger.ts` | Pino 日志实现 (生产) |
| `ConsoleLogger.ts` | Console 日志 (开发) |
| `SimpleLogger.ts` | 简易日志 |
| `ErrorHandler.ts` | 统一错误处理 |
| `async.ts` | 异步工具函数 |

## Logging

项目使用 Pino 作为生产日志：

```typescript
import { createPinoLogger } from './PinoLogger.js';

const logger = createPinoLogger({ level: 'info' });
logger.info('Message');
logger.error({ err }, 'Error occurred');
```

## ErrorHandler

统一错误处理：
- 错误分类
- 错误上下文记录
- 错误恢复策略

## Async Utils

- `retry(fn, options)` - 重试
- `timeout(promise, ms)` - 超时
- `debounce(fn, ms)` - 防抖

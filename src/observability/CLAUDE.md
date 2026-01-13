# Observability Module

OpenTelemetry 集成。

## Files

| File | Description |
|------|-------------|
| `otel.ts` | OpenTelemetry 初始化 |
| `trace.ts` | Trace 工具函数 |

## Features

- 分布式追踪
- Span 创建和传播
- OTLP 导出

## Usage

```typescript
import { createTraceId, enterTrace } from './trace.js';

const traceId = createTraceId();
await enterTrace('operation-name', async (span) => {
  // 业务逻辑
});
```

## Configuration

通过环境变量配置：
- `OTEL_EXPORTER_OTLP_ENDPOINT`
- `OTEL_SERVICE_NAME`

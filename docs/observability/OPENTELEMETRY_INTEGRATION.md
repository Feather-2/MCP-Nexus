# OpenTelemetry Integration Guide

**Version**: 1.0.0
**Last Updated**: 2026-02-14

本指南说明如何将 MCP-Nexus 的可观测性事件集成到 OpenTelemetry。

## 架构概览

```
EventBus → EventLogger → OpenTelemetry Exporter → Backend (Jaeger/Tempo/etc)
    ↓
ErrorEnvelope → Span Events → Trace Context
```

## 基础集成

### 1. 安装依赖

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node
```

### 2. 初始化 Tracer

```typescript
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: 'http://localhost:4318/v1/traces',
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
```

### 3. EventBus 集成

订阅关键事件并转换为 Span：

```typescript
import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('mcp-nexus');

// 订阅 Orchestrator 执行事件
eventBus.subscribe('orchestrator:execute:start', (event) => {
  const { runId, stepsCount } = event.payload as ExecuteStartPayload;

  const span = tracer.startSpan('orchestrator.execute', {
    attributes: {
      'run.id': runId,
      'steps.count': stepsCount,
      'component': 'OrchestratorEngine',
    },
  });

  // 存储 span 以便后续结束
  spanRegistry.set(runId, span);
});

eventBus.subscribe('orchestrator:execute:end', (event) => {
  const { runId, success, durationMs, stepsExecuted } = event.payload as ExecuteEndPayload;

  const span = spanRegistry.get(runId);
  if (span) {
    span.setAttributes({
      'steps.executed': stepsExecuted,
      'duration.ms': durationMs,
    });
    span.setStatus({
      code: success ? SpanStatusCode.OK : SpanStatusCode.ERROR,
    });
    span.end();
    spanRegistry.delete(runId);
  }
});
```

## 分布式追踪

### runId 与 traceId 映射

```typescript
import { context, propagation } from '@opentelemetry/api';

// 在 OrchestratorEngine.execute() 中注入 traceId
const span = tracer.startSpan('orchestrator.execute');
const traceId = span.spanContext().traceId;

// 将 traceId 传递给所有子事件
eventBus.publish({
  type: 'orchestrator:step:start',
  payload: { runId, stepId },
  traceId,  // 注入 traceId
});
```

### 跨边界传播

使用 W3C Trace Context 在主线程 ↔ Worker 之间传播：

```typescript
// 主线程：序列化 context
const carrier = {};
propagation.inject(context.active(), carrier);

worker.postMessage({
  type: 'execute',
  traceContext: carrier,
});

// Worker：反序列化 context
const ctx = propagation.extract(context.active(), message.traceContext);
context.with(ctx, () => {
  // 在此上下文中执行操作
});
```

## ErrorEnvelope 集成

将 ErrorEnvelope 转换为 Span Exception：

```typescript
eventBus.subscribe('orchestrator:step:error', (event) => {
  const { runId, stepId, error } = event.payload as StepErrorPayload;

  const span = spanRegistry.get(runId);
  if (span) {
    // 记录异常
    span.recordException({
      name: error.name || 'Error',
      message: error.message || error,
      stack: error.stack,
    });

    // 如果有 ErrorEnvelope，添加更多上下文
    if (error.errorEnvelope) {
      span.setAttributes({
        'error.code': error.errorEnvelope.code,
        'error.fingerprint': error.errorEnvelope.fingerprint,
        'error.category': error.errorEnvelope.category,
        'error.severity': error.errorEnvelope.severity,
        'error.recoverable': error.errorEnvelope.recoverable,
        'error.boundary': error.errorEnvelope.context.boundary,
      });
    }
  }
});
```

## LLM 调用追踪

```typescript
const aiAuditor = new AiAuditor(client, {
  onLlmCall: (evt) => {
    const span = tracer.startSpan('llm.call', {
      attributes: {
        'llm.operation': evt.operation,
        'llm.model': evt.model,
        'llm.max_tokens': evt.maxTokens,
      },
    });

    span.setAttributes({
      'llm.duration_ms': evt.durationMs,
      'llm.success': evt.success,
    });

    if (!evt.success) {
      span.recordException(new Error(evt.error));
      span.setStatus({ code: SpanStatusCode.ERROR });
    }

    span.end();
  },
});
```

## EventBus 治理指标

将治理事件转换为 Metrics：

```typescript
import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('mcp-nexus');
const backpressureDrops = meter.createCounter('eventbus.backpressure.drops');
const bufferDrops = meter.createCounter('eventbus.buffer.drops');
const handlerErrors = meter.createCounter('eventbus.handler.errors');

eventBus.subscribe('eventbus:backpressure:drop', (event) => {
  const { droppedEventType, queueDepth } = event.payload as BackpressureDropPayload;
  backpressureDrops.add(1, {
    'event.type': droppedEventType,
    'queue.depth': queueDepth,
  });
});

eventBus.subscribe('eventbus:buffer:drop', (event) => {
  const { droppedEventType, subscriberId } = event.payload as BufferDropPayload;
  bufferDrops.add(1, {
    'event.type': droppedEventType,
    'subscriber.id': subscriberId,
  });
});

eventBus.subscribe('eventbus:handler:error', (event) => {
  const { eventType, error } = event.payload as HandlerErrorPayload;
  handlerErrors.add(1, {
    'event.type': eventType,
    'error.name': error.name,
  });
});
```

## 完整示例

```typescript
import { EventBus } from './events/bus.js';
import { OrchestratorEngine } from './orchestrator/OrchestratorEngine.js';
import { setupOpenTelemetry } from './observability/otel.js';

// 初始化 OpenTelemetry
const { tracer, meter } = setupOpenTelemetry({
  serviceName: 'mcp-nexus',
  endpoint: 'http://localhost:4318',
});

// 创建 EventBus
const eventBus = new EventBus({ queueDepth: 1024, bufferSize: 128 });

// 集成 Orchestrator 追踪
setupOrchestratorTracing(eventBus, tracer);

// 集成 EventBus 指标
setupEventBusMetrics(eventBus, meter);

// 创建 OrchestratorEngine（自动注入 eventBus）
const engine = new OrchestratorEngine({
  logger,
  serviceRegistry,
  protocolAdapters,
  orchestratorManager,
  subagentLoader,
  eventBus,  // 传入 eventBus
});

// 执行编排（自动生成 traces）
const result = await engine.execute({ steps: [...] });
```

## 最佳实践

1. **Span 命名**: 使用 `component.operation` 格式（如 `orchestrator.execute`）
2. **Attribute 命名**: 使用 `.` 分隔命名空间（如 `run.id`, `error.code`）
3. **Span 生命周期**: 确保所有 span 都正确结束，避免泄漏
4. **采样策略**: 生产环境使用采样以降低开销（如 10% 采样率）
5. **Context 传播**: 跨边界时始终传播 trace context

## 故障排查

### Span 未出现在后端

- 检查 exporter endpoint 是否正确
- 确认 SDK 已正确初始化（`sdk.start()`）
- 验证 span 是否调用了 `end()`

### TraceId 不连续

- 确认跨边界时正确传播了 context
- 检查 Worker 是否正确反序列化 trace context

### 性能开销过大

- 启用采样（如 `ParentBasedSampler` + `TraceIdRatioBasedSampler`）
- 减少 attribute 数量
- 使用批量导出（`BatchSpanProcessor`）

## 参考资源

- [OpenTelemetry JavaScript SDK](https://opentelemetry.io/docs/languages/js/)
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)
- [Event Dictionary](./EVENT_DICTIONARY.md)

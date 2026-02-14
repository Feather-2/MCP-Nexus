# Event Dictionary

**Version**: 1.0.0
**Last Updated**: 2026-02-14

本文档记录 MCP-Nexus 可观测性事件的完整 schema 和语义。

## Event Metadata

所有事件继承基础元数据：

```typescript
interface Event {
  id?: string;
  type: EventType;
  version?: string;
  timestamp?: Date;
  sessionId?: string;
  payload?: unknown;
  // 可观测性字段
  runId?: string;        // 执行链路 ID
  traceId?: string;      // 分布式追踪 ID
  stage?: string;        // 执行阶段
  component?: string;    // 组件名称
  metadata?: Record<string, unknown>;
}
```

## EventBus 治理事件

### `eventbus:backpressure:drop`

**触发条件**: 队列满时丢弃事件

```typescript
interface BackpressureDropPayload {
  droppedEventId: string;
  droppedEventType: string;
  queueDepth: number;
  reason: 'queue_full';
}
```

### `eventbus:buffer:drop`

**触发条件**: 订阅者缓冲区满时丢弃事件

```typescript
interface BufferDropPayload {
  droppedEventId: string;
  droppedEventType: string;
  subscriberId: number;
  bufferSize: number;
  reason: 'buffer_full';
}
```

### `eventbus:handler:error`

**触发条件**: 事件处理器抛出异常

```typescript
interface HandlerErrorPayload {
  subscriberId: number;
  eventId: string;
  eventType: string;
  error: {
    name: string;
    message: string;
    stack?: string;
  };
}
```

### `eventbus:handler:timeout`

**触发条件**: 事件处理器超时

```typescript
interface HandlerTimeoutPayload {
  subscriberId: number;
  eventId: string;
  eventType: string;
  timeoutMs: number;
}
```

### `eventbus:logger:error`

**触发条件**: EventLogger 持久化失败

```typescript
interface LoggerErrorPayload {
  eventId: string;
  eventType: string;
  error: {
    name: string;
    message: string;
  };
}
```

### `eventbus:persistence:error`

**触发条件**: 事件持久化操作失败

```typescript
interface PersistenceErrorPayload {
  eventId: string;
  eventType: string;
  operation: 'insert' | 'query';
  error: {
    name: string;
    message: string;
  };
}
```

## OrchestratorEngine 生命周期事件

### `orchestrator:execute:start`

**触发条件**: 编排执行开始

```typescript
interface ExecuteStartPayload {
  runId: string;
  stepsCount: number;
}
```

### `orchestrator:execute:end`

**触发条件**: 编排执行结束

```typescript
interface ExecuteEndPayload {
  runId: string;
  success: boolean;
  durationMs: number;
  stepsExecuted: number;
}
```

### `orchestrator:execute:error`

**触发条件**: 编排执行失败

```typescript
interface ExecuteErrorPayload {
  runId: string;
  error: string;
  durationMs: number;
}
```

### `orchestrator:plan:start`

**触发条件**: 规划阶段开始

```typescript
interface PlanStartPayload {
  runId: string;
}
```

### `orchestrator:plan:end`

**触发条件**: 规划阶段结束

```typescript
interface PlanEndPayload {
  runId: string;
  stepsPlanned: number;
}
```

### `orchestrator:step:start`

**触发条件**: 单步执行开始

```typescript
interface StepStartPayload {
  runId: string;
  stepId: string;
  template?: string;
  subagent?: string;
}
```

### `orchestrator:step:end`

**触发条件**: 单步执行成功

```typescript
interface StepEndPayload {
  runId: string;
  stepId: string;
  durationMs: number;
}
```

### `orchestrator:step:error`

**触发条件**: 单步执行失败

```typescript
interface StepErrorPayload {
  runId: string;
  stepId: string;
  error: string;
  durationMs: number;
}
```

## SubagentScheduler 信号量事件

### `scheduler:semaphore:acquire`

**触发条件**: 信号量获取成功

```typescript
interface SemaphoreAcquirePayload {
  semaphoreId: string;
  available: number;
}
```

### `scheduler:semaphore:wait`

**触发条件**: 信号量等待

```typescript
interface SemaphoreWaitPayload {
  semaphoreId: string;
  available: number;
}
```

### `scheduler:semaphore:release`

**触发条件**: 信号量释放

```typescript
interface SemaphoreReleasePayload {
  semaphoreId: string;
  available: number;
}
```

## AiAuditor LLM 调用事件

**触发方式**: 通过 `onLlmCall` 回调

```typescript
interface LlmCallEvent {
  operation: string;      // 操作名称（如 'auditSkill'）
  model?: string;         // 模型名称
  maxTokens: number;      // 最大 token 数
  durationMs: number;     // 调用耗时
  success: boolean;       // 是否成功
  error?: string;         // 错误信息（失败时）
}
```

## 错误信封 (ErrorEnvelope)

跨边界错误传播的统一结构：

```typescript
interface ErrorEnvelope {
  code: string;                    // 错误代码
  fingerprint: string;             // 错误指纹（用于聚合）
  message: string;
  name: string;
  stack?: string;
  cause?: ErrorEnvelope;           // 原因链
  category: ErrorCategory;         // 错误分类
  severity: ErrorSeverity;         // 严重程度
  recoverable: boolean;            // 是否可恢复
  context: ErrorContext;           // 上下文信息
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

interface ErrorContext {
  runId?: string;
  traceId?: string;
  stage?: string;
  component?: string;
  operation?: string;
  serviceId?: string;
  serviceName?: string;
  boundary?: 'main' | 'worker' | 'stage' | 'tool' | 'external';
  boundaryStack?: string[];        // 边界穿越栈
  [key: string]: unknown;
}
```

## 使用指南

### 订阅事件

```typescript
eventBus.subscribe('orchestrator:execute:start', (event) => {
  const { runId, stepsCount } = event.payload as ExecuteStartPayload;
  console.log(`Execution ${runId} started with ${stepsCount} steps`);
});
```

### 追踪执行链路

通过 `runId` 关联所有相关事件：

```typescript
const events = await eventLogger.query({
  filter: (e) => e.runId === targetRunId,
  sort: 'timestamp'
});
```

### 错误关联

通过 `ErrorEnvelope.cause` 链追踪错误传播路径：

```typescript
function printErrorChain(envelope: ErrorEnvelope, depth = 0) {
  console.log('  '.repeat(depth) + `${envelope.name}: ${envelope.message}`);
  if (envelope.cause) printErrorChain(envelope.cause, depth + 1);
}
```

## 版本历史

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-02-14 | 初始版本：EventBus 治理、Orchestrator 生命周期、AiAuditor LLM 可观测 |

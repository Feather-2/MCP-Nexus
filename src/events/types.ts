export type EventType = string;
export const DEFAULT_EVENT_VERSION = '1.0';

export interface Event {
  id?: string; // 自动生成
  type: EventType;
  version?: string; // 默认 1.0
  timestamp?: Date; // 自动填充
  sessionId?: string;
  payload?: unknown;

  // 可观测性元数据
  runId?: string; // 端到端追踪 ID
  traceId?: string; // 分布式追踪 ID
  stage?: string; // 执行阶段（如 tool, orchestrator, worker）
  component?: string; // 组件名称
  metadata?: Record<string, unknown>; // 扩展元数据
}

export type EventHandler = (event: Event) => void | Promise<void>;

export interface SubscriptionOptions {
  timeout?: number; // 单个 handler 超时 (ms)
}

// EventBus 内部治理事件类型
export const EventBusEvents = {
  BACKPRESSURE_DROP: 'eventbus:backpressure:drop',
  BUFFER_DROP: 'eventbus:buffer:drop',
  HANDLER_ERROR: 'eventbus:handler:error',
  HANDLER_TIMEOUT: 'eventbus:handler:timeout',
  LOGGER_ERROR: 'eventbus:logger:error',
} as const;

// 背压丢弃事件 payload
export interface BackpressureDropPayload {
  droppedEventId: string;
  droppedEventType: string;
  queueDepth: number;
  reason: 'queue_full';
}

// 缓冲区丢弃事件 payload
export interface BufferDropPayload {
  droppedEventId: string;
  droppedEventType: string;
  subscriberId: number;
  bufferSize: number;
  reason: 'buffer_full';
}

// Handler 错误事件 payload
export interface HandlerErrorPayload {
  subscriberId: number;
  eventId: string;
  eventType: string;
  error: {
    name: string;
    message: string;
    stack?: string;
  };
}

// Handler 超时事件 payload
export interface HandlerTimeoutPayload {
  subscriberId: number;
  eventId: string;
  eventType: string;
  timeoutMs: number;
}

// Logger 错误事件 payload
export interface LoggerErrorPayload {
  eventId: string;
  eventType: string;
  error: {
    name: string;
    message: string;
  };
}

// 持久化失败事件 payload
export interface PersistenceErrorPayload {
  eventId: string;
  eventType: string;
  operation: 'insert' | 'query';
  error: {
    name: string;
    message: string;
  };
}

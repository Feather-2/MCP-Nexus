export type EventType = string;
export const DEFAULT_EVENT_VERSION = '1.0';

export interface Event {
  id?: string; // 自动生成
  type: EventType;
  version?: string; // 默认 1.0
  timestamp?: Date; // 自动填充
  sessionId?: string;
  payload?: unknown;
}

export type EventHandler = (event: Event) => void | Promise<void>;

export interface SubscriptionOptions {
  timeout?: number; // 单个 handler 超时 (ms)
}

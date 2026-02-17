import type { EventLogger, LoggedEvent } from '../events/EventLogger.js';
import type { EventType } from '../events/types.js';

export interface ReplayFilters {
  runId?: string;
  type?: EventType;
  sessionId?: string;
  from?: Date;
  to?: Date;
}

export interface ReplayOptions {
  filters?: ReplayFilters;
  limit?: number;
  onEvent?: (event: LoggedEvent, index: number, total: number) => void;
}

export class EventReplayer {
  constructor(private readonly logger: EventLogger) {}

  replay(options?: ReplayOptions): LoggedEvent[] {
    if (!this.logger.isEnabled()) return [];

    const events = this.logger.query({
      type: options?.filters?.type,
      sessionId: options?.filters?.sessionId,
      from: options?.filters?.from,
      to: options?.filters?.to,
      limit: options?.limit ?? 1000
    });

    // EventLogger 返回降序，反转为升序回放
    const ascending = events.reverse();

    // 按 runId 过滤（从 payload 或 metadata 中读取）
    const filtered = options?.filters?.runId
      ? ascending.filter((e) => {
          const payload = e.payload as Record<string, unknown> | undefined;
          return payload?.runId === options.filters!.runId || e.runId === options.filters!.runId;
        })
      : ascending;

    // 回放事件
    if (options?.onEvent) {
      filtered.forEach((event, index) => {
        options.onEvent!(event, index, filtered.length);
      });
    }

    return filtered;
  }

  replayByRunId(runId: string, options?: Omit<ReplayOptions, 'filters'>): LoggedEvent[] {
    return this.replay({
      ...options,
      filters: { runId }
    });
  }
}

import type { Logger } from '../types/index.js';
import type { OrchestratorStep } from './types.js';
import { toErrorEnvelope, propagateError, type ErrorEnvelope } from '../types/errors.js';
import type { EventBus } from '../events/bus.js';
import { unrefTimer } from '../utils/async.js';

export interface SchedulerConcurrency {
  global: number;
  perSubagent: number;
}

export interface SchedulerOptions {
  concurrency: SchedulerConcurrency;
  /**
   * Default per-step timeout, used when step.timeoutMs is not provided.
   */
  defaultStepTimeoutMs: number;
  /**
   * Stop scheduling new work after overall timeout.
   */
  overallTimeoutMs: number;
  /**
   * Optional EventBus for emitting observability events
   */
  eventBus?: EventBus;
}

export interface StepResult {
  step: OrchestratorStep;
  ok: boolean;
  response?: unknown;
  error?: string;
  errorEnvelope?: ErrorEnvelope; // 结构化错误信息
  durationMs: number;
}

class AsyncSemaphore {
  private inUse = 0;
  private readonly waiters: Array<(release: () => void) => void> = [];

  constructor(
    private readonly capacity: number,
    private readonly eventBus?: EventBus,
    private readonly semaphoreId?: string
  ) {}

  async acquire(): Promise<() => void> {
    if (this.capacity <= 0) {
      return () => {};
    }
    if (this.inUse < this.capacity) {
      this.inUse += 1;
      this.emitAcquireEvent();
      return () => this.release();
    }

    this.emitWaitEvent();
    return new Promise<() => void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Keep inUse unchanged: transfer the slot to the next waiter.
      next(() => this.release());
      return;
    }
    this.inUse = Math.max(0, this.inUse - 1);
    this.emitReleaseEvent();
  }

  private emitAcquireEvent(): void {
    if (!this.eventBus) return;
    this.eventBus.publish({
      type: 'orchestrator:semaphore:acquire',
      component: 'AsyncSemaphore',
      stage: 'orchestrator',
      payload: {
        semaphoreId: this.semaphoreId || 'unknown',
        inUse: this.inUse,
        capacity: this.capacity,
        waiters: this.waiters.length
      }
    });
  }

  private emitWaitEvent(): void {
    if (!this.eventBus) return;
    this.eventBus.publish({
      type: 'orchestrator:semaphore:wait',
      component: 'AsyncSemaphore',
      stage: 'orchestrator',
      payload: {
        semaphoreId: this.semaphoreId || 'unknown',
        inUse: this.inUse,
        capacity: this.capacity,
        waiters: this.waiters.length + 1
      }
    });
  }

  private emitReleaseEvent(): void {
    if (!this.eventBus) return;
    this.eventBus.publish({
      type: 'orchestrator:semaphore:release',
      component: 'AsyncSemaphore',
      stage: 'orchestrator',
      payload: {
        semaphoreId: this.semaphoreId || 'unknown',
        inUse: this.inUse,
        capacity: this.capacity,
        waiters: this.waiters.length
      }
    });
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // Avoid keeping the process alive solely for timers (tests/CLI).
    unrefTimer(timer);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class SubagentScheduler {
  private readonly globalSem: AsyncSemaphore;
  private readonly perSem = new Map<string, AsyncSemaphore>();
  private readonly eventBus?: EventBus;

  constructor(private readonly logger: Logger, private readonly opts: SchedulerOptions) {
    const global = Math.max(1, Math.floor(opts.concurrency.global || 1));
    const per = Math.max(1, Math.floor(opts.concurrency.perSubagent || 1));
    this.eventBus = opts.eventBus;
    this.globalSem = new AsyncSemaphore(global, this.eventBus, 'global');
    // Per-subagent semaphores are created lazily; default capacity is `per`.
    this.perSem.set('__default__', new AsyncSemaphore(per, this.eventBus, '__default__'));
  }

  async run(
    steps: OrchestratorStep[],
    runner: (step: OrchestratorStep) => Promise<unknown>,
    options?: { parallel?: boolean }
  ): Promise<StepResult[]> {
    const startedAt = Date.now();
    const parallel = Boolean(options?.parallel);

    if (!parallel) {
      const results: StepResult[] = [];
      for (const step of steps) {
        if (Date.now() - startedAt > this.opts.overallTimeoutMs) {
          const stepId = step.subagent || step.template || 'unknown';
          const envelope = toErrorEnvelope(
            new Error('time budget exceeded'),
            {
              runId: stepId,
              stage: 'orchestrator',
              component: 'SubagentScheduler',
              operation: 'run',
              boundary: 'main'
            },
            {
              code: 'TIMEOUT_BUDGET_EXCEEDED',
              category: 'timeout',
              severity: 'high',
              recoverable: false
            }
          );
          results.push({ step, ok: false, error: 'time budget exceeded', errorEnvelope: envelope, durationMs: 0 });
          break;
        }
        results.push(await this.runOne(step, runner, startedAt));
      }
      return results;
    }

    // Parallel scheduling with global + per-subagent concurrency.
    const tasks = steps.map((step) => this.runOne(step, runner, startedAt));
    return Promise.all(tasks);
  }

  private async runOne(
    step: OrchestratorStep,
    runner: (step: OrchestratorStep) => Promise<unknown>,
    startedAt: number
  ): Promise<StepResult> {
    const stepId = step.subagent || step.template || 'unknown';

    if (Date.now() - startedAt > this.opts.overallTimeoutMs) {
      const envelope = toErrorEnvelope(
        new Error('time budget exceeded'),
        {
          runId: stepId,
          stage: 'orchestrator',
          component: 'SubagentScheduler',
          operation: 'runOne',
          boundary: 'main'
        },
        {
          code: 'TIMEOUT_BUDGET_EXCEEDED',
          category: 'timeout',
          severity: 'high',
          recoverable: false
        }
      );
      return { step, ok: false, error: 'time budget exceeded', errorEnvelope: envelope, durationMs: 0 };
    }

    const subagentKey = (step.subagent || step.template || '__default__').toString();
    const perLimit = this.getPerSemaphore(subagentKey);

    // Acquire in a consistent order to avoid deadlocks and prevent consuming global slots
    // while waiting for a per-subagent slot.
    const releasePer = await perLimit.acquire();
    const releaseGlobal = await this.globalSem.acquire();

    const t0 = Date.now();
    try {
      const retries = Math.max(0, Math.min(5, Number(step.retries ?? 0)));
      const timeoutMs = Number(step.timeoutMs ?? this.opts.defaultStepTimeoutMs);

      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const value = await withTimeout(runner(step), timeoutMs, `step(${subagentKey})`);
          return { step, ok: true, response: value, durationMs: Date.now() - t0 };
        } catch (e: any) {
          const msg = e?.message || String(e);

          // 创建错误 envelope
          const envelope = toErrorEnvelope(
            e,
            {
              runId: stepId,
              stage: 'orchestrator',
              component: 'SubagentScheduler',
              operation: 'runOne',
              serviceId: subagentKey,
              boundary: 'main',
              metadata: {
                attempt: attempt + 1,
                maxRetries: retries,
                timeoutMs
              }
            }
          );

          if (attempt >= retries) {
            return { step, ok: false, error: msg, errorEnvelope: envelope, durationMs: Date.now() - t0 };
          }
          try { this.logger.warn('Step failed, retrying', { subagent: subagentKey, attempt: attempt + 1, error: msg, fingerprint: envelope.fingerprint }); } catch {}
        }
      }

      const envelope = toErrorEnvelope(
        new Error('unknown failure'),
        {
          runId: stepId,
          stage: 'orchestrator',
          component: 'SubagentScheduler',
          operation: 'runOne',
          serviceId: subagentKey,
          boundary: 'main'
        },
        {
          code: 'UNKNOWN_FAILURE',
          category: 'internal',
          severity: 'high',
          recoverable: false
        }
      );
      return { step, ok: false, error: 'unknown failure', errorEnvelope: envelope, durationMs: Date.now() - t0 };
    } finally {
      try { releaseGlobal(); } catch {}
      try { releasePer(); } catch {}
    }
  }

  private getPerSemaphore(key: string): AsyncSemaphore {
    const existing = this.perSem.get(key);
    if (existing) return existing;
    const per = Math.max(1, Math.floor(this.opts.concurrency.perSubagent || 1));
    const sem = new AsyncSemaphore(per, this.eventBus, key);
    this.perSem.set(key, sem);
    return sem;
  }
}

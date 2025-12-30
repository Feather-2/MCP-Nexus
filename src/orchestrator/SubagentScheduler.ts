import type { Logger } from '../types/index.js';
import type { OrchestratorStep } from './types.js';

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
}

export interface StepResult {
  step: OrchestratorStep;
  ok: boolean;
  response?: unknown;
  error?: string;
  durationMs: number;
}

class AsyncSemaphore {
  private inUse = 0;
  private readonly waiters: Array<(release: () => void) => void> = [];

  constructor(private readonly capacity: number) {}

  async acquire(): Promise<() => void> {
    if (this.capacity <= 0) {
      return () => {};
    }
    if (this.inUse < this.capacity) {
      this.inUse += 1;
      return () => this.release();
    }
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
    (timer as any).unref?.();
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

  constructor(private readonly logger: Logger, private readonly opts: SchedulerOptions) {
    const global = Math.max(1, Math.floor(opts.concurrency.global || 1));
    const per = Math.max(1, Math.floor(opts.concurrency.perSubagent || 1));
    this.globalSem = new AsyncSemaphore(global);
    // Per-subagent semaphores are created lazily; default capacity is `per`.
    this.perSem.set('__default__', new AsyncSemaphore(per));
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
          results.push({ step, ok: false, error: 'time budget exceeded', durationMs: 0 });
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
    if (Date.now() - startedAt > this.opts.overallTimeoutMs) {
      return { step, ok: false, error: 'time budget exceeded', durationMs: 0 };
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
          if (attempt >= retries) {
            return { step, ok: false, error: msg, durationMs: Date.now() - t0 };
          }
          try { this.logger.warn('Step failed, retrying', { subagent: subagentKey, attempt: attempt + 1, error: msg }); } catch {}
        }
      }

      return { step, ok: false, error: 'unknown failure', durationMs: Date.now() - t0 };
    } finally {
      try { releaseGlobal(); } catch {}
      try { releasePer(); } catch {}
    }
  }

  private getPerSemaphore(key: string): AsyncSemaphore {
    const existing = this.perSem.get(key);
    if (existing) return existing;
    const per = Math.max(1, Math.floor(this.opts.concurrency.perSubagent || 1));
    const sem = new AsyncSemaphore(per);
    this.perSem.set(key, sem);
    return sem;
  }
}

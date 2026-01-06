import type { Context, Middleware, Stage, State } from './types.js';

export const STAGES: readonly Stage[] = [
  'beforeAgent',
  'beforeModel',
  'afterModel',
  'beforeTool',
  'afterTool',
  'afterAgent'
];

export type StageTimeoutMs = Partial<Record<Stage, number>>;

export interface MiddlewareChainOptions {
  defaultTimeoutMs?: number;
  stageTimeoutMs?: StageTimeoutMs;
}

export class MiddlewareTimeoutError extends Error {
  readonly stage: Stage;
  readonly middlewareName: string;
  readonly timeoutMs: number;

  constructor(stage: Stage, middlewareName: string, timeoutMs: number) {
    super(`middleware "${middlewareName}" ${stage} timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
    this.stage = stage;
    this.middlewareName = middlewareName;
    this.timeoutMs = timeoutMs;
  }
}

export class MiddlewareAbortedError extends Error {
  readonly stage: Stage;
  readonly middlewareName: string;
  readonly reason: unknown;

  constructor(stage: Stage, middlewareName: string, reason: unknown) {
    super(`middleware "${middlewareName}" ${stage} aborted`);
    this.name = 'AbortError';
    this.stage = stage;
    this.middlewareName = middlewareName;
    this.reason = reason;
  }
}

export class MiddlewareStageError extends Error {
  readonly stage: Stage;
  readonly middlewareName: string;
  readonly cause: Error;

  constructor(stage: Stage, middlewareName: string, cause: Error) {
    super(`middleware "${middlewareName}" ${stage} failed: ${cause.message}`, { cause });
    this.name = 'MiddlewareStageError';
    this.stage = stage;
    this.middlewareName = middlewareName;
    this.cause = cause;
  }
}

type MiddlewareHook = (ctx: Context, state: State) => Promise<void>;

function asError(thrown: unknown): Error {
  if (thrown instanceof Error) return thrown;
  if (typeof thrown === 'string') return new Error(thrown);
  if (typeof thrown === 'number' || typeof thrown === 'boolean' || thrown === null || thrown === undefined) {
    return new Error(String(thrown));
  }
  if (typeof thrown === 'object' && 'message' in thrown && typeof thrown.message === 'string') {
    return new Error(thrown.message);
  }
  return new Error('Unknown error');
}

function middlewareName(mw: Middleware): string {
  return mw.name?.trim() ? mw.name.trim() : '<unnamed>';
}

export class MiddlewareChain {
  private readonly middlewares: Middleware[];
  private readonly defaultTimeoutMs: number;
  private readonly stageTimeoutMs: StageTimeoutMs;

  constructor(
    middlewares: ReadonlyArray<Middleware | null | undefined> = [],
    options: MiddlewareChainOptions = {}
  ) {
    this.middlewares = middlewares.filter((mw): mw is Middleware => mw != null);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 0;
    this.stageTimeoutMs = options.stageTimeoutMs ?? {};
  }

  use(middleware: Middleware | null | undefined): void {
    if (!middleware) return;
    this.middlewares.push(middleware);
  }

  async execute(stage: Stage, ctx: Context, state: State, options?: { timeoutMs?: number }): Promise<void> {
    state.stage = stage;
    if (state.aborted) return;

    const timeoutMs = this.resolveTimeoutMs(stage, options?.timeoutMs);
    const stageDeadlineMs =
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? Date.now() + timeoutMs : undefined;

    for (const mw of this.middlewares) {
      if (state.aborted) return;
      const hook = mw[stage] as MiddlewareHook | undefined;
      if (!hook) continue;

      try {
        const remainingMs =
          stageDeadlineMs === undefined ? timeoutMs : stageDeadlineMs - Date.now();
        await this.withTimeout(
          hook.call(mw, ctx, state),
          remainingMs,
          timeoutMs,
          ctx.signal,
          stage,
          middlewareName(mw)
        );
      } catch (err) {
        const cause = asError(err);
        const wrapped = new MiddlewareStageError(stage, middlewareName(mw), cause);
        state.error = wrapped;
        state.aborted = true;
        throw wrapped;
      }
    }
  }

  private resolveTimeoutMs(stage: Stage, overrideTimeoutMs: number | undefined): number {
    const stageTimeout = this.stageTimeoutMs[stage];
    return overrideTimeoutMs ?? stageTimeout ?? this.defaultTimeoutMs;
  }

  private async withTimeout(
    promise: Promise<void>,
    remainingMs: number,
    configuredTimeoutMs: number,
    signal: AbortSignal | undefined,
    stage: Stage,
    middlewareNameValue: string
  ): Promise<void> {
    const hasTimeout = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0;
    const hasSignal = !!signal;

    if (!hasTimeout && !hasSignal) {
      await promise;
      return;
    }

    if (hasTimeout && (!Number.isFinite(remainingMs) || remainingMs <= 0)) {
      throw new MiddlewareTimeoutError(stage, middlewareNameValue, configuredTimeoutMs);
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;

    const timeoutPromise = hasTimeout
      ? new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new MiddlewareTimeoutError(stage, middlewareNameValue, configuredTimeoutMs)),
            Math.max(0, remainingMs)
          );
        })
      : undefined;

    const abortPromise = hasSignal
      ? new Promise<never>((_, reject) => {
          if (!signal) return;
          if (signal.aborted) {
            reject(new MiddlewareAbortedError(stage, middlewareNameValue, signal.reason));
            return;
          }
          abortListener = () => reject(new MiddlewareAbortedError(stage, middlewareNameValue, signal.reason));
          try {
            signal.addEventListener('abort', abortListener, { once: true });
          } catch {
            // Older AbortSignal implementations: fall back to a non-cancellable promise.
          }
        })
      : undefined;

    try {
      const races = [promise, timeoutPromise, abortPromise].filter(Boolean) as Array<Promise<void>>;
      await Promise.race(races);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (abortListener && signal) {
        try {
          signal.removeEventListener('abort', abortListener);
        } catch {
          // ignore
        }
      }
    }
  }
}

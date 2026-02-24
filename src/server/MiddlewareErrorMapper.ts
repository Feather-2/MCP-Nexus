import {
  MiddlewareTimeoutError,
  MiddlewareAbortedError,
  MiddlewareStageError
} from '../middleware/chain.js';

export interface MappedMiddlewareError {
  status: number;
  code: string;
  message: string;
  recoverable: boolean;
  meta?: unknown;
}

export function mapMiddlewareError(error: unknown): MappedMiddlewareError {
  const err = error instanceof Error ? error : new Error(String(error));
  const stageErr = err instanceof MiddlewareStageError ? err : undefined;
  const causeCandidate = stageErr?.cause ?? (err as Error & { cause?: unknown }).cause;
  const root = causeCandidate instanceof Error ? causeCandidate : err;

  if (root instanceof MiddlewareTimeoutError) {
    return {
      status: 504,
      code: 'MIDDLEWARE_TIMEOUT',
      message: root.message,
      recoverable: true,
      meta: { stage: root.stage, middlewareName: root.middlewareName, timeoutMs: root.timeoutMs }
    };
  }

  if (root instanceof MiddlewareAbortedError || root.name === 'AbortError') {
    return {
      status: 499,
      code: 'REQUEST_ABORTED',
      message: root.message,
      recoverable: true,
      meta: { stage: (root as Error & { stage?: string }).stage, middlewareName: (root as Error & { middlewareName?: string }).middlewareName }
    };
  }

  return {
    status: 500,
    code: 'MIDDLEWARE_ERROR',
    message: root.message || err.message || 'Middleware error',
    recoverable: false,
    meta: stageErr
      ? { stage: stageErr.stage, middlewareName: stageErr.middlewareName, cause: root.message }
      : { cause: root.message }
  };
}


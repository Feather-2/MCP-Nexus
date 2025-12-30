import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface TraceContextState {
  traceId: string;
}

const storage = new AsyncLocalStorage<TraceContextState>();

export function getTraceId(): string | undefined {
  return storage.getStore()?.traceId;
}

export function enterTrace(traceId: string): void {
  storage.enterWith({ traceId });
}

export function createTraceId(): string {
  return randomUUID();
}


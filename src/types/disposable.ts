/**
 * Unified resource lifecycle interface.
 * Components holding timers, connections, or file handles implement this
 * and are auto-cleaned by Container.destroyAll() during shutdown.
 */
export interface Disposable {
  dispose(): void | Promise<void>;
}

export function isDisposable(value: unknown): value is Disposable {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).dispose === 'function'
  );
}

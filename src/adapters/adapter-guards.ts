import type { McpMessage } from '../types/index.js';

const DEFAULT_NOT_CONNECTED_ERROR = 'Adapter not connected';
const DEFAULT_OVERLOAD_ERROR = 'Too many pending requests; upstream may be unresponsive';

export function assertConnected(condition: unknown, errorMessage = DEFAULT_NOT_CONNECTED_ERROR): asserts condition {
  if (!condition) {
    throw new Error(errorMessage);
  }
}

export function assertNotOverloaded(current: number, max: number, errorMessage = DEFAULT_OVERLOAD_ERROR): void {
  if (current >= max) {
    throw new Error(errorMessage);
  }
}

export function enqueueWithLimit(queue: McpMessage[], message: McpMessage, maxSize: number): void {
  if (queue.length >= maxSize) {
    queue.shift();
  }
  queue.push(message);
}

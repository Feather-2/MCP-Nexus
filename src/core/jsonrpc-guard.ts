import type { McpMessage } from '../types/index.js';

/**
 * Type guard: validates a message has the required JSON-RPC 2.0 envelope.
 * Prevents processing of malformed responses from upstream services.
 */
export function isJsonRpcMessage(message: unknown): message is McpMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as Record<string, unknown>).jsonrpc === '2.0'
  );
}

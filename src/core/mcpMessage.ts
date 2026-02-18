import type { McpMessage } from '../types/index.js';

let counter = 0;

/**
 * Build an MCP JSON-RPC 2.0 request message.
 */
export function mcpRequest(method: string, params: Record<string, unknown> = {}, idPrefix = 'req'): McpMessage {
  return {
    jsonrpc: '2.0',
    id: `${idPrefix}-${Date.now()}-${++counter}`,
    method,
    params,
  };
}

/**
 * SSRF protection and URL extraction for HTTP-based transport adapters.
 * Blocks requests to private, link-local, and metadata IP ranges.
 */

import type { McpServiceConfig } from '../types/index.js';

const BLOCKED_HOST_PATTERNS: ReadonlyArray<RegExp> = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^169\.254\./, /^0\./, /^localhost$/i, /^\[?::1\]?$/, /^\[?::ffff:127\./,
  /^metadata\.google\.internal$/i,
  /^\[?fe80:/i, /^\[?fd[0-9a-f]{2}:/i,
];

/**
 * Throws if the URL targets a private/metadata IP address.
 * Only call for user-supplied URLs (env vars), not admin-set commands.
 */
export function validateNotPrivateUrl(urlStr: string): void {
  let host: string;
  try {
    host = new URL(urlStr).hostname;
  } catch {
    throw new Error(`Blocked: unable to parse URL for SSRF validation: ${urlStr}`);
  }
  if (BLOCKED_HOST_PATTERNS.some(p => p.test(host))) {
    throw new Error(`Blocked private/metadata URL target: ${host}`);
  }
}

export function isValidHttpUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Extract HTTP URL from service config with SSRF validation.
 * Used by both HttpTransportAdapter and StreamableHttpAdapter.
 */
export function extractHttpUrl(config: McpServiceConfig): string {
  let url: string | undefined;
  let fromConfig = false;

  const serverUrl = config.env?.MCP_SERVER_URL?.trim();
  const mcpHost = config.env?.MCP_HOST?.trim();
  const mcpPort = config.env?.MCP_PORT?.trim();

  if (serverUrl) {
    url = serverUrl;
    fromConfig = true;
  } else if (mcpHost && mcpPort) {
    const protocol = config.env?.MCP_HTTPS === 'true' ? 'https' : 'http';
    url = `${protocol}://${mcpHost}:${mcpPort}`;
    fromConfig = true;
  } else if (config.command?.startsWith('http') && isValidHttpUrl(config.command)) {
    url = config.command;
  } else {
    const fallback = config.env?.MCP_BASE_URL?.trim();
    if (fallback && isValidHttpUrl(fallback)) {
      url = fallback;
      fromConfig = true;
    } else {
      url = 'http://localhost:3000';
    }
  }

  if (fromConfig) validateNotPrivateUrl(url);
  return url;
}

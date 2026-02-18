/**
 * SSRF protection for HTTP-based transport adapters.
 * Blocks requests to private, link-local, and metadata IP ranges.
 */

const BLOCKED_HOST_PATTERNS: ReadonlyArray<RegExp> = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^169\.254\./, /^0\./, /^localhost$/i, /^\[?::1\]?$/, /^\[?::ffff:127\./,
];

/**
 * Throws if the URL targets a private/metadata IP address.
 * Only call for user-supplied URLs (env vars), not admin-set commands.
 */
export function validateNotPrivateUrl(urlStr: string): void {
  try {
    const host = new URL(urlStr).hostname;
    if (BLOCKED_HOST_PATTERNS.some(p => p.test(host))) {
      throw new Error(`Blocked private/metadata URL target: ${host}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Blocked')) throw error;
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

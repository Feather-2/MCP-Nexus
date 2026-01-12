/**
 * Async utility functions
 */

/**
 * Sleep for the specified duration
 * @param ms Duration in milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Sleep with exponential backoff
 * @param attempt Current attempt number (0-indexed)
 * @param baseMs Base delay in milliseconds (default: 100)
 * @param maxMs Maximum delay in milliseconds (default: 10000)
 */
export function sleepBackoff(attempt: number, baseMs = 100, maxMs = 10000): Promise<void> {
  const delay = Math.min(Math.pow(2, attempt) * baseMs, maxMs);
  return sleep(delay);
}

/**
 * Retry an async operation with exponential backoff
 * @param fn Function to retry
 * @param maxAttempts Maximum number of attempts (default: 3)
 * @param baseMs Base delay in milliseconds (default: 100)
 */
export async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseMs = 100
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < maxAttempts - 1) {
        await sleepBackoff(attempt, baseMs);
      }
    }
  }
  throw lastError;
}

/**
 * Run a function with a timeout
 * @param fn Function to run
 * @param timeoutMs Timeout in milliseconds
 * @param errorMessage Error message on timeout
 */
export function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  errorMessage = 'Operation timed out'
): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
    )
  ]);
}

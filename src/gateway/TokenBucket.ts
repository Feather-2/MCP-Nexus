/**
 * Token Bucket rate limiter for backpressure control.
 */

export interface TokenBucketOptions {
  /** Maximum tokens in the bucket. */
  capacity: number;
  /** Tokens added per second. */
  refillRate: number;
}

export class TokenBucket {
  private tokens: number;
  private lastRefillTime: number;
  private readonly capacity: number;
  private readonly refillRate: number;

  constructor(options: TokenBucketOptions) {
    this.capacity = options.capacity;
    this.refillRate = options.refillRate;
    this.tokens = this.capacity;
    this.lastRefillTime = Date.now();
  }

  /**
   * Try to acquire a token. Returns true if successful.
   */
  tryAcquire(): boolean {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }

    return false;
  }

  /**
   * Acquire a token, waiting if necessary.
   * @param timeoutMs Maximum time to wait in milliseconds.
   * @returns Promise that resolves to true if acquired, false if timed out.
   */
  async acquire(timeoutMs: number = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (this.tryAcquire()) {
        return true;
      }

      // Calculate wait time until next token
      const tokensNeeded = 1 - this.tokens;
      const waitMs = Math.min(
        (tokensNeeded / this.refillRate) * 1000,
        deadline - Date.now()
      );

      if (waitMs <= 0) break;

      await new Promise(resolve => setTimeout(resolve, Math.min(waitMs, 100)));
    }

    return false;
  }

  /**
   * Get current available tokens.
   */
  availableTokens(): number {
    this.refill();
    return this.tokens;
  }

  /**
   * Reset bucket to full capacity.
   */
  reset(): void {
    this.tokens = this.capacity;
    this.lastRefillTime = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefillTime) / 1000;
    const tokensToAdd = elapsed * this.refillRate;

    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefillTime = now;
  }
}

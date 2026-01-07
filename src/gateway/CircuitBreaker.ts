/**
 * Circuit Breaker state machine for fault tolerance.
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Error threshold percentage to trip the breaker (0-100). Default: 50 */
  errorThresholdPercentage?: number;
  /** Minimum number of requests before calculating error rate. Default: 10 */
  requestVolumeThreshold?: number;
  /** Time in ms the circuit stays open before transitioning to half-open. Default: 30000 */
  sleepWindowMs?: number;
  /** Number of successful requests in half-open to close the circuit. Default: 3 */
  successThreshold?: number;
  /** Time window in ms for rolling statistics. Default: 10000 */
  rollingWindowMs?: number;
}

interface RequestStat {
  timestamp: number;
  success: boolean;
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private lastStateChange: number = Date.now();
  private halfOpenSuccesses: number = 0;
  private readonly stats: RequestStat[] = [];

  private readonly errorThresholdPercentage: number;
  private readonly requestVolumeThreshold: number;
  private readonly sleepWindowMs: number;
  private readonly successThreshold: number;
  private readonly rollingWindowMs: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.errorThresholdPercentage = options.errorThresholdPercentage ?? 50;
    this.requestVolumeThreshold = options.requestVolumeThreshold ?? 10;
    this.sleepWindowMs = options.sleepWindowMs ?? 30000;
    this.successThreshold = options.successThreshold ?? 3;
    this.rollingWindowMs = options.rollingWindowMs ?? 10000;
  }

  /**
   * Check if request is allowed through the circuit.
   */
  allowRequest(): boolean {
    this.pruneOldStats();

    switch (this.state) {
      case 'CLOSED':
        return true;

      case 'OPEN':
        // Check if sleep window has elapsed
        if (Date.now() - this.lastStateChange >= this.sleepWindowMs) {
          this.transitionTo('HALF_OPEN');
          return true;
        }
        return false;

      case 'HALF_OPEN':
        // Allow limited requests in half-open state
        return true;

      default:
        return true;
    }
  }

  /**
   * Record the result of a request.
   */
  recordResult(success: boolean): void {
    const now = Date.now();
    this.stats.push({ timestamp: now, success });
    this.pruneOldStats();

    switch (this.state) {
      case 'CLOSED':
        this.checkForTrip();
        break;

      case 'HALF_OPEN':
        if (success) {
          this.halfOpenSuccesses++;
          if (this.halfOpenSuccesses >= this.successThreshold) {
            this.transitionTo('CLOSED');
          }
        } else {
          // Single failure in half-open trips back to open
          this.transitionTo('OPEN');
        }
        break;

      case 'OPEN':
        // Shouldn't happen, but ignore
        break;
    }
  }

  /**
   * Get current circuit state.
   */
  getState(): CircuitState {
    // Check for automatic transition from OPEN to HALF_OPEN
    if (this.state === 'OPEN' && Date.now() - this.lastStateChange >= this.sleepWindowMs) {
      this.transitionTo('HALF_OPEN');
    }
    return this.state;
  }

  /**
   * Get circuit statistics.
   */
  getStats(): {
    state: CircuitState;
    totalRequests: number;
    successCount: number;
    errorCount: number;
    errorRate: number;
    lastStateChange: Date;
  } {
    this.pruneOldStats();

    const successCount = this.stats.filter(s => s.success).length;
    const errorCount = this.stats.filter(s => !s.success).length;
    const totalRequests = this.stats.length;
    const errorRate = totalRequests > 0 ? (errorCount / totalRequests) * 100 : 0;

    return {
      state: this.getState(),
      totalRequests,
      successCount,
      errorCount,
      errorRate,
      lastStateChange: new Date(this.lastStateChange)
    };
  }

  /**
   * Force the circuit to a specific state (for testing/admin).
   */
  forceState(state: CircuitState): void {
    this.transitionTo(state);
  }

  /**
   * Reset the circuit breaker.
   */
  reset(): void {
    this.stats.length = 0;
    this.halfOpenSuccesses = 0;
    this.transitionTo('CLOSED');
  }

  private transitionTo(newState: CircuitState): void {
    if (this.state === newState) return;

    this.state = newState;
    this.lastStateChange = Date.now();

    if (newState === 'HALF_OPEN') {
      this.halfOpenSuccesses = 0;
    }

    if (newState === 'CLOSED') {
      this.stats.length = 0;
    }
  }

  private checkForTrip(): void {
    if (this.stats.length < this.requestVolumeThreshold) {
      return;
    }

    const errorCount = this.stats.filter(s => !s.success).length;
    const errorRate = (errorCount / this.stats.length) * 100;

    if (errorRate >= this.errorThresholdPercentage) {
      this.transitionTo('OPEN');
    }
  }

  private pruneOldStats(): void {
    const cutoff = Date.now() - this.rollingWindowMs;
    while (this.stats.length > 0 && this.stats[0].timestamp < cutoff) {
      this.stats.shift();
    }
  }
}

/**
 * Backpressure Controller for managing request flow and preventing cascade failures.
 */

import { TokenBucket, TokenBucketOptions } from './TokenBucket.js';
import { CircuitBreaker, CircuitBreakerOptions, CircuitState } from './CircuitBreaker.js';

export interface BackpressureLease {
  serviceId: string;
  acquiredAt: number;
}

export interface BackpressureStatus {
  circuitState: CircuitState;
  queueDepth: number;
  availableTokens: number;
  isAcceptingRequests: boolean;
}

export interface BackpressureControllerOptions {
  /** Token bucket options per service. */
  tokenBucket?: Partial<TokenBucketOptions>;
  /** Circuit breaker options per service. */
  circuitBreaker?: CircuitBreakerOptions;
  /** Maximum queue depth per service. Default: 100 */
  maxQueueDepth?: number;
  /** Default timeout for acquiring lease in ms. Default: 5000 */
  defaultTimeoutMs?: number;
}

interface ServiceBackpressure {
  tokenBucket: TokenBucket;
  circuitBreaker: CircuitBreaker;
  queue: Array<{
    resolve: (lease: BackpressureLease) => void;
    reject: (error: Error) => void;
    deadline: number;
  }>;
}

export class BackpressureController {
  private readonly services = new Map<string, ServiceBackpressure>();
  private readonly tokenBucketDefaults: TokenBucketOptions;
  private readonly circuitBreakerDefaults: CircuitBreakerOptions;
  private readonly maxQueueDepth: number;
  private readonly defaultTimeoutMs: number;

  private queueProcessor?: ReturnType<typeof setInterval>;

  constructor(options: BackpressureControllerOptions = {}) {
    this.tokenBucketDefaults = {
      capacity: options.tokenBucket?.capacity ?? 100,
      refillRate: options.tokenBucket?.refillRate ?? 50
    };
    this.circuitBreakerDefaults = options.circuitBreaker ?? {};
    this.maxQueueDepth = options.maxQueueDepth ?? 100;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5000;

    // Start queue processor
    this.queueProcessor = setInterval(() => this.processQueues(), 50);
    (this.queueProcessor as any).unref?.();
  }

  /**
   * Acquire a lease to make a request to a service.
   * @param serviceId The service to acquire a lease for.
   * @param timeoutMs Maximum time to wait in milliseconds.
   * @returns Promise that resolves to a lease, or rejects if unavailable.
   */
  async acquire(serviceId: string, timeoutMs?: number): Promise<BackpressureLease> {
    const service = this.getOrCreateService(serviceId);
    const timeout = timeoutMs ?? this.defaultTimeoutMs;

    // Check circuit breaker first
    if (!service.circuitBreaker.allowRequest()) {
      throw new Error(`Circuit breaker OPEN for service ${serviceId}`);
    }

    // Try to acquire token immediately
    if (service.tokenBucket.tryAcquire()) {
      return {
        serviceId,
        acquiredAt: Date.now()
      };
    }

    // Check queue capacity
    if (service.queue.length >= this.maxQueueDepth) {
      throw new Error(`Queue full for service ${serviceId} (max: ${this.maxQueueDepth})`);
    }

    // Add to queue and wait
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeout;
      service.queue.push({ resolve, reject, deadline });
    });
  }

  /**
   * Release a lease after request completion.
   * @param lease The lease to release.
   * @param success Whether the request was successful.
   */
  release(lease: BackpressureLease, success: boolean): void {
    const service = this.services.get(lease.serviceId);
    if (!service) return;

    service.circuitBreaker.recordResult(success);
  }

  /**
   * Get backpressure status for a service.
   */
  getStatus(serviceId: string): BackpressureStatus {
    const service = this.services.get(serviceId);

    if (!service) {
      return {
        circuitState: 'CLOSED',
        queueDepth: 0,
        availableTokens: this.tokenBucketDefaults.capacity,
        isAcceptingRequests: true
      };
    }

    const circuitState = service.circuitBreaker.getState();

    return {
      circuitState,
      queueDepth: service.queue.length,
      availableTokens: service.tokenBucket.availableTokens(),
      isAcceptingRequests: circuitState !== 'OPEN'
    };
  }

  /**
   * Get status for all services.
   */
  getAllStatus(): Record<string, BackpressureStatus> {
    const result: Record<string, BackpressureStatus> = {};

    for (const serviceId of this.services.keys()) {
      result[serviceId] = this.getStatus(serviceId);
    }

    return result;
  }

  /**
   * Force circuit breaker state for a service (admin use).
   */
  forceCircuitState(serviceId: string, state: CircuitState): void {
    const service = this.getOrCreateService(serviceId);
    service.circuitBreaker.forceState(state);
  }

  /**
   * Reset backpressure state for a service.
   */
  resetService(serviceId: string): void {
    const service = this.services.get(serviceId);
    if (!service) return;

    service.tokenBucket.reset();
    service.circuitBreaker.reset();

    // Reject all queued requests
    while (service.queue.length > 0) {
      const item = service.queue.shift();
      item?.reject(new Error('Service reset'));
    }
  }

  /**
   * Stop the backpressure controller.
   */
  stop(): void {
    if (this.queueProcessor) {
      clearInterval(this.queueProcessor);
      this.queueProcessor = undefined;
    }

    // Reject all pending requests
    for (const service of this.services.values()) {
      while (service.queue.length > 0) {
        const item = service.queue.shift();
        item?.reject(new Error('Controller stopped'));
      }
    }
  }

  private getOrCreateService(serviceId: string): ServiceBackpressure {
    let service = this.services.get(serviceId);

    if (!service) {
      service = {
        tokenBucket: new TokenBucket(this.tokenBucketDefaults),
        circuitBreaker: new CircuitBreaker(this.circuitBreakerDefaults),
        queue: []
      };
      this.services.set(serviceId, service);
    }

    return service;
  }

  private processQueues(): void {
    const now = Date.now();

    for (const [serviceId, service] of this.services) {
      // Process expired items first
      while (service.queue.length > 0) {
        const first = service.queue[0];
        if (first.deadline <= now) {
          service.queue.shift();
          first.reject(new Error(`Timeout waiting for service ${serviceId}`));
        } else {
          break;
        }
      }

      // Try to fulfill queued requests
      while (service.queue.length > 0 && service.tokenBucket.tryAcquire()) {
        const item = service.queue.shift();
        if (item && item.deadline > now) {
          item.resolve({
            serviceId,
            acquiredAt: now
          });
        }
      }
    }
  }
}

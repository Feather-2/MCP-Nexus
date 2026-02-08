import { describe, expect, it, afterEach } from 'vitest';
import { BackpressureController } from '../../gateway/BackpressureController.js';

describe('BackpressureController', () => {
  let ctrl: BackpressureController;

  afterEach(() => {
    ctrl?.stop();
  });

  it('acquires and releases lease', async () => {
    ctrl = new BackpressureController();
    const lease = await ctrl.acquire('svc-1');
    expect(lease.serviceId).toBe('svc-1');
    expect(lease.acquiredAt).toBeGreaterThan(0);
    ctrl.release(lease, true);
  });

  it('rejects when circuit breaker is OPEN', async () => {
    ctrl = new BackpressureController();
    ctrl.forceCircuitState('svc-1', 'OPEN');
    await expect(ctrl.acquire('svc-1')).rejects.toThrow('Circuit breaker OPEN');
  });

  it('rejects when queue is full', async () => {
    ctrl = new BackpressureController({
      tokenBucket: { capacity: 0, refillRate: 0.001 },
      maxQueueDepth: 1
    });
    // First queued request
    const p1 = ctrl.acquire('svc-1', 5000);
    // Second should exceed queue
    await expect(ctrl.acquire('svc-1', 100)).rejects.toThrow('Queue full');
    ctrl.stop(); // rejects p1
    await expect(p1).rejects.toThrow();
  });

  it('getStatus returns defaults for unknown service', () => {
    ctrl = new BackpressureController();
    const status = ctrl.getStatus('unknown');
    expect(status.circuitState).toBe('CLOSED');
    expect(status.isAcceptingRequests).toBe(true);
    expect(status.queueDepth).toBe(0);
  });

  it('getStatus returns correct state for known service', async () => {
    ctrl = new BackpressureController();
    await ctrl.acquire('svc-1');
    const status = ctrl.getStatus('svc-1');
    expect(status.circuitState).toBe('CLOSED');
    expect(status.isAcceptingRequests).toBe(true);
  });

  it('getAllStatus returns all services', async () => {
    ctrl = new BackpressureController();
    await ctrl.acquire('a');
    await ctrl.acquire('b');
    const all = ctrl.getAllStatus();
    expect(Object.keys(all)).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('forceCircuitState creates service if needed', () => {
    ctrl = new BackpressureController();
    ctrl.forceCircuitState('new-svc', 'OPEN');
    const status = ctrl.getStatus('new-svc');
    expect(status.circuitState).toBe('OPEN');
    expect(status.isAcceptingRequests).toBe(false);
  });

  it('resetService rejects queued requests', async () => {
    ctrl = new BackpressureController({
      tokenBucket: { capacity: 0, refillRate: 0.001 }
    });
    const p = ctrl.acquire('svc-1', 10000);
    // Let queue fill
    await new Promise(r => setTimeout(r, 10));
    ctrl.resetService('svc-1');
    await expect(p).rejects.toThrow('Service reset');
  });

  it('resetService is no-op for unknown service', () => {
    ctrl = new BackpressureController();
    ctrl.resetService('nope'); // should not throw
  });

  it('stop rejects all pending requests', async () => {
    ctrl = new BackpressureController({
      tokenBucket: { capacity: 0, refillRate: 0.001 }
    });
    const p = ctrl.acquire('svc-1', 10000);
    await new Promise(r => setTimeout(r, 10));
    ctrl.stop();
    await expect(p).rejects.toThrow('Controller stopped');
  });

  it('release is no-op for unknown service', () => {
    ctrl = new BackpressureController();
    ctrl.release({ serviceId: 'nope', acquiredAt: Date.now() }, true);
  });

  it('processQueues fulfills queued requests when tokens available', async () => {
    ctrl = new BackpressureController({
      tokenBucket: { capacity: 1, refillRate: 100 }
    });
    // Acquire the one token
    await ctrl.acquire('svc-1');
    // Next will queue
    const p = ctrl.acquire('svc-1', 500);
    // Wait for refill and queue processing
    const lease = await p;
    expect(lease.serviceId).toBe('svc-1');
  });

  it('processQueues rejects expired items', async () => {
    ctrl = new BackpressureController({
      tokenBucket: { capacity: 1, refillRate: 0.001 }
    });
    await ctrl.acquire('svc-1');
    const p = ctrl.acquire('svc-1', 60);
    await expect(p).rejects.toThrow('Timeout');
  });
});

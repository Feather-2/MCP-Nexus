import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from '../../gateway/CircuitBreaker.js';

describe('CircuitBreaker', () => {
  it('starts CLOSED and allows requests', () => {
    const cb = new CircuitBreaker();
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.allowRequest()).toBe(true);
  });

  it('trips to OPEN when error threshold exceeded', () => {
    const cb = new CircuitBreaker({ requestVolumeThreshold: 5, errorThresholdPercentage: 50 });
    for (let i = 0; i < 5; i++) cb.recordResult(false);
    expect(cb.getState()).toBe('OPEN');
    expect(cb.allowRequest()).toBe(false);
  });

  it('stays CLOSED when errors below threshold', () => {
    const cb = new CircuitBreaker({ requestVolumeThreshold: 10, errorThresholdPercentage: 50 });
    for (let i = 0; i < 6; i++) cb.recordResult(true);
    for (let i = 0; i < 4; i++) cb.recordResult(false);
    expect(cb.getState()).toBe('CLOSED');
  });

  it('transitions OPEN -> HALF_OPEN after sleep window', () => {
    const cb = new CircuitBreaker({ requestVolumeThreshold: 2, sleepWindowMs: 10 });
    cb.recordResult(false);
    cb.recordResult(false);
    expect(cb.getState()).toBe('OPEN');
    // Manually advance by manipulating lastStateChange
    (cb as any).lastStateChange = Date.now() - 20;
    expect(cb.getState()).toBe('HALF_OPEN');
    expect(cb.allowRequest()).toBe(true);
  });

  it('HALF_OPEN transitions to CLOSED after enough successes', () => {
    const cb = new CircuitBreaker({ requestVolumeThreshold: 2, successThreshold: 2, sleepWindowMs: 1 });
    cb.recordResult(false);
    cb.recordResult(false);
    // Force HALF_OPEN
    cb.forceState('HALF_OPEN');
    cb.recordResult(true);
    expect(cb.getState()).toBe('HALF_OPEN');
    cb.recordResult(true);
    expect(cb.getState()).toBe('CLOSED');
  });

  it('HALF_OPEN trips back to OPEN on failure', () => {
    const cb = new CircuitBreaker({ requestVolumeThreshold: 2 });
    cb.forceState('HALF_OPEN');
    cb.recordResult(false);
    expect(cb.getState()).toBe('OPEN');
  });

  it('recordResult in OPEN state does nothing', () => {
    const cb = new CircuitBreaker({ requestVolumeThreshold: 2 });
    cb.forceState('OPEN');
    cb.recordResult(true);
    expect(cb.getState()).toBe('OPEN');
  });

  it('getStats returns correct statistics', () => {
    const cb = new CircuitBreaker({ requestVolumeThreshold: 10 });
    for (let i = 0; i < 3; i++) cb.recordResult(true);
    for (let i = 0; i < 2; i++) cb.recordResult(false);
    const stats = cb.getStats();
    expect(stats.totalRequests).toBe(5);
    expect(stats.successCount).toBe(3);
    expect(stats.errorCount).toBe(2);
    expect(stats.errorRate).toBe(40);
    expect(stats.state).toBe('CLOSED');
    expect(stats.lastStateChange).toBeInstanceOf(Date);
  });

  it('forceState works', () => {
    const cb = new CircuitBreaker();
    cb.forceState('OPEN');
    expect(cb.getState()).toBe('OPEN');
    cb.forceState('CLOSED');
    expect(cb.getState()).toBe('CLOSED');
  });

  it('reset clears state', () => {
    const cb = new CircuitBreaker({ requestVolumeThreshold: 2 });
    cb.recordResult(false);
    cb.recordResult(false);
    expect(cb.getState()).toBe('OPEN');
    cb.reset();
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.getStats().totalRequests).toBe(0);
  });

  it('prunes old stats outside rolling window', async () => {
    const cb = new CircuitBreaker({ rollingWindowMs: 50, requestVolumeThreshold: 20 });
    for (let i = 0; i < 5; i++) cb.recordResult(false);
    await new Promise(r => setTimeout(r, 60));
    const stats = cb.getStats();
    expect(stats.totalRequests).toBe(0);
  });

  it('allowRequest transitions OPEN to HALF_OPEN after sleep window', () => {
    const cb = new CircuitBreaker({ requestVolumeThreshold: 2, sleepWindowMs: 1 });
    cb.forceState('OPEN');
    (cb as any).lastStateChange = Date.now() - 10;
    expect(cb.allowRequest()).toBe(true);
    expect(cb.getState()).toBe('HALF_OPEN');
  });

  it('transitionTo same state is no-op', () => {
    const cb = new CircuitBreaker();
    const before = (cb as any).lastStateChange;
    (cb as any).transitionTo('CLOSED');
    expect((cb as any).lastStateChange).toBe(before);
  });
});

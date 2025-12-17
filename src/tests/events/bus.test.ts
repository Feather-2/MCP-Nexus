import { EventBus, LRUDeduper } from '../../events/index.js';
import type { Event } from '../../events/index.js';

async function flushBus(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await Promise.resolve();
  if (typeof vi.isFakeTimers === 'function' && vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(0);
  } else {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  for (let i = 0; i < 3; i += 1) await Promise.resolve();
}

describe('EventBus', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes events to subscribers in order and auto-fills fields', async () => {
    const bus = new EventBus();
    const received: Event[] = [];

    bus.subscribe('foo', (evt) => {
      received.push(evt);
    });

    bus.publish({ type: 'foo', payload: 1 });
    bus.publish({ type: 'foo', payload: 2 });

    await flushBus();

    expect(received).toHaveLength(2);
    expect(received.map((e) => e.payload)).toEqual([1, 2]);
    expect(received[0]?.id).toMatch(/^evt-\d+$/);
    expect(received[0]?.timestamp).toBeInstanceOf(Date);
    expect(received[0]?.timestamp?.getTime()).toBeGreaterThan(0);

    bus.close();
  });

  it('deduplicates by event.id within the LRU window', async () => {
    const bus = new EventBus();
    const seen: string[] = [];

    bus.subscribe('foo', (evt) => {
      seen.push(evt.id ?? '');
    });

    bus.publish({ type: 'foo', id: 'same' });
    bus.publish({ type: 'foo', id: 'same' });
    bus.publish({ type: 'foo', id: 'other' });

    await flushBus();

    expect(seen).toEqual(['same', 'other']);

    bus.close();
  });

  it('isolates handler failures so one throw does not affect others', async () => {
    const bus = new EventBus();
    const calls: string[] = [];

    bus.subscribe('foo', () => {
      calls.push('bad');
      throw new Error('boom');
    });

    bus.subscribe('foo', (evt) => {
      calls.push(`good:${evt.payload as string}`);
    });

    bus.publish({ type: 'foo', payload: 'x' });
    bus.publish({ type: 'foo', payload: 'y' });

    await flushBus();

    expect(calls).toContain('bad');
    expect(calls).toContain('good:x');
    expect(calls).toContain('good:y');

    bus.close();
  });

  it('skips timed out handler executions and continues processing', async () => {
    vi.useFakeTimers();

    const bus = new EventBus();
    const completed: string[] = [];
    const other: string[] = [];
    let callCount = 0;

    bus.subscribe(
      'foo',
      async (evt) => {
        callCount += 1;
        if (callCount === 1) {
          await new Promise<void>(() => {});
        }
        completed.push(evt.payload as string);
      },
      { timeout: 10 }
    );

    bus.subscribe('foo', (evt) => {
      other.push(evt.payload as string);
    });

    bus.publish({ type: 'foo', payload: 'first' });
    bus.publish({ type: 'foo', payload: 'second' });

    await flushBus();
    expect(other).toEqual(['first', 'second']);
    expect(callCount).toBe(1);
    expect(completed).toEqual([]);

    await vi.advanceTimersByTimeAsync(11);
    await flushBus();

    expect(callCount).toBe(2);
    expect(completed).toEqual(['second']);
    expect(other).toEqual(['first', 'second']);

    bus.close();
  });

  it('supports unsubscribe and is safe to call multiple times', async () => {
    const bus = new EventBus();
    const received: number[] = [];

    const unsubscribe = bus.subscribe('foo', (evt) => {
      received.push(evt.payload as number);
    });

    bus.publish({ type: 'foo', payload: 1 });
    await flushBus();
    expect(received).toEqual([1]);

    unsubscribe();
    unsubscribe();

    bus.publish({ type: 'foo', payload: 2 });
    await flushBus();
    expect(received).toEqual([1]);

    bus.close();
  });

  it('close clears subscriptions and stops delivery', async () => {
    const bus = new EventBus();
    const received: number[] = [];

    const unsubscribe = bus.subscribe('foo', (evt) => {
      received.push(evt.payload as number);
    });

    bus.publish({ type: 'foo', payload: 1 });
    await flushBus();
    expect(received).toEqual([1]);

    bus.close();
    bus.close();
    unsubscribe();

    bus.publish({ type: 'foo', payload: 2 });
    await flushBus();

    expect(received).toEqual([1]);
  });

  it('ignores publish/subscribe after close', async () => {
    const bus = new EventBus();
    bus.close();

    const received: string[] = [];
    const unsubscribe = bus.subscribe('foo', (evt) => {
      received.push(evt.payload as string);
    });
    unsubscribe();
    unsubscribe();

    expect(() => bus.publish({ type: 'foo', payload: 'x' })).not.toThrow();
    await flushBus();
    expect(received).toEqual([]);
  });

  it('drops events when queueDepth is exceeded', async () => {
    const bus = new EventBus({ queueDepth: 1 });
    const received: number[] = [];

    bus.subscribe('foo', (evt) => {
      received.push(evt.payload as number);
    });

    bus.publish({ type: 'foo', payload: 1 });
    bus.publish({ type: 'foo', payload: 2 }); // dropped

    await flushBus();
    expect(received).toEqual([1]);

    bus.close();
  });

  it('drops buffered events for a slow subscriber when bufferSize is exceeded', async () => {
    const bus = new EventBus({ bufferSize: 1 });
    const received: string[] = [];
    let unblock: (() => void) | undefined;

    bus.subscribe('foo', async (evt) => {
      received.push(`start:${evt.payload as string}`);
      if (evt.payload === '1') {
        await new Promise<void>((resolve) => {
          unblock = resolve;
        });
      }
      received.push(`end:${evt.payload as string}`);
    });

    bus.publish({ type: 'foo', payload: '1' });
    bus.publish({ type: 'foo', payload: '2' });
    bus.publish({ type: 'foo', payload: '3' }); // dropped due to bufferSize=1

    await flushBus();
    expect(received).toEqual(['start:1']);

    unblock?.();
    await flushBus();

    expect(received).toContain('start:2');
    expect(received).toContain('end:2');
    expect(received).not.toContain('start:3');

    bus.close();
  });

  it('throws on missing event type and missing subscription type', () => {
    const bus = new EventBus();

    expect(() => bus.publish({ type: '' })).toThrow(/missing type/i);
    expect(() => bus.subscribe('', () => {})).toThrow(/missing type/i);

    bus.close();
  });
});

describe('LRUDeduper', () => {
  it('evicts the oldest id when limit is exceeded', () => {
    const d = new LRUDeduper(2);

    expect(d.allow('')).toBe(true);
    expect(d.allow('a')).toBe(true);
    expect(d.allow('b')).toBe(true);
    expect(d.allow('a')).toBe(false);

    expect(d.allow('c')).toBe(true); // evicts 'a'
    expect(d.allow('a')).toBe(true);
    expect(d.allow('b')).toBe(true);
  });
});

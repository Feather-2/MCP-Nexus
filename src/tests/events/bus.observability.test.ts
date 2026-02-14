import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBus, EventBusEvents } from '../../events/bus.js';
import type {
  Event,
  BackpressureDropPayload,
  BufferDropPayload,
  HandlerErrorPayload,
  HandlerTimeoutPayload
} from '../../events/types.js';

describe('EventBus Observability', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus({ queueDepth: 2, bufferSize: 2, dedupLimit: 10 });
  });

  describe('Statistics', () => {
    it('should track published events', () => {
      bus.publish({ type: 'test:event' });
      bus.publish({ type: 'test:event2' });

      const stats = bus.getStats();
      expect(stats.published).toBe(2);
    });

    it('should track dropped events due to queue full', () => {
      bus.publish({ type: 'test:event1' });
      bus.publish({ type: 'test:event2' });
      bus.publish({ type: 'test:event3' }); // Should be dropped

      const stats = bus.getStats();
      expect(stats.dropped).toBe(1);
    });

    it('should track deduplicated events', () => {
      bus.publish({ type: 'test:event', id: 'same-id' });
      bus.publish({ type: 'test:event', id: 'same-id' }); // Should be deduplicated

      const stats = bus.getStats();
      expect(stats.deduplicated).toBe(1);
    });

    it('should track handler errors', async () => {
      const errorHandler = vi.fn((): void => {
        throw new Error('Handler error');
      });

      bus.subscribe('test:event', errorHandler);
      bus.publish({ type: 'test:event' });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const stats = bus.getStats();
      expect(stats.handlerErrors).toBe(1);
    });

    it('should track handler timeouts', async () => {
      const slowHandler = vi.fn(
        (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 200))
      );

      bus.subscribe('test:event', slowHandler, { timeout: 50 });
      bus.publish({ type: 'test:event' });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const stats = bus.getStats();
      expect(stats.handlerTimeouts).toBe(1);
    });

    it('should reset statistics', () => {
      bus.publish({ type: 'test:event' });
      bus.publish({ type: 'test:event2' });

      let stats = bus.getStats();
      expect(stats.published).toBe(2);

      bus.resetStats();

      stats = bus.getStats();
      expect(stats.published).toBe(0);
      expect(stats.dropped).toBe(0);
      expect(stats.deduplicated).toBe(0);
    });
  });

  describe('Governance Events', () => {
    it('should emit backpressure drop event when queue is full', async () => {
      const events: Event[] = [];
      bus.subscribe(EventBusEvents.BACKPRESSURE_DROP, (evt) => {
        events.push(evt);
      });

      bus.publish({ type: 'test:event1' });
      bus.publish({ type: 'test:event2' });
      bus.publish({ type: 'test:event3', id: 'dropped-event' }); // Should trigger drop event

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(events.length).toBe(1);
      const payload = events[0].payload as BackpressureDropPayload;
      expect(payload.droppedEventId).toBe('dropped-event');
      expect(payload.droppedEventType).toBe('test:event3');
      expect(payload.queueDepth).toBe(2);
      expect(payload.reason).toBe('queue_full');
    });

    it('should emit buffer drop event when subscriber buffer is full', async () => {
      const events: Event[] = [];
      bus.subscribe(EventBusEvents.BUFFER_DROP, (evt) => {
        events.push(evt);
      });

      // Create a blocking subscriber that never completes
      let resolveHandler: (() => void) | undefined;
      const blockingHandler = vi.fn(
        () => new Promise<void>((resolve) => {
          resolveHandler = resolve;
        })
      );
      bus.subscribe('test:event', blockingHandler);

      // Publish events to fill the buffer (bufferSize = 2)
      bus.publish({ type: 'test:event', id: 'evt1' });
      bus.publish({ type: 'test:event', id: 'evt2' });

      // Wait for events to be dispatched
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Now publish more events - these should trigger buffer drop
      bus.publish({ type: 'test:event', id: 'evt3' });
      bus.publish({ type: 'test:event', id: 'evt4' });

      // Wait for buffer drop events to be emitted
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(events.length).toBeGreaterThan(0);
      const payload = events[0].payload as BufferDropPayload;
      expect(payload.droppedEventType).toBe('test:event');
      expect(payload.bufferSize).toBe(2);
      expect(payload.reason).toBe('buffer_full');

      // Cleanup: resolve the blocking handler
      if (resolveHandler) resolveHandler();
    });

    it('should emit handler error event when handler throws', async () => {
      const events: Event[] = [];
      bus.subscribe(EventBusEvents.HANDLER_ERROR, (evt) => {
        events.push(evt);
      });

      const errorHandler = vi.fn(() => {
        throw new Error('Test error');
      });

      bus.subscribe('test:event', errorHandler);
      bus.publish({ type: 'test:event', id: 'error-event' });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(events.length).toBe(1);
      const payload = events[0].payload as HandlerErrorPayload;
      expect(payload.eventId).toBe('error-event');
      expect(payload.eventType).toBe('test:event');
      expect(payload.error.message).toBe('Test error');
      expect(payload.error.name).toBe('Error');
    });

    it('should emit handler timeout event when handler times out', async () => {
      const events: Event[] = [];
      bus.subscribe(EventBusEvents.HANDLER_TIMEOUT, (evt) => {
        events.push(evt);
      });

      const slowHandler = vi.fn(
        (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 200))
      );

      bus.subscribe('test:event', slowHandler, { timeout: 50 });
      bus.publish({ type: 'test:event', id: 'timeout-event' });

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(events.length).toBe(1);
      const payload = events[0].payload as HandlerTimeoutPayload;
      expect(payload.eventId).toBe('timeout-event');
      expect(payload.eventType).toBe('test:event');
      expect(payload.timeoutMs).toBe(50);
    });
  });

  describe('Event Metadata', () => {
    it('should preserve observability metadata in events', async () => {
      const events: Event[] = [];
      bus.subscribe('test:event', (evt) => {
        events.push(evt);
      });

      bus.publish({
        type: 'test:event',
        runId: 'run-123',
        traceId: 'trace-456',
        stage: 'orchestrator',
        component: 'SubagentScheduler',
        metadata: { custom: 'data' }
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(events.length).toBe(1);
      expect(events[0].runId).toBe('run-123');
      expect(events[0].traceId).toBe('trace-456');
      expect(events[0].stage).toBe('orchestrator');
      expect(events[0].component).toBe('SubagentScheduler');
      expect(events[0].metadata).toEqual({ custom: 'data' });
    });

    it('should add component metadata to governance events', async () => {
      const events: Event[] = [];
      bus.subscribe(EventBusEvents.BACKPRESSURE_DROP, (evt) => {
        events.push(evt);
      });

      bus.publish({ type: 'test:event1' });
      bus.publish({ type: 'test:event2' });
      bus.publish({ type: 'test:event3' }); // Should trigger drop event

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(events.length).toBe(1);
      expect(events[0].component).toBe('EventBus');
    });
  });
});

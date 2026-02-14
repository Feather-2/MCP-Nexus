import { EventLogger } from '../../events/EventLogger.js';
import { EventReplayer } from '../../observability/EventReplayer.js';

describe('EventReplayer', () => {
  let logger: EventLogger;
  let replayer: EventReplayer;

  beforeEach(() => {
    logger = new EventLogger({ dbPath: ':memory:' });
    replayer = new EventReplayer(logger);
  });

  afterEach(() => {
    logger.close();
  });

  it('returns empty array when logger is disabled', () => {
    const disabledLogger = new EventLogger();
    const disabledReplayer = new EventReplayer(disabledLogger);
    const events = disabledReplayer.replay();
    expect(events).toEqual([]);
  });

  it('replays events in ascending order', () => {
    logger.log({ type: 'test:event', payload: { order: 1 }, timestamp: new Date('2024-01-01') });
    logger.log({ type: 'test:event', payload: { order: 2 }, timestamp: new Date('2024-01-02') });
    logger.log({ type: 'test:event', payload: { order: 3 }, timestamp: new Date('2024-01-03') });

    const events = replayer.replay();

    expect(events.length).toBe(3);
    expect((events[0].payload as any).order).toBe(1);
    expect((events[1].payload as any).order).toBe(2);
    expect((events[2].payload as any).order).toBe(3);
  });

  it('filters by event type', () => {
    logger.log({ type: 'test:a', payload: { value: 'a' } });
    logger.log({ type: 'test:b', payload: { value: 'b' } });
    logger.log({ type: 'test:a', payload: { value: 'a2' } });

    const events = replayer.replay({ filters: { type: 'test:a' } });

    expect(events.length).toBe(2);
    expect(events.every((e) => e.type === 'test:a')).toBe(true);
  });

  it('calls onEvent callback for each event', () => {
    logger.log({ type: 'test:event', payload: { n: 1 } });
    logger.log({ type: 'test:event', payload: { n: 2 } });

    const calls: number[] = [];
    replayer.replay({
      onEvent: (event, index, total) => {
        calls.push(index);
        expect(total).toBe(2);
      }
    });

    expect(calls).toEqual([0, 1]);
  });

  it('replayByRunId filters by runId', () => {
    logger.log({ type: 'test:event', payload: { runId: 'run-1' } });
    logger.log({ type: 'test:event', payload: { runId: 'run-2' } });
    logger.log({ type: 'test:event', payload: { runId: 'run-1' } });

    const events = replayer.replayByRunId('run-1');

    expect(events.length).toBe(2);
  });
});

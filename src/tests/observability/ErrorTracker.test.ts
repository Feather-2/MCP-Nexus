import { EventLogger } from '../../events/EventLogger.js';
import { ErrorTracker } from '../../observability/ErrorTracker.js';
import type { ErrorEnvelope } from '../../types/errors.js';

describe('ErrorTracker', () => {
  let logger: EventLogger;
  let tracker: ErrorTracker;

  beforeEach(() => {
    logger = new EventLogger({ dbPath: ':memory:' });
    tracker = new ErrorTracker(logger);
  });

  afterEach(() => {
    logger.close();
  });

  it('returns empty array when logger is disabled', () => {
    const disabledLogger = new EventLogger();
    const disabledTracker = new ErrorTracker(disabledLogger);
    const traces = disabledTracker.traceByRunId('run-1');
    expect(traces).toEqual([]);
  });

  it('traces errors by runId', () => {
    const envelope: ErrorEnvelope = {
      code: 'ERR_001',
      fingerprint: 'fp-1',
      message: 'Test error',
      name: 'TestError',
      category: 'network',
      severity: 'high',
      recoverable: false,
      context: { runId: 'run-1' },
      timestamp: new Date()
    };

    logger.log({ type: 'test:error', payload: { errorEnvelope: envelope, runId: 'run-1' } });
    logger.log({ type: 'test:error', payload: { errorEnvelope: envelope, runId: 'run-2' } });

    const traces = tracker.traceByRunId('run-1');

    expect(traces.length).toBe(1);
    expect(traces[0].runId).toBe('run-1');
    expect(traces[0].fingerprint).toBe('fp-1');
  });

  it('traces errors by fingerprint', () => {
    const envelope: ErrorEnvelope = {
      code: 'ERR_001',
      fingerprint: 'fp-1',
      message: 'Test error',
      name: 'TestError',
      category: 'network',
      severity: 'high',
      recoverable: false,
      context: {},
      timestamp: new Date()
    };

    logger.log({ type: 'test:error', payload: { errorEnvelope: envelope } });
    logger.log({ type: 'test:error', payload: { errorEnvelope: envelope } });

    const trace = tracker.traceByFingerprint('fp-1');

    expect(trace.fingerprint).toBe('fp-1');
    expect(trace.occurrences).toBe(2);
  });

  it('extracts cause chain', () => {
    const cause: ErrorEnvelope = {
      code: 'ERR_002',
      fingerprint: 'fp-2',
      message: 'Root cause',
      name: 'RootError',
      category: 'internal',
      severity: 'medium',
      recoverable: false,
      context: {},
      timestamp: new Date()
    };

    const envelope: ErrorEnvelope = {
      code: 'ERR_001',
      fingerprint: 'fp-1',
      message: 'Test error',
      name: 'TestError',
      category: 'network',
      severity: 'high',
      recoverable: false,
      context: {},
      timestamp: new Date(),
      cause
    };

    logger.log({ type: 'test:error', payload: { errorEnvelope: envelope } });

    const trace = tracker.traceByFingerprint('fp-1');

    expect(trace.causeChain.length).toBe(2);
    expect(trace.causeChain[0].fingerprint).toBe('fp-1');
    expect(trace.causeChain[1].fingerprint).toBe('fp-2');
  });
});

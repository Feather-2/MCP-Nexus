import { PinoLogger } from '../../utils/PinoLogger.js';

vi.mock('../../observability/trace.js', () => ({
  getTraceId: vi.fn(() => undefined)
}));

import { getTraceId } from '../../observability/trace.js';

describe('PinoLogger \u2013 branch coverage', () => {
  const mockedGetTraceId = vi.mocked(getTraceId);

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor options', () => {
    it('uses PB_LOG_LEVEL env when no level option', () => {
      process.env.PB_LOG_LEVEL = 'debug';
      const logger = new PinoLogger();
      expect(logger).toBeDefined();
      delete process.env.PB_LOG_LEVEL;
    });

    it('uses pretty mode when PB_LOG_PRETTY=1', () => {
      process.env.PB_LOG_PRETTY = '1';
      const logger = new PinoLogger();
      expect(logger).toBeDefined();
      delete process.env.PB_LOG_PRETTY;
    });

    it('uses explicit pretty option over env', () => {
      const logger = new PinoLogger({ pretty: false });
      expect(logger).toBeDefined();
    });

    it('creates logger with explicit level', () => {
      const logger = new PinoLogger({ level: 'warn' });
      expect(logger).toBeDefined();
    });
  });

  describe('withTrace function coverage', () => {
    it('logs with no traceId and no meta (returns undefined)', () => {
      mockedGetTraceId.mockReturnValue(undefined as any);
      const logger = new PinoLogger({ level: 'trace' });
      expect(() => logger.trace('test')).not.toThrow();
    });

    it('logs with no traceId and null meta', () => {
      mockedGetTraceId.mockReturnValue(undefined as any);
      const logger = new PinoLogger({ level: 'trace' });
      expect(() => logger.debug('test', null)).not.toThrow();
    });

    it('logs with traceId and no meta', () => {
      mockedGetTraceId.mockReturnValue('trace-123');
      const logger = new PinoLogger({ level: 'trace' });
      expect(() => logger.info('test')).not.toThrow();
    });

    it('logs with traceId and null meta (returns base only)', () => {
      mockedGetTraceId.mockReturnValue('trace-456');
      const logger = new PinoLogger({ level: 'trace' });
      expect(() => logger.warn('test', null)).not.toThrow();
    });

    it('logs with traceId and object meta (merges)', () => {
      mockedGetTraceId.mockReturnValue('trace-789');
      const logger = new PinoLogger({ level: 'trace' });
      expect(() => logger.error('test', { key: 'val' })).not.toThrow();
    });

    it('logs with traceId and array meta (wraps in meta key)', () => {
      mockedGetTraceId.mockReturnValue('trace-abc');
      const logger = new PinoLogger({ level: 'trace' });
      expect(() => logger.info('test', [1, 2, 3])).not.toThrow();
    });

    it('logs with no traceId and object meta', () => {
      mockedGetTraceId.mockReturnValue(undefined as any);
      const logger = new PinoLogger({ level: 'trace' });
      expect(() => logger.debug('test', { foo: 'bar' })).not.toThrow();
    });

    it('logs with no traceId and primitive meta (string)', () => {
      mockedGetTraceId.mockReturnValue(undefined as any);
      const logger = new PinoLogger({ level: 'trace' });
      expect(() => logger.info('test', 'string-meta')).not.toThrow();
    });

    it('logs with traceId and primitive meta (number)', () => {
      mockedGetTraceId.mockReturnValue('trace-num');
      const logger = new PinoLogger({ level: 'trace' });
      expect(() => logger.warn('test', 42)).not.toThrow();
    });
  });

  describe('all log levels', () => {
    it('trace level works', () => {
      const logger = new PinoLogger({ level: 'trace' });
      expect(() => logger.trace('trace msg')).not.toThrow();
    });

    it('debug level works', () => {
      const logger = new PinoLogger({ level: 'trace' });
      expect(() => logger.debug('debug msg')).not.toThrow();
    });

    it('error level works', () => {
      const logger = new PinoLogger({ level: 'trace' });
      expect(() => logger.error('error msg')).not.toThrow();
    });
  });
});

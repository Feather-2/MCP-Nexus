import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { EventBus, EventLogger } from '../../events/index.js';

function cleanupSqliteFiles(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${dbPath}${suffix}`;
    if (existsSync(candidate)) rmSync(candidate, { force: true });
  }
}

async function flushBus(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (let i = 0; i < 3; i += 1) await Promise.resolve();
}

const describeMaybe = EventLogger.sqliteAvailable ? describe : describe.skip;

describeMaybe('EventLogger', () => {
  it('persists events and defaults version to 1.0', () => {
    const dbPath = `/tmp/test-event-log-${randomUUID()}.db`;
    cleanupSqliteFiles(dbPath);

    const logger = new EventLogger({ dbPath });
    try {
      expect(logger.isEnabled()).toBe(true);

      const eventTime = new Date('2025-01-01T00:00:00.000Z');
      const logged = logger.log({
        id: 'evt-1',
        type: 'tool.called',
        timestamp: eventTime,
        sessionId: 'session-A',
        payload: { tool: 'sqlite' }
      });

      expect(logged).toBe(true);
      const rows = logger.query({ type: 'tool.called', limit: 10 });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe('evt-1');
      expect(rows[0]?.version).toBe('1.0');
      expect(rows[0]?.timestamp.toISOString()).toBe(eventTime.toISOString());
      expect(rows[0]?.sessionId).toBe('session-A');
      expect(rows[0]?.payload).toEqual({ tool: 'sqlite' });
      expect(rows[0]?.createdAt).toBeInstanceOf(Date);
    } finally {
      logger.close();
      cleanupSqliteFiles(dbPath);
    }
  });

  it('supports query filters and limit/offset', () => {
    const dbPath = `/tmp/test-event-log-${randomUUID()}.db`;
    cleanupSqliteFiles(dbPath);

    const logger = new EventLogger({ dbPath });
    try {
      logger.log({
        id: 'evt-a',
        type: 'tool.called',
        version: '1.0',
        timestamp: new Date('2025-01-01T00:00:01.000Z'),
        sessionId: 'session-A',
        payload: { step: 1 }
      });
      logger.log({
        id: 'evt-b',
        type: 'tool.called',
        version: '2.0',
        timestamp: new Date('2025-01-01T00:00:02.000Z'),
        sessionId: 'session-A',
        payload: { step: 2 }
      });
      logger.log({
        id: 'evt-c',
        type: 'tool.finished',
        version: '2.0',
        timestamp: new Date('2025-01-01T00:00:03.000Z'),
        sessionId: 'session-B',
        payload: { ok: true }
      });

      expect(logger.query({ type: 'tool.called' })).toHaveLength(2);
      expect(logger.query({ version: '2.0' })).toHaveLength(2);
      expect(logger.query({ sessionId: 'session-B' })).toHaveLength(1);
      expect(
        logger.query({
          from: new Date('2025-01-01T00:00:02.000Z'),
          to: new Date('2025-01-01T00:00:03.000Z')
        })
      ).toHaveLength(2);

      const page = logger.query({ limit: 1, offset: 1 });
      expect(page).toHaveLength(1);
      expect(page[0]?.id).toBe('evt-b');
    } finally {
      logger.close();
      cleanupSqliteFiles(dbPath);
    }
  });

  it('aggregates stats from persisted logs', () => {
    const dbPath = `/tmp/test-event-log-${randomUUID()}.db`;
    cleanupSqliteFiles(dbPath);

    const logger = new EventLogger({ dbPath });
    try {
      logger.log({ id: 'evt-1', type: 'a', version: '1.0', timestamp: new Date('2025-01-01T00:00:01.000Z') });
      logger.log({ id: 'evt-2', type: 'a', version: '2.0', timestamp: new Date('2025-01-01T00:00:02.000Z') });
      logger.log({ id: 'evt-3', type: 'b', version: '2.0', timestamp: new Date('2025-01-01T00:00:03.000Z') });

      const stats = logger.stats();
      expect(stats.enabled).toBe(true);
      expect(stats.total).toBe(3);
      expect(stats.byType).toEqual({ a: 2, b: 1 });
      expect(stats.byVersion).toEqual({ '1.0': 1, '2.0': 2 });
      expect(stats.latestTimestamp?.toISOString()).toBe('2025-01-01T00:00:03.000Z');
    } finally {
      logger.close();
      cleanupSqliteFiles(dbPath);
    }
  });

  it('works with EventBus logger integration', async () => {
    const dbPath = `/tmp/test-event-log-${randomUUID()}.db`;
    cleanupSqliteFiles(dbPath);

    const logger = new EventLogger({ dbPath });
    const bus = new EventBus(undefined, logger);
    try {
      const received: string[] = [];
      bus.subscribe('tool.called', (event) => {
        received.push(event.id ?? '');
      });

      bus.publish({ type: 'tool.called', payload: { a: 1 }, sessionId: 'session-A' });
      await flushBus();

      expect(received).toHaveLength(1);
      const rows = logger.query({ type: 'tool.called' });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.version).toBe('1.0');
      expect(rows[0]?.sessionId).toBe('session-A');
    } finally {
      bus.close();
      logger.close();
      cleanupSqliteFiles(dbPath);
    }
  });

  it('enriches payload with runId, stage, component, metadata', () => {
    const dbPath = `/tmp/test-event-log-${randomUUID()}.db`;
    cleanupSqliteFiles(dbPath);

    const logger = new EventLogger({ dbPath });
    try {
      logger.log({
        type: 'orchestrator:execute:end',
        runId: 'run-123',
        stage: 'orchestrator',
        component: 'OrchestratorEngine',
        metadata: { region: 'us-east' },
        payload: { success: true, durationMs: 500 }
      });

      const rows = logger.query({ type: 'orchestrator:execute:end', limit: 1 });
      expect(rows).toHaveLength(1);
      const payload = rows[0]?.payload as Record<string, unknown>;
      expect(payload.success).toBe(true);
      expect(payload.durationMs).toBe(500);
      expect(payload.runId).toBe('run-123');
      expect(payload.stage).toBe('orchestrator');
      expect(payload.component).toBe('OrchestratorEngine');
      expect(payload.metadata).toEqual({ region: 'us-east' });
    } finally {
      logger.close();
      cleanupSqliteFiles(dbPath);
    }
  });

  it('enriches non-object payload by wrapping in _payload', () => {
    const dbPath = `/tmp/test-event-log-${randomUUID()}.db`;
    cleanupSqliteFiles(dbPath);

    const logger = new EventLogger({ dbPath });
    try {
      logger.log({
        type: 'test:string-payload',
        runId: 'run-456',
        payload: 'simple string'
      });

      const rows = logger.query({ type: 'test:string-payload', limit: 1 });
      expect(rows).toHaveLength(1);
      const payload = rows[0]?.payload as Record<string, unknown>;
      expect(payload._payload).toBe('simple string');
      expect(payload.runId).toBe('run-456');
    } finally {
      logger.close();
      cleanupSqliteFiles(dbPath);
    }
  });

  it('enriches undefined payload preserving only metadata fields', () => {
    const dbPath = `/tmp/test-event-log-${randomUUID()}.db`;
    cleanupSqliteFiles(dbPath);

    const logger = new EventLogger({ dbPath });
    try {
      logger.log({
        type: 'test:no-payload',
        runId: 'run-789',
        stage: 'test'
      });

      const rows = logger.query({ type: 'test:no-payload', limit: 1 });
      expect(rows).toHaveLength(1);
      const payload = rows[0]?.payload as Record<string, unknown>;
      expect(payload.runId).toBe('run-789');
      expect(payload.stage).toBe('test');
    } finally {
      logger.close();
      cleanupSqliteFiles(dbPath);
    }
  });
});

describe('EventLogger fallback', () => {
  it('degrades gracefully when sqlite is unavailable', () => {
    if (EventLogger.sqliteAvailable) return;

    const logger = new EventLogger({ dbPath: ':memory:' });
    expect(logger.isEnabled()).toBe(false);
    expect(logger.log({ type: 'tool.called' })).toBe(false);
    expect(logger.query()).toEqual([]);
    expect(logger.stats()).toEqual({
      enabled: false,
      total: 0,
      byType: {},
      byVersion: {}
    });
    logger.close();
  });
});

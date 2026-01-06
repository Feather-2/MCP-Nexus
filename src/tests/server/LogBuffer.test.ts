import { LogBuffer, type LogEntry } from '../../server/LogBuffer.js';

describe('LogBuffer', () => {
  describe('constructor', () => {
    it('creates with default max size', () => {
      const buffer = new LogBuffer();
      expect(buffer.size).toBe(0);
    });

    it('creates with custom max size', () => {
      const buffer = new LogBuffer(50);
      expect(buffer.size).toBe(0);
    });
  });

  describe('add', () => {
    it('adds log entry with all fields', () => {
      const buffer = new LogBuffer();
      const entry = buffer.add('info', 'Test message', 'test-service', { key: 'value' });

      expect(entry.level).toBe('info');
      expect(entry.message).toBe('Test message');
      expect(entry.service).toBe('test-service');
      expect(entry.data).toEqual({ key: 'value' });
      expect(entry.timestamp).toBeDefined();
      expect(buffer.size).toBe(1);
    });

    it('adds entry with minimal fields', () => {
      const buffer = new LogBuffer();
      const entry = buffer.add('warn', 'Warning message');

      expect(entry.level).toBe('warn');
      expect(entry.message).toBe('Warning message');
      expect(entry.service).toBeUndefined();
      expect(entry.data).toBeUndefined();
    });

    it('enforces max size limit', () => {
      const buffer = new LogBuffer(3);

      buffer.add('info', 'Message 1');
      buffer.add('info', 'Message 2');
      buffer.add('info', 'Message 3');
      buffer.add('info', 'Message 4');

      expect(buffer.size).toBe(3);
      const all = buffer.getAll();
      expect(all[0].message).toBe('Message 2');
      expect(all[2].message).toBe('Message 4');
    });

    it('notifies subscribers', () => {
      const buffer = new LogBuffer();
      const received: LogEntry[] = [];

      buffer.subscribe(entry => received.push(entry));
      buffer.add('info', 'Test');

      expect(received).toHaveLength(1);
      expect(received[0].message).toBe('Test');
    });

    it('handles subscriber errors gracefully', () => {
      const buffer = new LogBuffer();

      buffer.subscribe(() => { throw new Error('Subscriber error'); });
      expect(() => buffer.add('info', 'Test')).not.toThrow();
    });
  });

  describe('getAll', () => {
    it('returns copy of all entries', () => {
      const buffer = new LogBuffer();
      buffer.add('info', 'A');
      buffer.add('warn', 'B');

      const all = buffer.getAll();
      expect(all).toHaveLength(2);

      // Verify it's a copy
      all.push({ timestamp: '', level: 'error', message: 'C' });
      expect(buffer.size).toBe(2);
    });
  });

  describe('getByLevel', () => {
    it('filters by level', () => {
      const buffer = new LogBuffer();
      buffer.add('info', 'Info 1');
      buffer.add('warn', 'Warn 1');
      buffer.add('info', 'Info 2');
      buffer.add('error', 'Error 1');

      const infos = buffer.getByLevel('info');
      expect(infos).toHaveLength(2);
      expect(infos.every(e => e.level === 'info')).toBe(true);
    });
  });

  describe('getByService', () => {
    it('filters by service', () => {
      const buffer = new LogBuffer();
      buffer.add('info', 'A', 'api');
      buffer.add('info', 'B', 'gateway');
      buffer.add('info', 'C', 'api');

      const apiLogs = buffer.getByService('api');
      expect(apiLogs).toHaveLength(2);
      expect(apiLogs.every(e => e.service === 'api')).toBe(true);
    });
  });

  describe('getRecent', () => {
    it('returns most recent entries', () => {
      const buffer = new LogBuffer();
      buffer.add('info', 'A');
      buffer.add('info', 'B');
      buffer.add('info', 'C');
      buffer.add('info', 'D');

      const recent = buffer.getRecent(2);
      expect(recent).toHaveLength(2);
      expect(recent[0].message).toBe('C');
      expect(recent[1].message).toBe('D');
    });

    it('returns all if count exceeds size', () => {
      const buffer = new LogBuffer();
      buffer.add('info', 'A');

      const recent = buffer.getRecent(10);
      expect(recent).toHaveLength(1);
    });
  });

  describe('clear', () => {
    it('removes all entries', () => {
      const buffer = new LogBuffer();
      buffer.add('info', 'A');
      buffer.add('info', 'B');

      buffer.clear();
      expect(buffer.size).toBe(0);
      expect(buffer.getAll()).toEqual([]);
    });
  });

  describe('subscribe', () => {
    it('returns unsubscribe function', () => {
      const buffer = new LogBuffer();
      const received: LogEntry[] = [];

      const unsubscribe = buffer.subscribe(entry => received.push(entry));
      buffer.add('info', 'A');
      expect(received).toHaveLength(1);

      unsubscribe();
      buffer.add('info', 'B');
      expect(received).toHaveLength(1);
    });
  });
});

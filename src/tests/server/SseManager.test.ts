import { SseManager } from '../../server/SseManager.js';
import type { FastifyReply } from 'fastify';

function createMockReply(options: { writableEnded?: boolean; destroyed?: boolean; writeError?: boolean } = {}): FastifyReply {
  const raw = {
    writableEnded: options.writableEnded ?? false,
    destroyed: options.destroyed ?? false,
    write: vi.fn().mockImplementation(() => {
      if (options.writeError) throw new Error('Write error');
      return true;
    })
  };
  return { raw } as any;
}

describe('SseManager', () => {
  describe('constructor', () => {
    it('creates with default cleanup interval', () => {
      const manager = new SseManager();
      expect(manager.size).toBe(0);
    });

    it('creates with custom cleanup interval', () => {
      const manager = new SseManager(5000);
      expect(manager.size).toBe(0);
    });
  });

  describe('add/remove', () => {
    it('adds and removes clients', () => {
      const manager = new SseManager();
      const client = createMockReply();

      manager.add(client);
      expect(manager.size).toBe(1);

      manager.remove(client);
      expect(manager.size).toBe(0);
    });

    it('handles duplicate adds', () => {
      const manager = new SseManager();
      const client = createMockReply();

      manager.add(client);
      manager.add(client);
      expect(manager.size).toBe(1);
    });
  });

  describe('broadcast', () => {
    it('broadcasts to all clients', () => {
      const manager = new SseManager();
      const client1 = createMockReply();
      const client2 = createMockReply();

      manager.add(client1);
      manager.add(client2);
      manager.broadcast({ type: 'test', data: 'hello' });

      expect(client1.raw.write).toHaveBeenCalledWith('data: {"type":"test","data":"hello"}\n\n');
      expect(client2.raw.write).toHaveBeenCalledWith('data: {"type":"test","data":"hello"}\n\n');
    });

    it('removes clients on write error', () => {
      const manager = new SseManager();
      const goodClient = createMockReply();
      const badClient = createMockReply({ writeError: true });

      manager.add(goodClient);
      manager.add(badClient);
      expect(manager.size).toBe(2);

      manager.broadcast({ test: true });

      expect(manager.size).toBe(1);
      expect(manager.getClients().has(goodClient)).toBe(true);
      expect(manager.getClients().has(badClient)).toBe(false);
    });
  });

  describe('send', () => {
    it('sends to specific client', () => {
      const manager = new SseManager();
      const client = createMockReply();

      manager.add(client);
      const result = manager.send(client, { message: 'hi' });

      expect(result).toBe(true);
      expect(client.raw.write).toHaveBeenCalledWith('data: {"message":"hi"}\n\n');
    });

    it('returns false and removes on write error', () => {
      const manager = new SseManager();
      const client = createMockReply({ writeError: true });

      manager.add(client);
      const result = manager.send(client, { test: true });

      expect(result).toBe(false);
      expect(manager.size).toBe(0);
    });
  });

  describe('removeDisconnected', () => {
    it('removes ended clients', () => {
      const manager = new SseManager();
      const activeClient = createMockReply();
      const endedClient = createMockReply({ writableEnded: true });
      const destroyedClient = createMockReply({ destroyed: true });

      manager.add(activeClient);
      manager.add(endedClient);
      manager.add(destroyedClient);
      expect(manager.size).toBe(3);

      const removed = manager.removeDisconnected();

      expect(removed).toBe(2);
      expect(manager.size).toBe(1);
      expect(manager.getClients().has(activeClient)).toBe(true);
    });
  });

  describe('cleanup timer', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('periodically removes disconnected clients', () => {
      const manager = new SseManager(1000);
      const activeClient = createMockReply();
      const endedClient = createMockReply({ writableEnded: true });

      manager.add(activeClient);
      manager.add(endedClient);
      manager.startCleanup();

      expect(manager.size).toBe(2);

      vi.advanceTimersByTime(1000);

      expect(manager.size).toBe(1);

      manager.stopCleanup();
    });

    it('does not start multiple timers', () => {
      const manager = new SseManager(1000);

      manager.startCleanup();
      manager.startCleanup();

      // Should not throw
      manager.stopCleanup();
    });
  });

  describe('close', () => {
    it('stops cleanup and clears clients', () => {
      const manager = new SseManager();
      const client = createMockReply();

      manager.add(client);
      manager.startCleanup();

      manager.close();

      expect(manager.size).toBe(0);
    });
  });

  describe('getClients', () => {
    it('returns the underlying set', () => {
      const manager = new SseManager();
      const client = createMockReply();

      manager.add(client);
      const clients = manager.getClients();

      expect(clients).toBeInstanceOf(Set);
      expect(clients.size).toBe(1);
    });
  });
});

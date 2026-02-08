import { describe, expect, it, vi } from 'vitest';
import { createVectorStoreFromConfig, createMemoryStoreFromConfig } from '../../memory/factory.js';
import { InMemoryVectorStore } from '../../memory/vector/InMemoryVectorStore.js';
import { MemoryStore } from '../../memory/MemoryStore.js';

describe('memory/factory', () => {
  const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  describe('createVectorStoreFromConfig', () => {
    it('returns InMemoryVectorStore with no config', () => {
      const store = createVectorStoreFromConfig();
      expect(store).toBeInstanceOf(InMemoryVectorStore);
    });

    it('returns InMemoryVectorStore for provider=in-memory', () => {
      const store = createVectorStoreFromConfig({ provider: 'in-memory' } as any);
      expect(store).toBeInstanceOf(InMemoryVectorStore);
    });

    it('returns InMemoryVectorStore for provider=memory', () => {
      const store = createVectorStoreFromConfig({ provider: 'memory' } as any);
      expect(store).toBeInstanceOf(InMemoryVectorStore);
    });

    it('returns InMemoryVectorStore for provider=local', () => {
      const store = createVectorStoreFromConfig({ provider: 'local' } as any);
      expect(store).toBeInstanceOf(InMemoryVectorStore);
    });

    it('passes dim option', () => {
      const store = createVectorStoreFromConfig({ provider: 'in-memory', dim: 128 } as any);
      expect(store).toBeInstanceOf(InMemoryVectorStore);
    });

    it('falls back to in-memory for pgvector without conn', () => {
      const store = createVectorStoreFromConfig({ provider: 'pgvector' } as any, { logger });
      expect(store).toBeInstanceOf(InMemoryVectorStore);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('throws for pgvector with conn (not implemented)', () => {
      expect(() => createVectorStoreFromConfig({ provider: 'pgvector', conn: 'postgres://...' } as any)).toThrow('not implemented');
    });

    it('falls back to in-memory for unknown provider', () => {
      const store = createVectorStoreFromConfig({ provider: 'weaviate' } as any, { logger });
      expect(store).toBeInstanceOf(InMemoryVectorStore);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('createMemoryStoreFromConfig', () => {
    it('returns MemoryStore wrapping vector store', () => {
      const store = createMemoryStoreFromConfig();
      expect(store).toBeInstanceOf(MemoryStore);
    });
  });
});

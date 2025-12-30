import type { Logger, OrchestratorConfig } from '../types/index.js';
import { InMemoryVectorStore } from './vector/InMemoryVectorStore.js';
import type { VectorStore } from './vector/types.js';
import { MemoryStore } from './MemoryStore.js';

export function createVectorStoreFromConfig(
  config?: OrchestratorConfig['vectorStore'],
  opts?: { logger?: Logger }
): VectorStore {
  const providerRaw = typeof (config as any)?.provider === 'string' ? String((config as any).provider) : 'in-memory';
  const provider = providerRaw.trim().toLowerCase();
  const dim = typeof (config as any)?.dim === 'number' ? (config as any).dim : undefined;

  if (provider === 'in-memory' || provider === 'memory' || provider === 'local') {
    return new InMemoryVectorStore({ dim });
  }

  if (provider === 'pgvector') {
    const conn = typeof (config as any)?.conn === 'string' ? (config as any).conn : undefined;
    if (!conn) {
      try { opts?.logger?.warn?.('vectorStore.provider=pgvector but vectorStore.conn is empty; falling back to in-memory'); } catch {}
      return new InMemoryVectorStore({ dim });
    }
    throw new Error('pgvector provider is not implemented yet; set vectorStore.provider=in-memory');
  }

  try { opts?.logger?.warn?.(`Unknown vectorStore.provider='${providerRaw}', falling back to in-memory`); } catch {}
  return new InMemoryVectorStore({ dim });
}

export function createMemoryStoreFromConfig(
  config?: OrchestratorConfig['vectorStore'],
  opts?: { logger?: Logger }
): MemoryStore {
  return new MemoryStore(createVectorStoreFromConfig(config, opts));
}


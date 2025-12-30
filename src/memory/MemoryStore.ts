import type { VectorQueryResult, VectorStore } from './vector/types.js';

export interface MemoryRecord {
  id: string;
  text: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface RecallResult {
  score: number;
  record: MemoryRecord;
}

export class MemoryStore {
  private readonly records = new Map<string, MemoryRecord>();

  constructor(private readonly vectorStore: VectorStore) {}

  async remember(input: { id?: string; text: string; metadata?: Record<string, unknown> }): Promise<MemoryRecord> {
    const createdAt = new Date().toISOString();
    const id = await this.vectorStore.upsert({ id: input.id, text: input.text, metadata: input.metadata });
    const record: MemoryRecord = { id, text: input.text, metadata: input.metadata, createdAt };
    this.records.set(id, record);
    return record;
  }

  get(id: string): MemoryRecord | undefined {
    return this.records.get(id);
  }

  async forget(id: string): Promise<boolean> {
    this.records.delete(id);
    return this.vectorStore.delete(id);
  }

  async recall(query: string, opts?: { topK?: number }): Promise<RecallResult[]> {
    const hits: VectorQueryResult[] = await this.vectorStore.query(query, { topK: opts?.topK });
    return hits.map((hit) => {
      const record = this.records.get(hit.id) || {
        id: hit.id,
        text: hit.text || '',
        metadata: hit.metadata,
        createdAt: new Date(0).toISOString()
      };
      return { score: hit.score, record };
    });
  }

  stats(): { records: number; vector: ReturnType<VectorStore['stats']> } {
    return { records: this.records.size, vector: this.vectorStore.stats() };
  }
}


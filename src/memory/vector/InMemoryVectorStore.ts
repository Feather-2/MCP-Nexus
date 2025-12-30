import { randomUUID } from 'node:crypto';
import { cosineSimilarity, embedText } from './embedding.js';
import type { VectorDocument, VectorQueryResult, VectorStore } from './types.js';

type Stored = VectorDocument & { vector: number[] };

export class InMemoryVectorStore implements VectorStore {
  private readonly byId = new Map<string, Stored>();
  private readonly dim: number;

  constructor(opts?: { dim?: number }) {
    this.dim = Math.max(8, Math.floor(opts?.dim ?? 128));
  }

  async upsert(doc: Omit<VectorDocument, 'id'> & { id?: string }): Promise<string> {
    const id = doc.id || randomUUID();
    const stored: Stored = {
      id,
      text: String(doc.text || ''),
      metadata: doc.metadata,
      vector: embedText(String(doc.text || ''), this.dim)
    };
    this.byId.set(id, stored);
    return id;
  }

  async delete(id: string): Promise<boolean> {
    return this.byId.delete(id);
  }

  async query(text: string, opts?: { topK?: number }): Promise<VectorQueryResult[]> {
    const topK = Math.max(1, Math.floor(opts?.topK ?? 5));
    const q = embedText(String(text || ''), this.dim);

    const results: VectorQueryResult[] = [];
    for (const v of this.byId.values()) {
      results.push({
        id: v.id,
        score: cosineSimilarity(q, v.vector),
        text: v.text,
        metadata: v.metadata
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  stats(): { documents: number; dim: number } {
    return { documents: this.byId.size, dim: this.dim };
  }
}


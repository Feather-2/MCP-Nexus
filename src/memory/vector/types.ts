export interface VectorDocument {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface VectorQueryResult {
  id: string;
  score: number;
  text?: string;
  metadata?: Record<string, unknown>;
}

export interface VectorStore {
  upsert(doc: Omit<VectorDocument, 'id'> & { id?: string }): Promise<string>;
  delete(id: string): Promise<boolean>;
  query(text: string, opts?: { topK?: number }): Promise<VectorQueryResult[]>;
  stats(): { documents: number; dim: number };
}


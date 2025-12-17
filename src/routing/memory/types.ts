export type MemoryTier = 'L0' | 'L1' | 'L2';

/**
 * Memory reference format: `mem:v1:<tier>:<uuid>`
 * Example: `mem:v1:L1:550e8400-e29b-41d4-a716-446655440000`
 */
export type MemoryRef = `mem:v1:${MemoryTier}:${string}`;

export interface MemoryEntry {
  /** UUID */
  id: string;
  /** Original key provided by caller */
  key: string;
  tier: MemoryTier;
  /** Full stored payload */
  value: unknown;
  /** Human-readable summary (max 200 chars) */
  summary: string;
  createdAt: Date;
  accessedAt: Date;
  sizeBytes: number;
}

export interface MemoryStoreConfig {
  /** @default 100 */
  l0Capacity?: number;
  /** @default 300000 (5 minutes) */
  l0TtlMs?: number;
  /** @default 1000 */
  l1Capacity?: number;
  /** @default ':memory:' */
  l2DbPath?: string;
}

export const DEFAULT_MEMORY_STORE_CONFIG: Required<MemoryStoreConfig> = {
  l0Capacity: 100,
  l0TtlMs: 5 * 60 * 1000,
  l1Capacity: 1000,
  l2DbPath: ':memory:'
};

export interface MemoryStore {
  store(key: string, value: unknown, tier: MemoryTier): Promise<string>;
  retrieve(ref: string): Promise<unknown>;
  has(ref: string): Promise<boolean>;
  delete(ref: string): Promise<boolean>;
  stats(): MemoryStats;
}

export interface MemoryStats {
  l0Count: number;
  l1Count: number;
  l2Count: number;
  totalBytes: number;
}

function isMemoryTier(value: string): value is MemoryTier {
  return value === 'L0' || value === 'L1' || value === 'L2';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseRef(
  ref: string
): { version: string; tier: MemoryTier; id: string } | null {
  const parts = ref.split(':');
  if (parts.length !== 4) return null;

  const [scheme, version, tierRaw, id] = parts;
  if (scheme !== 'mem') return null;
  if (!version) return null;
  if (!isMemoryTier(tierRaw)) return null;
  if (!UUID_RE.test(id)) return null;

  return { version, tier: tierRaw, id };
}

export function createRef(tier: MemoryTier, id: string): string {
  return `mem:v1:${tier}:${id}` satisfies MemoryRef;
}

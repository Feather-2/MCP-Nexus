let BetterSqlite: any;
try {
  // Native module; may be unavailable on some platforms (e.g., Windows CI)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  BetterSqlite = require('better-sqlite3');
} catch {
  BetterSqlite = null;
}
const SQLITE_AVAILABLE = Boolean(BetterSqlite);
import { randomUUID } from 'node:crypto';
import { createRef, DEFAULT_MEMORY_STORE_CONFIG, parseRef } from './types.js';
import type { MemoryStats, MemoryStore, MemoryStoreConfig, MemoryTier } from './types.js';

type EpochMs = number;
type SqliteDb = any;
type SqliteStatement = any;

interface L1IndexEntry {
  key: string;
  createdAtMs: EpochMs;
  summary: string;
  sizeBytes: number;
  inL2: boolean;
}

interface L0Entry {
  id: string;
  key: string;
  value: unknown;
  createdAtMs: EpochMs;
  accessedAtMs: EpochMs;
  sizeBytes: number;
}

interface L0Node extends L0Entry {
  prev?: L0Node;
  next?: L0Node;
}

function toRequiredConfig(config?: MemoryStoreConfig): Required<MemoryStoreConfig> {
  return {
    ...DEFAULT_MEMORY_STORE_CONFIG,
    ...(config ?? {})
  };
}

function summarize(valueJson: string): string {
  return valueJson.length <= 200 ? valueJson : valueJson.slice(0, 200);
}

function jsonStringify(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new Error('MemoryStore: value is not JSON-serializable');
    }
    return encoded;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`MemoryStore: failed to JSON-serialize value: ${message}`);
  }
}

function jsonParse(valueJson: string): unknown {
  return JSON.parse(valueJson) as unknown;
}

class L0LruCache {
  private readonly byId = new Map<string, L0Node>();
  private head?: L0Node;
  private tail?: L0Node;
  private totalBytes = 0;

  constructor(
    private readonly capacity: number,
    private readonly ttlMs: number
  ) {}

  get count(): number {
    return this.byId.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  getValue(id: string, nowMs: EpochMs): unknown | undefined {
    const node = this.byId.get(id);
    if (!node) return undefined;

    if (this.isExpired(node, nowMs)) {
      this.delete(id);
      return undefined;
    }

    node.accessedAtMs = nowMs;
    this.moveToHead(node);
    return node.value;
  }

  has(id: string, nowMs: EpochMs): boolean {
    const node = this.byId.get(id);
    if (!node) return false;
    if (this.isExpired(node, nowMs)) {
      this.delete(id);
      return false;
    }
    return true;
  }

  set(entry: L0Entry): void {
    const existing = this.byId.get(entry.id);
    if (existing) {
      this.detach(existing);
      this.byId.delete(entry.id);
      this.totalBytes -= existing.sizeBytes;
    }

    const node: L0Node = { ...entry };
    this.byId.set(node.id, node);
    this.totalBytes += node.sizeBytes;
    this.attachToHead(node);

    this.pruneExpired(Date.now());
    this.evictOverflow();
  }

  delete(id: string): boolean {
    const node = this.byId.get(id);
    if (!node) return false;
    this.detach(node);
    this.byId.delete(id);
    this.totalBytes -= node.sizeBytes;
    return true;
  }

  pruneExpired(nowMs: EpochMs): void {
    if (this.ttlMs <= 0) {
      this.clear();
      return;
    }

    let cursor = this.tail;
    while (cursor) {
      const prev = cursor.prev;
      if (this.isExpired(cursor, nowMs)) {
        this.delete(cursor.id);
      }
      cursor = prev;
    }
  }

  clear(): void {
    this.byId.clear();
    this.head = undefined;
    this.tail = undefined;
    this.totalBytes = 0;
  }

  private isExpired(node: L0Node, nowMs: EpochMs): boolean {
    if (this.ttlMs <= 0) return true;
    return nowMs - node.accessedAtMs > this.ttlMs;
  }

  private attachToHead(node: L0Node): void {
    node.prev = undefined;
    node.next = this.head;
    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;
  }

  private detach(node: L0Node): void {
    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;
    if (this.head === node) this.head = node.next;
    if (this.tail === node) this.tail = node.prev;
    node.prev = undefined;
    node.next = undefined;
  }

  private moveToHead(node: L0Node): void {
    if (this.head === node) return;
    this.detach(node);
    this.attachToHead(node);
  }

  private evictOverflow(): void {
    if (this.capacity <= 0) {
      this.clear();
      return;
    }

    while (this.byId.size > this.capacity) {
      const victim = this.tail;
      if (!victim) break;
      this.delete(victim.id);
    }
  }
}

type L2Row = {
  id: string;
  key: string;
  tier: string;
  value_json: string;
  summary: string;
  created_at: number;
  size_bytes: number;
};

type L2StatsRow = { l2_count: number; l2_bytes: number };

export class ThreeTierMemoryStore implements MemoryStore {
  private readonly config: Required<MemoryStoreConfig>;
  private readonly l0: L0LruCache;
  private readonly l1 = new Map<string, L1IndexEntry>();
  private readonly db: SqliteDb;

  private readonly stmtInsert: SqliteStatement<
    {
      id: string;
      key: string;
      tier: string;
      value_json: string;
      summary: string;
      created_at: number;
      size_bytes: number;
    },
    unknown
  >;
  private readonly stmtSelectById: SqliteStatement<[string], L2Row>;
  private readonly stmtExistsById: SqliteStatement<[string], { present: 1 }>;
  private readonly stmtDeleteById: SqliteStatement<[string], unknown>;
  private readonly stmtStats: SqliteStatement<[], L2StatsRow>;

  constructor(config?: MemoryStoreConfig) {
    this.config = toRequiredConfig(config);
    this.l0 = new L0LruCache(this.config.l0Capacity, this.config.l0TtlMs);

    this.db = SQLITE_AVAILABLE ? new BetterSqlite(this.config.l2DbPath) : null;
    if (this.db) {
      this.db.pragma('journal_mode = WAL');

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory (
          id TEXT PRIMARY KEY,
          key TEXT NOT NULL,
          tier TEXT NOT NULL,
          value_json TEXT NOT NULL,
          summary TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          size_bytes INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_key ON memory(key);
        CREATE INDEX IF NOT EXISTS idx_created_at ON memory(created_at);
      `);

      this.stmtInsert = this.db.prepare(`
        INSERT OR REPLACE INTO memory
          (id, key, tier, value_json, summary, created_at, size_bytes)
        VALUES
          (@id, @key, @tier, @value_json, @summary, @created_at, @size_bytes)
      `);

      this.stmtSelectById = this.db.prepare(`
        SELECT id, key, tier, value_json, summary, created_at, size_bytes
        FROM memory
        WHERE id = ?
        LIMIT 1
      `);

      this.stmtExistsById = this.db.prepare(`
        SELECT 1 AS present
        FROM memory
        WHERE id = ?
        LIMIT 1
      `);

      this.stmtDeleteById = this.db.prepare(`DELETE FROM memory WHERE id = ?`);

      this.stmtStats = this.db.prepare(`
        SELECT
          COUNT(*) AS l2_count,
          COALESCE(SUM(size_bytes), 0) AS l2_bytes
        FROM memory
      `);
    } else {
      // Fallback: disable L2 when sqlite is unavailable
      this.stmtInsert = null as any;
      this.stmtSelectById = null as any;
      this.stmtExistsById = null as any;
      this.stmtDeleteById = null as any;
      this.stmtStats = null as any;
    }
  }

  async store(key: string, value: unknown, tier: MemoryTier): Promise<string> {
    const id = randomUUID();
    const nowMs = Date.now();

    const valueJson = jsonStringify(value);
    const sizeBytes = Buffer.byteLength(valueJson, 'utf8');
    const summary = summarize(valueJson);
    const normalizedValue = jsonParse(valueJson);

    if (tier === 'L0' || !SQLITE_AVAILABLE) {
      this.l0.set({
        id,
        key,
        value: normalizedValue,
        createdAtMs: nowMs,
        accessedAtMs: nowMs,
        sizeBytes
      });
      return createRef('L0', id);
    }

    if (tier === 'L1') {
      this.l1.set(id, {
        key,
        createdAtMs: nowMs,
        summary,
        sizeBytes,
        inL2: true
      });
      this.enforceL1Capacity();
      this.writeToL2({ id, key, tier, valueJson, summary, createdAtMs: nowMs, sizeBytes });
      return createRef('L1', id);
    }

    this.writeToL2({ id, key, tier: 'L2', valueJson, summary, createdAtMs: nowMs, sizeBytes });
    return createRef('L2', id);
  }

  async retrieve(ref: string): Promise<unknown> {
    const parsed = parseRef(ref);
    if (!parsed) return undefined;

    const nowMs = Date.now();
    const fromL0 = this.l0.getValue(parsed.id, nowMs);
    if (fromL0 !== undefined) return fromL0;

    const l1 = this.l1.get(parsed.id);
    if (l1?.inL2 && SQLITE_AVAILABLE && this.db) {
      const row = this.readFromL2(parsed.id);
      if (!row) {
        this.l1.delete(parsed.id);
        return undefined;
      }

      const value = jsonParse(row.value_json);
      this.l0.set({
        id: row.id,
        key: row.key,
        value,
        createdAtMs: row.created_at,
        accessedAtMs: nowMs,
        sizeBytes: row.size_bytes
      });
      return value;
    }

    const row = SQLITE_AVAILABLE && this.db ? this.readFromL2(parsed.id) : undefined;
    if (!row) return undefined;

    const value = jsonParse(row.value_json);
    this.l0.set({
      id: row.id,
      key: row.key,
      value,
      createdAtMs: row.created_at,
      accessedAtMs: nowMs,
      sizeBytes: row.size_bytes
    });
    return value;
  }

  async has(ref: string): Promise<boolean> {
    const parsed = parseRef(ref);
    if (!parsed) return false;

    const nowMs = Date.now();
    if (this.l0.has(parsed.id, nowMs)) return true;

    const l1 = this.l1.get(parsed.id);
    if (l1?.inL2 && SQLITE_AVAILABLE && this.db) {
      const present = this.stmtExistsById.get(parsed.id);
      if (!present) this.l1.delete(parsed.id);
      return Boolean(present);
    }

    if (!SQLITE_AVAILABLE || !this.db) return false;
    const present = this.stmtExistsById.get(parsed.id);
    return Boolean(present);
  }

  async delete(ref: string): Promise<boolean> {
    const parsed = parseRef(ref);
    if (!parsed) return false;

    const deletedL0 = this.l0.delete(parsed.id);
    const deletedL1 = this.l1.delete(parsed.id);
    const deletedL2 = SQLITE_AVAILABLE && this.db ? (this.stmtDeleteById.run(parsed.id).changes > 0) : false;

    return deletedL0 || deletedL1 || deletedL2;
  }

  stats(): MemoryStats {
    this.l0.pruneExpired(Date.now());
    const row = SQLITE_AVAILABLE && this.db ? this.stmtStats.get() : undefined;
    const l2Bytes = row?.l2_bytes ?? 0;
    const l2Count = row?.l2_count ?? 0;

    return {
      l0Count: this.l0.count,
      l1Count: this.l1.size,
      l2Count,
      totalBytes: this.l0.bytes + l2Bytes
    };
  }

  close(): void {
    this.db?.close?.();
  }

  private enforceL1Capacity(): void {
    const cap = this.config.l1Capacity;
    if (cap <= 0) {
      this.l1.clear();
      return;
    }

    while (this.l1.size > cap) {
      const oldest = this.l1.keys().next().value as string | undefined;
      if (!oldest) break;
      this.l1.delete(oldest);
    }
  }

  private writeToL2(args: {
    id: string;
    key: string;
    tier: MemoryTier;
    valueJson: string;
    summary: string;
    createdAtMs: EpochMs;
    sizeBytes: number;
  }): void {
    this.stmtInsert.run({
      id: args.id,
      key: args.key,
      tier: args.tier,
      value_json: args.valueJson,
      summary: args.summary,
      created_at: args.createdAtMs,
      size_bytes: args.sizeBytes
    });
  }

  private readFromL2(id: string): L2Row | undefined {
    return this.stmtSelectById.get(id);
  }
}

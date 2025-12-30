const SKIP = process.platform === 'win32';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let Database: typeof import('better-sqlite3') | undefined;
if (!SKIP) {
  // Lazy load to avoid native build errors on Windows CI
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Database = require('better-sqlite3');
}
// Friendly note for devs on Windows
if (SKIP) {
  // eslint-disable-next-line no-console
  console.warn('better-sqlite3 unavailable on Windows; skipping memory store integration tests');
}
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ThreeTierMemoryStore, parseRef } from '../../../routing/memory/index.js';

function cleanupSqliteFiles(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${dbPath}${suffix}`;
    if (existsSync(candidate)) rmSync(candidate, { force: true });
  }
}

const describeMaybe = SKIP ? describe.skip : describe;

describeMaybe('ThreeTierMemoryStore', () => {
  it('re-exports from routing/memory/index', () => {
    expect(ThreeTierMemoryStore).toBeTypeOf('function');
    expect(parseRef('mem:v1:L1:550e8400-e29b-41d4-a716-446655440000')).toEqual({
      version: 'v1',
      tier: 'L1',
      id: '550e8400-e29b-41d4-a716-446655440000'
    });
  });

  it('stores and retrieves from L0, promoting MRU and evicting LRU', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    const store = new ThreeTierMemoryStore({ l0Capacity: 2, l0TtlMs: 60_000, l2DbPath: ':memory:' });
    try {
      const refA = await store.store('kA', { a: 1 }, 'L0');
      const refB = await store.store('kB', { b: 2 }, 'L0');

      expect(await store.retrieve(refA)).toEqual({ a: 1 });
      await store.store('kC', { c: 3 }, 'L0');

      expect(await store.retrieve(refB)).toBeUndefined(); // B was LRU and got evicted
      expect(await store.retrieve(refA)).toEqual({ a: 1 }); // A survived due to access
    } finally {
      store.close();
      vi.useRealTimers();
    }
  });

  it('expires L0 entries by TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    const store = new ThreeTierMemoryStore({ l0Capacity: 10, l0TtlMs: 10, l2DbPath: ':memory:' });
    try {
      const ref = await store.store('k', { v: 1 }, 'L0');
      await vi.advanceTimersByTimeAsync(11);
      expect(await store.retrieve(ref)).toBeUndefined();
    } finally {
      store.close();
      vi.useRealTimers();
    }
  });

  it('writes L1 to L2 and backfills L0 on retrieve (has does not backfill)', async () => {
    const store = new ThreeTierMemoryStore({ l0Capacity: 10, l1Capacity: 10, l2DbPath: ':memory:' });
    try {
      const ref = await store.store('k', { v: 'x' }, 'L1');

      expect(await store.has(ref)).toBe(true);
      expect(store.stats().l0Count).toBe(0);
      expect(store.stats().l1Count).toBe(1);
      expect(store.stats().l2Count).toBe(1);

      expect(await store.retrieve(ref)).toEqual({ v: 'x' });
      expect(store.stats().l0Count).toBe(1);
    } finally {
      store.close();
    }
  });

  it('falls back to L2 when L1 is missing and supports delete', async () => {
    const store = new ThreeTierMemoryStore({ l0Capacity: 10, l1Capacity: 10, l2DbPath: ':memory:' });
    try {
      const ref = await store.store('k', { ok: true }, 'L2');
      expect(store.stats().l1Count).toBe(0);
      expect(store.stats().l2Count).toBe(1);

      expect(await store.retrieve(ref)).toEqual({ ok: true });
      expect(store.stats().l0Count).toBe(1);

      expect(await store.delete(ref)).toBe(true);
      expect(await store.retrieve(ref)).toBeUndefined();
      expect(await store.delete(ref)).toBe(false);
    } finally {
      store.close();
    }
  });

  it('returns safe defaults for invalid refs', async () => {
    const store = new ThreeTierMemoryStore({ l2DbPath: ':memory:' });
    try {
      expect(await store.retrieve('nope')).toBeUndefined();
      expect(await store.has('nope')).toBe(false);
      expect(await store.delete('nope')).toBe(false);
    } finally {
      store.close();
    }
  });

  it('handles l0Capacity<=0 and l0TtlMs<=0 by clearing', async () => {
    const storeCapacityZero = new ThreeTierMemoryStore({ l0Capacity: 0, l0TtlMs: 60_000, l2DbPath: ':memory:' });
    try {
      const ref = await storeCapacityZero.store('k', { v: 1 }, 'L0');
      expect(storeCapacityZero.stats().l0Count).toBe(0);
      expect(await storeCapacityZero.retrieve(ref)).toBeUndefined();
    } finally {
      storeCapacityZero.close();
    }

    const storeTtlZero = new ThreeTierMemoryStore({ l0Capacity: 10, l0TtlMs: 0, l2DbPath: ':memory:' });
    try {
      await storeTtlZero.store('k', { v: 1 }, 'L0');
      expect(storeTtlZero.stats().l0Count).toBe(0);
    } finally {
      storeTtlZero.close();
    }
  });

  it('enforces l1Capacity<=0 without preventing L2 persistence', async () => {
    const store = new ThreeTierMemoryStore({ l1Capacity: 0, l2DbPath: ':memory:' });
    try {
      const ref = await store.store('k', { v: 1 }, 'L1');
      expect(store.stats().l1Count).toBe(0);
      expect(store.stats().l2Count).toBe(1);
      expect(await store.retrieve(ref)).toEqual({ v: 1 }); // L2 fallback
    } finally {
      store.close();
    }
  });

  it('drops stale L1 entries when the corresponding L2 row is missing', async () => {
    const dbPath = `/tmp/test-routing-memory-${randomUUID()}.db`;
    cleanupSqliteFiles(dbPath);

    const store = new ThreeTierMemoryStore({ l2DbPath: dbPath, l1Capacity: 10, l0Capacity: 10, l0TtlMs: 60_000 });
    try {
      const ref = await store.store('k', { v: 1 }, 'L1');
      const parsed = parseRef(ref);
      if (!parsed) throw new Error('expected a valid ref');

      const db = new Database!(dbPath);
      try {
        db.prepare('DELETE FROM memory WHERE id = ?').run(parsed.id);
      } finally {
        db.close();
      }

      expect(await store.has(ref)).toBe(false);
      expect(store.stats().l1Count).toBe(0);
      expect(await store.retrieve(ref)).toBeUndefined();
    } finally {
      store.close();
      cleanupSqliteFiles(dbPath);
    }
  });

  it('rejects non-JSON-serializable values', async () => {
    const store = new ThreeTierMemoryStore({ l2DbPath: ':memory:' });
    try {
      await expect(store.store('k', { big: 1n }, 'L0')).rejects.toThrow(/JSON-serialize/i);
    } finally {
      store.close();
    }
  });
});

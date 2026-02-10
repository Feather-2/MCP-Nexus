import os from 'os';
import path from 'path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { SkillVersionStore } from './SkillVersionStore.js';
import type { Logger } from '../types/index.js';

describe('SkillVersionStore \u2013 branch coverage', () => {
  let tmpRoot: string;
  const logger: Logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'nexus-svs-branch-'));
  });

  afterEach(async () => {
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('constructor edge cases', () => {
    it('uses default maxSnapshots when NaN provided', () => {
      const store = new SkillVersionStore({ storageRoot: tmpRoot, maxSnapshots: NaN });
      expect(store).toBeDefined();
    });

    it('uses default maxSnapshots when negative provided', () => {
      const store = new SkillVersionStore({ storageRoot: tmpRoot, maxSnapshots: -5 });
      expect(store).toBeDefined();
    });

    it('uses default maxSnapshots when zero provided', () => {
      const store = new SkillVersionStore({ storageRoot: tmpRoot, maxSnapshots: 0 });
      expect(store).toBeDefined();
    });

    it('uses default maxSnapshots when float provided', () => {
      const store = new SkillVersionStore({ storageRoot: tmpRoot, maxSnapshots: 3.7 });
      expect(store).toBeDefined();
    });
  });

  describe('normalizeSkillName edge cases', () => {
    it('throws for empty skill name', async () => {
      const store = new SkillVersionStore({ storageRoot: tmpRoot });
      await expect(store.save('', { 'SKILL.md': 'x' })).rejects.toThrow('Skill name is required');
    });

    it('throws for whitespace-only skill name', async () => {
      const store = new SkillVersionStore({ storageRoot: tmpRoot });
      await expect(store.save('   ', { 'SKILL.md': 'x' })).rejects.toThrow('Skill name is required');
    });

    it('throws for skill name with forward slash', async () => {
      const store = new SkillVersionStore({ storageRoot: tmpRoot });
      await expect(store.save('path/traversal', { 'SKILL.md': 'x' })).rejects.toThrow('Invalid skill name');
    });

    it('throws for skill name with backslash', async () => {
      const store = new SkillVersionStore({ storageRoot: tmpRoot });
      await expect(store.save('path\\traversal', { 'SKILL.md': 'x' })).rejects.toThrow('Invalid skill name');
    });
  });

  describe('save edge cases', () => {
    it('trims whitespace-only reason to undefined', async () => {
      const store = new SkillVersionStore({ storageRoot: tmpRoot });
      const snapshot = await store.save('demo', { 'SKILL.md': 'x' }, '   ');
      expect(snapshot.reason).toBeUndefined();
    });

    it('skips files with empty key', async () => {
      const store = new SkillVersionStore({ storageRoot: tmpRoot });
      const snapshot = await store.save('demo', { '': 'content', 'SKILL.md': 'x' });
      expect(snapshot.files['']).toBeUndefined();
      expect(snapshot.files['SKILL.md']).toBe('x');
    });

    it('skips files with non-string content', async () => {
      const store = new SkillVersionStore({ storageRoot: tmpRoot });
      const snapshot = await store.save('demo', { 'SKILL.md': 'x', 'bad': 42 as any });
      expect(snapshot.files['bad']).toBeUndefined();
    });

    it('logs debug when saving with logger', async () => {
      const store = new SkillVersionStore({ storageRoot: tmpRoot, logger });
      await store.save('demo', { 'SKILL.md': 'x' }, 'test reason');
      expect(logger.debug).toHaveBeenCalled();
    });
  });

  describe('readDocument edge cases', () => {
    it('throws for corrupted JSON on disk (non-ENOENT)', async () => {
      const store = new SkillVersionStore({ storageRoot: tmpRoot });
      const docPath = path.join(tmpRoot, 'skills-versions', 'corrupt.json');
      await mkdir(path.dirname(docPath), { recursive: true });
      await writeFile(docPath, 'not-json!!!', 'utf8');
      await expect(store.list('corrupt')).rejects.toThrow('Failed to read skill version document');
    });

    it('returns empty document when file is non-record JSON', async () => {
      const store = new SkillVersionStore({ storageRoot: tmpRoot });
      const docPath = path.join(tmpRoot, 'skills-versions', 'array.json');
      await mkdir(path.dirname(docPath), { recursive: true });
      await writeFile(docPath, '[]', 'utf8');
      const listed = await store.list('array');
      expect(listed).toEqual([]);
    });

    it('handles document with non-array snapshots', async () => {
      const store = new SkillVersionStore({ storageRoot: tmpRoot });
      const docPath = path.join(tmpRoot, 'skills-versions', 'bad-snaps.json');
      await mkdir(path.dirname(docPath), { recursive: true });
      await writeFile(docPath, JSON.stringify({ current: '', snapshots: 'not-array' }), 'utf8');
      const listed = await store.list('bad-snaps');
      expect(listed).toEqual([]);
    });

    it('filters out invalid snapshots from disk', async () => {
      const store = new SkillVersionStore({ storageRoot: tmpRoot });
      const docPath = path.join(tmpRoot, 'skills-versions', 'mixed.json');
      await mkdir(path.dirname(docPath), { recursive: true });
      await writeFile(docPath, JSON.stringify({
        current: 'valid-id',
        snapshots: [
          { id: 'valid-id', timestamp: 1000, files: { 'a.md': 'content' } },
          'not-a-record',
          { id: '', timestamp: 1000, files: {} },
          { id: 'no-ts', files: {} },
          { id: 'bad-ts', timestamp: Infinity, files: {} },
          { id: 'no-files', timestamp: 1000, files: 'not-record' },
          null
        ]
      }), 'utf8');
      const listed = await store.list('mixed');
      expect(listed).toHaveLength(1);
      expect(listed[0]?.id).toBe('valid-id');
    });

    it('resets current when it points to non-existent snapshot', async () => {
      const store = new SkillVersionStore({ storageRoot: tmpRoot });
      const docPath = path.join(tmpRoot, 'skills-versions', 'orphan.json');
      await mkdir(path.dirname(docPath), { recursive: true });
      await writeFile(docPath, JSON.stringify({
        current: 'deleted-id',
        snapshots: [{ id: 'existing', timestamp: 1000, files: {} }]
      }), 'utf8');
      const listed = await store.list('orphan');
      expect(listed).toHaveLength(1);
    });

    it('handles non-string current in document', async () => {
      const store = new SkillVersionStore({ storageRoot: tmpRoot });
      const docPath = path.join(tmpRoot, 'skills-versions', 'num-cur.json');
      await mkdir(path.dirname(docPath), { recursive: true });
      await writeFile(docPath, JSON.stringify({
        current: 42,
        snapshots: [{ id: 'snap1', timestamp: 1000, files: {} }]
      }), 'utf8');
      const listed = await store.list('num-cur');
      expect(listed).toHaveLength(1);
    });
  });

  describe('parseSnapshot edge cases', () => {
    it('filters files with empty key or non-string content in snapshot', async () => {
      const store = new SkillVersionStore({ storageRoot: tmpRoot });
      const docPath = path.join(tmpRoot, 'skills-versions', 'bad-files.json');
      await mkdir(path.dirname(docPath), { recursive: true });
      await writeFile(docPath, JSON.stringify({
        current: 'snap1',
        snapshots: [{
          id: 'snap1', timestamp: 1000,
          files: { '': 'empty-key', 'good': 'content', 'bad': 123 },
          reason: 'test'
        }]
      }), 'utf8');
      const listed = await store.list('bad-files');
      expect(listed).toHaveLength(1);
    });

    it('includes reason only when non-empty string', async () => {
      const store = new SkillVersionStore({ storageRoot: tmpRoot });
      const docPath = path.join(tmpRoot, 'skills-versions', 'reason.json');
      await mkdir(path.dirname(docPath), { recursive: true });
      await writeFile(docPath, JSON.stringify({
        current: 'a',
        snapshots: [
          { id: 'a', timestamp: 1000, files: {}, reason: 'valid' },
          { id: 'b', timestamp: 2000, files: {}, reason: '' },
          { id: 'c', timestamp: 3000, files: {}, reason: 42 }
        ]
      }), 'utf8');
      const listed = await store.list('reason');
      const a = listed.find(s => s.id === 'a');
      const b = listed.find(s => s.id === 'b');
      const c = listed.find(s => s.id === 'c');
      expect(a?.reason).toBe('valid');
      expect(b?.reason).toBeUndefined();
      expect(c?.reason).toBeUndefined();
    });
  });

  describe('rollback edge cases', () => {
    it('returns null for empty snapshotId', async () => {
      const store = new SkillVersionStore({ storageRoot: tmpRoot });
      await store.save('demo', { 'SKILL.md': 'v1' });
      const result = await store.rollback('demo', '');
      expect(result).toBeNull();
    });

    it('returns null for whitespace-only snapshotId', async () => {
      const store = new SkillVersionStore({ storageRoot: tmpRoot });
      await store.save('demo', { 'SKILL.md': 'v1' });
      const result = await store.rollback('demo', '   ');
      expect(result).toBeNull();
    });

    it('returns null for non-existent snapshotId', async () => {
      const store = new SkillVersionStore({ storageRoot: tmpRoot });
      await store.save('demo', { 'SKILL.md': 'v1' });
      const result = await store.rollback('demo', 'nonexistent');
      expect(result).toBeNull();
    });

    it('logs info when rolling back with logger', async () => {
      const store = new SkillVersionStore({ storageRoot: tmpRoot, logger });
      const snap = await store.save('demo', { 'SKILL.md': 'v1' });
      await store.save('demo', { 'SKILL.md': 'v2' });
      await store.rollback('demo', snap.id);
      expect(logger.info).toHaveBeenCalled();
    });
  });

  describe('get edge cases', () => {
    it('returns null for empty snapshotId', async () => {
      const store = new SkillVersionStore({ storageRoot: tmpRoot });
      await store.save('demo', { 'SKILL.md': 'v1' });
      const result = await store.get('demo', '');
      expect(result).toBeNull();
    });

    it('returns null for null-like snapshotId', async () => {
      const store = new SkillVersionStore({ storageRoot: tmpRoot });
      await store.save('demo', { 'SKILL.md': 'v1' });
      const result = await store.get('demo', null as any);
      expect(result).toBeNull();
    });
  });

  describe('trimSnapshots edge cases', () => {
    it('preserves target snapshot during trim in rollback', async () => {
      const store = new SkillVersionStore({ storageRoot: tmpRoot, maxSnapshots: 3 });
      let now = 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => ++now);

      const first = await store.save('demo', { 'SKILL.md': 'v1' });
      await store.save('demo', { 'SKILL.md': 'v2' });
      await store.save('demo', { 'SKILL.md': 'v3' });

      const result = await store.rollback('demo', first.id);
      expect(result?.id).toBe(first.id);

      const doc = JSON.parse(await readFile(path.join(tmpRoot, 'skills-versions', 'demo.json'), 'utf8'));
      expect(doc.current).toBe(first.id);
      const hasFirst = doc.snapshots.some((s: any) => s.id === first.id);
      expect(hasFirst).toBe(true);
    });

    it('resets current after trimming removes current snapshot', async () => {
      const store = new SkillVersionStore({ storageRoot: tmpRoot, maxSnapshots: 2 });
      let now = 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => ++now);

      await store.save('demo', { 'SKILL.md': 'v1' });
      await store.save('demo', { 'SKILL.md': 'v2' });
      await store.save('demo', { 'SKILL.md': 'v3' });

      const doc = JSON.parse(await readFile(path.join(tmpRoot, 'skills-versions', 'demo.json'), 'utf8'));
      expect(doc.snapshots).toHaveLength(2);
      expect(doc.current).toBeTruthy();
    });
  });

  describe('resolveCurrentSnapshot edge cases', () => {
    it('falls back to last snapshot when current does not match', async () => {
      const store = new SkillVersionStore({ storageRoot: tmpRoot });
      const docPath = path.join(tmpRoot, 'skills-versions', 'orphan-cur.json');
      await mkdir(path.dirname(docPath), { recursive: true });
      await writeFile(docPath, JSON.stringify({
        current: 'non-existent',
        snapshots: [
          { id: 'a', timestamp: 1000, files: { 'SKILL.md': 'v1' } },
          { id: 'b', timestamp: 2000, files: { 'SKILL.md': 'v2' } }
        ]
      }), 'utf8');

      let now = 3000;
      vi.spyOn(Date, 'now').mockImplementation(() => ++now);
      const result = await store.rollback('orphan-cur', 'a');
      expect(result?.id).toBe('a');
    });
  });

  describe('writeDocument error', () => {
    it('throws when write fails', async () => {
      const badRoot = '/nonexistent/path/that/cannot/exist';
      const store = new SkillVersionStore({ storageRoot: badRoot });
      await expect(store.save('demo', { 'SKILL.md': 'x' })).rejects.toThrow();
    });
  });

  describe('readDocument non-ENOENT error', () => {
    it('throws for non-ENOENT read errors', async () => {
      const store = new SkillVersionStore({ storageRoot: tmpRoot });
      const docPath = path.join(tmpRoot, 'skills-versions', 'perm-err.json');
      await mkdir(path.dirname(docPath), { recursive: true });
      await mkdir(docPath, { recursive: true });
      await expect(store.list('perm-err')).rejects.toThrow('Failed to read skill version document');
    });
  });
});

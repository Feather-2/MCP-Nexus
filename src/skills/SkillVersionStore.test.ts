import os from 'os';
import path from 'path';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { SkillVersionStore } from './SkillVersionStore.js';

async function readVersionDoc(root: string, skillName: string): Promise<{ current: string; snapshots: Array<{ id: string; timestamp: number; files: Record<string, string>; reason?: string }> }> {
  const filePath = path.join(root, 'skills-versions', `${skillName}.json`);
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as { current: string; snapshots: Array<{ id: string; timestamp: number; files: Record<string, string>; reason?: string }> };
}

describe('SkillVersionStore', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'nexus-skill-versions-'));
  });

  afterEach(async () => {
    if (tmpRoot) {
      await rm(tmpRoot, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('save creates snapshot and persists document', async () => {
    const store = new SkillVersionStore({ storageRoot: tmpRoot });
    const snapshot = await store.save('demo', {
      'SKILL.md': '# Demo skill',
      'lib/helper.ts': 'export const value = 1;\n'
    }, 'user edit');

    expect(snapshot.id).toMatch(/^[a-f0-9]{8}$/);
    expect(snapshot.reason).toBe('user edit');
    expect(snapshot.files).toEqual({
      'SKILL.md': '# Demo skill',
      'lib/helper.ts': 'export const value = 1;\n'
    });

    const doc = await readVersionDoc(tmpRoot, 'demo');
    expect(doc.current).toBe(snapshot.id);
    expect(doc.snapshots).toHaveLength(1);
    expect(doc.snapshots[0]?.id).toBe(snapshot.id);
  });

  it('list returns snapshots in reverse chronological order', async () => {
    const store = new SkillVersionStore({ storageRoot: tmpRoot });
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(2000)
      .mockReturnValueOnce(3000);

    const first = await store.save('demo', { 'SKILL.md': 'v1' });
    const second = await store.save('demo', { 'SKILL.md': 'v2' });
    const third = await store.save('demo', { 'SKILL.md': 'v3' });

    const listed = await store.list('demo');
    expect(listed.map((item) => item.id)).toEqual([third.id, second.id, first.id]);
    expect(listed.map((item) => item.timestamp)).toEqual([3000, 2000, 1000]);
  });

  it('get returns snapshot by id and null for missing id', async () => {
    const store = new SkillVersionStore({ storageRoot: tmpRoot });
    const snapshot = await store.save('demo', { 'SKILL.md': 'v1' });

    const found = await store.get('demo', snapshot.id);
    const missing = await store.get('demo', 'deadbeef');

    expect(found?.id).toBe(snapshot.id);
    expect(missing).toBeNull();
  });

  it('rollback saves current state first and restores target snapshot', async () => {
    const store = new SkillVersionStore({ storageRoot: tmpRoot });
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(2000)
      .mockReturnValueOnce(3000);

    const original = await store.save('demo', { 'SKILL.md': 'v1' }, 'user edit');
    await store.save('demo', { 'SKILL.md': 'v2' }, 'user edit');

    const restored = await store.rollback('demo', original.id);
    expect(restored?.id).toBe(original.id);

    const doc = await readVersionDoc(tmpRoot, 'demo');
    expect(doc.current).toBe(original.id);
    expect(doc.snapshots).toHaveLength(3);

    const rollbackBackup = doc.snapshots.find((item) => item.reason === 'rollback');
    expect(rollbackBackup).toBeDefined();
    expect(rollbackBackup?.files['SKILL.md']).toBe('v2');
  });

  it('prunes oldest snapshots when maxSnapshots is exceeded', async () => {
    const store = new SkillVersionStore({ storageRoot: tmpRoot, maxSnapshots: 3 });
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      now += 1;
      return now;
    });

    const snapshots = [];
    for (let index = 1; index <= 5; index += 1) {
      snapshots.push(await store.save('demo', { 'SKILL.md': `v${index}` }));
    }

    const listed = await store.list('demo');
    expect(listed).toHaveLength(3);
    expect(listed.map((item) => item.id)).toEqual([
      snapshots[4]!.id,
      snapshots[3]!.id,
      snapshots[2]!.id
    ]);
  });

  it('skips files with size greater than or equal to 100KB', async () => {
    const store = new SkillVersionStore({ storageRoot: tmpRoot });
    const largeText = 'x'.repeat(100 * 1024);

    const snapshot = await store.save('demo', {
      'SKILL.md': '# demo',
      'assets/too-large.txt': largeText
    });

    expect(snapshot.files).toEqual({ 'SKILL.md': '# demo' });
  });

  it('returns empty list for non-existing skill', async () => {
    const store = new SkillVersionStore({ storageRoot: tmpRoot });
    const listed = await store.list('missing-skill');
    expect(listed).toEqual([]);
  });
});

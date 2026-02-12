import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { SkillVersionTracker } from './SkillVersionTracker.js';

describe('SkillVersionTracker', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'nexus-skill-version-tracker-'));
  });

  afterEach(async () => {
    if (tmpRoot) {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('records version history with SHA-256 hash', async () => {
    const tracker = new SkillVersionTracker({ storageRoot: tmpRoot });
    const content = '# Demo Skill\n\ncontent-v1';

    const versionHash = tracker.recordVersion('demo-skill', content, {
      modifiedBy: 'alice',
      reason: 'initial'
    });

    const expected = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    expect(versionHash).toBe(expected);

    const history = tracker.getVersionHistory('demo-skill');
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual({
      hash: expected,
      timestamp: expect.any(Number),
      content,
      metadata: {
        modifiedBy: 'alice',
        reason: 'initial'
      }
    });

    const storedPath = path.join(tmpRoot, 'data', 'skill-versions', 'demo-skill.json');
    const storedRaw = await readFile(storedPath, 'utf8');
    const stored = JSON.parse(storedRaw) as { versions: unknown[] };
    expect(Array.isArray(stored.versions)).toBe(true);
    expect(stored.versions).toHaveLength(1);
  });

  it('returns full version history in insertion order', () => {
    const tracker = new SkillVersionTracker({ storageRoot: tmpRoot });

    const firstHash = tracker.recordVersion('demo-skill', 'content-v1', { reason: 'v1' });
    const secondHash = tracker.recordVersion('demo-skill', 'content-v2', { reason: 'v2' });

    const history = tracker.getVersionHistory('demo-skill');
    expect(history.map((entry) => entry.hash)).toEqual([firstHash, secondHash]);
    expect(history[0]?.metadata.reason).toBe('v1');
    expect(history[1]?.metadata.reason).toBe('v2');
  });

  it('gets specific version by hash', () => {
    const tracker = new SkillVersionTracker({ storageRoot: tmpRoot });
    const hash = tracker.recordVersion('demo-skill', 'content-v1', { modifiedBy: 'bob' });

    const entry = tracker.getVersion('demo-skill', hash);
    expect(entry).not.toBeNull();
    expect(entry?.hash).toBe(hash);
    expect(entry?.metadata.modifiedBy).toBe('bob');
  });

  it('returns null when target version does not exist', () => {
    const tracker = new SkillVersionTracker({ storageRoot: tmpRoot });
    tracker.recordVersion('demo-skill', 'content-v1', {});

    expect(tracker.getVersion('demo-skill', 'missing-hash')).toBeNull();
    expect(tracker.getVersion('demo-skill', '')).toBeNull();
  });

  it('returns empty history for non-existent skill', () => {
    const tracker = new SkillVersionTracker({ storageRoot: tmpRoot });
    expect(tracker.getVersionHistory('missing-skill')).toEqual([]);
  });

  it('normalizes and filters metadata fields', async () => {
    const tracker = new SkillVersionTracker({ storageRoot: tmpRoot });
    tracker.recordVersion('demo-skill', 'content-v1', {
      modifiedBy: '  alice  ',
      reason: '  change reason  ',
      extra: 'ignored'
    } as unknown as object);

    const [entry] = tracker.getVersionHistory('demo-skill');
    expect(entry?.metadata).toEqual({
      modifiedBy: 'alice',
      reason: 'change reason'
    });

    const malformedPath = path.join(tmpRoot, 'data', 'skill-versions', 'malformed-skill.json');
    await mkdir(path.dirname(malformedPath), { recursive: true });
    await writeFile(malformedPath, JSON.stringify({
      versions: [
        { hash: 'invalid', timestamp: Date.now(), content: 'bad' },
        { hash: crypto.createHash('sha256').update('ok').digest('hex'), timestamp: Date.now(), content: 'ok', metadata: { modifiedBy: 'bob' } }
      ]
    }), 'utf8');

    const malformedHistory = tracker.getVersionHistory('malformed-skill');
    expect(malformedHistory).toHaveLength(1);
    expect(malformedHistory[0]?.content).toBe('ok');
  });

  it('throws for invalid skill ID values', () => {
    const tracker = new SkillVersionTracker({ storageRoot: tmpRoot });

    expect(() => tracker.recordVersion('', 'content', {})).toThrow('Skill id is required');
    expect(() => tracker.recordVersion('bad/id', 'content', {})).toThrow('Invalid skill id');
    expect(() => tracker.getVersionHistory('bad\\id')).toThrow('Invalid skill id');
  });
});

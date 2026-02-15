import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { InstancePersistence } from '../../gateway/InstancePersistence.js';
import type { Logger } from '../../types/index.js';

const mockLogger: Logger = {
  trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: () => mockLogger, level: 'info',
};

describe('InstancePersistence', () => {
  let tmpDir: string;
  let filePath: string;
  let persistence: InstancePersistence;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ip-test-'));
    filePath = path.join(tmpDir, 'instances.json');
    persistence = new InstancePersistence(mockLogger, filePath);
  });

  afterEach(async () => {
    await persistence.shutdown();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('starts with no entries', () => {
    expect(persistence.getAutostartEntries()).toEqual([]);
    expect(Object.keys(persistence.getAllEntries())).toHaveLength(0);
  });

  it('loads from empty (ENOENT) without error', async () => {
    await persistence.load();
    expect(persistence.getAutostartEntries()).toEqual([]);
  });

  it('tracks and retrieves an instance', () => {
    persistence.track('svc-1', 'my-template', { port: 3000 }, true);
    const all = persistence.getAllEntries();
    expect(all['svc-1']).toBeDefined();
    expect(all['svc-1'].templateName).toBe('my-template');
    expect(all['svc-1'].autostart).toBe(true);
    expect(all['svc-1'].overrides).toEqual({ port: 3000 });
  });

  it('untracks an instance', () => {
    persistence.track('svc-1', 'tpl');
    persistence.untrack('svc-1');
    expect(persistence.getAllEntries()['svc-1']).toBeUndefined();
  });

  it('untrack on non-existent is a no-op', () => {
    persistence.untrack('ghost');
    expect(Object.keys(persistence.getAllEntries())).toHaveLength(0);
  });

  it('filters autostart entries', () => {
    persistence.track('svc-1', 'tpl-a', undefined, true);
    persistence.track('svc-2', 'tpl-b', undefined, false);
    const autostart = persistence.getAutostartEntries();
    expect(autostart).toHaveLength(1);
    expect(autostart[0].templateName).toBe('tpl-a');
  });

  it('setAutostart toggles the flag', () => {
    persistence.track('svc-1', 'tpl', undefined, true);
    persistence.setAutostart('svc-1', false);
    expect(persistence.getAllEntries()['svc-1'].autostart).toBe(false);
  });

  it('markStarted updates lastStartedAt', () => {
    persistence.track('svc-1', 'tpl');
    const before = persistence.getAllEntries()['svc-1'].lastStartedAt;
    // Small delay to ensure different timestamp
    persistence.markStarted('svc-1');
    const after = persistence.getAllEntries()['svc-1'].lastStartedAt;
    expect(after).toBeDefined();
  });

  it('persists to disk and reloads', async () => {
    persistence.track('svc-1', 'tpl-a', { key: 'val' }, true);
    persistence.track('svc-2', 'tpl-b', undefined, false);
    await persistence.flush();

    const raw = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.version).toBe(1);
    expect(Object.keys(data.instances)).toHaveLength(2);

    // Reload in new instance
    const p2 = new InstancePersistence(mockLogger, filePath);
    await p2.load();
    expect(Object.keys(p2.getAllEntries())).toHaveLength(2);
    expect(p2.getAllEntries()['svc-1'].templateName).toBe('tpl-a');
  });

  it('handles corrupt file gracefully', async () => {
    await fs.writeFile(filePath, 'NOT JSON', 'utf-8');
    await persistence.load();
    expect(persistence.getAutostartEntries()).toEqual([]);
  });

  it('getAllEntries returns a copy', () => {
    persistence.track('svc-1', 'tpl');
    const copy = persistence.getAllEntries();
    delete copy['svc-1'];
    // Original should still have it
    expect(persistence.getAllEntries()['svc-1']).toBeDefined();
  });
});

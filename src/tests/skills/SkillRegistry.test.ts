import os from 'os';
import path from 'path';
import { mkdtemp, mkdir, rm, stat } from 'fs/promises';
import type { Logger } from '../../types/index.js';
import { SkillRegistry } from '../../skills/SkillRegistry.js';

function makeLogger(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

describe('SkillRegistry', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'nexus-skill-registry-'));
  });

  afterEach(async () => {
    if (tmpRoot) {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('validates roots during reload, creates managed root, and warns for missing roots', async () => {
    const managedRoot = path.join(tmpRoot, 'config', 'skills');
    const existingRoot = path.join(tmpRoot, 'skills');
    const missingRoot = path.join(tmpRoot, 'missing-skills');
    await mkdir(existingRoot, { recursive: true });

    const logger = makeLogger();
    const loadAllSkills = vi.fn().mockResolvedValue([]);
    const loader = {
      getDefaultRoots: () => [],
      loadAllSkills
    } as any;

    const registry = new SkillRegistry({
      logger,
      managedRoot,
      roots: [existingRoot, missingRoot],
      loader
    });

    await expect(registry.reload()).resolves.toBeUndefined();

    const managedStat = await stat(managedRoot);
    expect(managedStat.isDirectory()).toBe(true);

    expect(loadAllSkills).toHaveBeenCalledTimes(1);
    expect(loadAllSkills).toHaveBeenCalledWith(
      expect.arrayContaining([path.resolve(managedRoot), path.resolve(existingRoot)])
    );

    const scannedRoots = loadAllSkills.mock.calls[0][0] as string[];
    expect(scannedRoots).not.toContain(path.resolve(missingRoot));
    expect(logger.warn).toHaveBeenCalledWith('Skills root not accessible; skipping', {
      root: path.resolve(missingRoot)
    });
  });
});

import os from 'os';
import path from 'path';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from '../../types/index.js';
import { SkillRegistry } from '../../skills/SkillRegistry.js';
import type { Skill } from '../../skills/types.js';

function makeLogger(): Logger {
  return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeMockSkill(name: string, skillPath: string): Skill {
  return {
    metadata: { name, description: 'test', path: skillPath, scope: 'project' as const, keywords: [], keywordsAll: [] },
    body: 'Body.'
  };
}

const SKILL_MD = `---\nname: test-skill\ndescription: A test\n---\n\nBody.\n`;

describe('SkillRegistry – watch logic', () => {
  let tmpRoot: string;
  let managedRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'nexus-sr-watch-'));
    managedRoot = path.join(tmpRoot, 'managed');
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('watchRoot sets up watchers on directory tree and scheduleReload triggers reload', async () => {
    const logger = makeLogger();
    const externalRoot = path.join(tmpRoot, 'skills');
    const skillDir = path.join(externalRoot, 'my-skill');
    await mkdir(skillDir, { recursive: true });
    const skillMdPath = path.join(skillDir, 'SKILL.md');
    await writeFile(skillMdPath, SKILL_MD, 'utf8');

    const mockSkill = makeMockSkill('test-skill', skillMdPath);
    const loader = {
      getDefaultRoots: () => [],
      loadAllSkills: vi.fn().mockResolvedValue([mockSkill]),
      loadSkillFromSkillMd: vi.fn().mockResolvedValue(mockSkill)
    } as any;

    const registry = new SkillRegistry({ logger, managedRoot, roots: [externalRoot], loader });
    await registry.reload();
    expect(registry.get('test-skill')).toBeDefined();

    await registry.startWatch();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('watch started'), expect.any(Object));

    // Modify SKILL.md to trigger watcher
    await writeFile(skillMdPath, SKILL_MD.replace('A test', 'Updated desc'), 'utf8');

    // Wait for debounce (500ms) + margin
    await new Promise(r => setTimeout(r, 800));

    registry.stopWatch();
  });

  it('stopWatch clears debounce timer if pending', async () => {
    const logger = makeLogger();
    const registry = new SkillRegistry({ logger, managedRoot, roots: [] });
    await registry.reload();
    await registry.startWatch();

    // Access private scheduleReload to set a pending timer
    (registry as any).scheduleReload({ root: 'test' });
    expect((registry as any).reloadDebounceTimer).toBeDefined();

    registry.stopWatch();
    expect((registry as any).reloadDebounceTimer).toBeUndefined();
  });

  it('scheduleReload does nothing when watch is disabled', async () => {
    const logger = makeLogger();
    const registry = new SkillRegistry({ logger, managedRoot, roots: [] });
    await registry.reload();
    // Not calling startWatch, so watchEnabled = false
    (registry as any).scheduleReload({ root: 'test' });
    expect((registry as any).reloadDebounceTimer).toBeUndefined();
  });

  it('scheduleReload debounces rapid calls', async () => {
    const logger = makeLogger();
    const registry = new SkillRegistry({ logger, managedRoot, roots: [] });
    await registry.reload();
    await registry.startWatch();

    const reloadSpy = vi.spyOn(registry, 'reload').mockResolvedValue(undefined);

    // Rapid fire multiple scheduleReload calls
    (registry as any).scheduleReload({ root: 'a' });
    (registry as any).scheduleReload({ root: 'b' });
    (registry as any).scheduleReload({ root: 'c' });

    // Wait for debounce
    await new Promise(r => setTimeout(r, 700));

    // Should only have been called once
    expect(reloadSpy).toHaveBeenCalledTimes(1);

    registry.stopWatch();
    reloadSpy.mockRestore();
  });

  it('watchRoot handles inaccessible directory gracefully', async () => {
    const logger = makeLogger();
    const registry = new SkillRegistry({ logger, managedRoot, roots: ['/nonexistent/path/that/does/not/exist'] });
    await registry.reload();
    await registry.startWatch();
    // Should warn about inaccessible root
    expect(logger.warn).toHaveBeenCalled();
    registry.stopWatch();
  });

  it('watches nested directories up to max depth', async () => {
    const logger = makeLogger();
    const externalRoot = path.join(tmpRoot, 'deep');
    // Create a nested structure: deep/l1/l2/l3
    const l3 = path.join(externalRoot, 'l1', 'l2', 'l3');
    await mkdir(l3, { recursive: true });
    const skillMdPath = path.join(l3, 'SKILL.md');
    await writeFile(skillMdPath, SKILL_MD, 'utf8');

    const mockSkill = makeMockSkill('test-skill', skillMdPath);
    const loader = {
      getDefaultRoots: () => [],
      loadAllSkills: vi.fn().mockResolvedValue([mockSkill]),
      loadSkillFromSkillMd: vi.fn().mockResolvedValue(mockSkill)
    } as any;

    const registry = new SkillRegistry({ logger, managedRoot, roots: [externalRoot], loader });
    await registry.reload();
    expect(registry.get('test-skill')).toBeDefined();

    await registry.startWatch();
    // watchers map should have entries for multiple levels
    const watcherCount = (registry as any).watchers.size;
    expect(watcherCount).toBeGreaterThan(1);
    registry.stopWatch();
  });

  it('ignores .git and node_modules directories', async () => {
    const logger = makeLogger();
    const externalRoot = path.join(tmpRoot, 'ignore-test');
    await mkdir(path.join(externalRoot, '.git', 'objects'), { recursive: true });
    await mkdir(path.join(externalRoot, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(path.join(externalRoot, 'real-skill'), { recursive: true });
    await writeFile(path.join(externalRoot, 'real-skill', 'SKILL.md'), SKILL_MD, 'utf8');

    const registry = new SkillRegistry({ logger, managedRoot, roots: [externalRoot] });
    await registry.reload();
    await registry.startWatch();

    // .git and node_modules should not have watchers
    const watchedDirs = Array.from((registry as any).watchers.keys());
    expect(watchedDirs.some((d: string) => d.includes('.git'))).toBe(false);
    expect(watchedDirs.some((d: string) => d.includes('node_modules'))).toBe(false);

    registry.stopWatch();
  });

  it('tryWatchChildDirectory skips non-directory entries', async () => {
    const logger = makeLogger();
    const externalRoot = path.join(tmpRoot, 'child-test');
    await mkdir(externalRoot, { recursive: true });
    // Create a file (not directory)
    await writeFile(path.join(externalRoot, 'not-a-dir.txt'), 'hello', 'utf8');

    const registry = new SkillRegistry({ logger, managedRoot, roots: [externalRoot] });
    await registry.reload();

    // Call tryWatchChildDirectory directly on a file
    await (registry as any).tryWatchChildDirectory(externalRoot, externalRoot, 0, 'not-a-dir.txt');
    // Should not add any new watchers for the file
  });

  it('tryWatchChildDirectory skips when parentDepth >= max', async () => {
    const logger = makeLogger();
    const externalRoot = path.join(tmpRoot, 'depth-test');
    await mkdir(path.join(externalRoot, 'sub'), { recursive: true });

    const registry = new SkillRegistry({ logger, managedRoot, roots: [externalRoot] });
    await registry.reload();

    const beforeCount = (registry as any).watchers.size;
    await (registry as any).tryWatchChildDirectory(externalRoot, externalRoot, 5, 'sub');
    const afterCount = (registry as any).watchers.size;
    expect(afterCount).toBe(beforeCount);
  });

  it('tryWatchChildDirectory skips ignored dir names', async () => {
    const logger = makeLogger();
    const externalRoot = path.join(tmpRoot, 'ignored-test');
    await mkdir(path.join(externalRoot, 'node_modules'), { recursive: true });

    const registry = new SkillRegistry({ logger, managedRoot, roots: [externalRoot] });
    await registry.reload();

    const beforeCount = (registry as any).watchers.size;
    await (registry as any).tryWatchChildDirectory(externalRoot, externalRoot, 0, 'node_modules');
    expect((registry as any).watchers.size).toBe(beforeCount);
  });

  it('scheduleReload logs warning when reload fails', async () => {
    const logger = makeLogger();
    const registry = new SkillRegistry({ logger, managedRoot, roots: [] });
    await registry.reload();
    await registry.startWatch();

    vi.spyOn(registry, 'reload').mockRejectedValue(new Error('reload fail'));

    (registry as any).scheduleReload({ root: 'test' });
    await new Promise(r => setTimeout(r, 700));

    expect(logger.warn).toHaveBeenCalledWith('Failed to reload skills (watch)', expect.objectContaining({ error: 'reload fail' }));

    registry.stopWatch();
  });
});

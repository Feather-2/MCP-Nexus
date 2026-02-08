import os from 'os';
import path from 'path';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import type { Logger } from '../../types/index.js';
import { SkillRegistry } from '../../skills/SkillRegistry.js';
import { SkillLoader } from '../../skills/SkillLoader.js';

function makeLogger(): Logger {
  return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('SkillRegistry – register, delete, watch', () => {
  let tmpRoot: string;
  let managedRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'nexus-sr-cov-'));
    managedRoot = path.join(tmpRoot, 'managed');
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('register creates SKILL.md and get/list/delete work', async () => {
    const logger = makeLogger();
    const registry = new SkillRegistry({ logger, managedRoot, roots: [] });
    await registry.reload();

    const skill = await registry.register({
      name: 'Test Skill',
      description: 'A test skill',
      body: 'Do the thing.',
      keywords: ['test'],
      tags: { env: 'test' },
      traits: ['fast'],
      priority: 5,
      overwrite: false
    });

    expect(skill.metadata.name).toBe('Test Skill');
    expect(registry.get('test skill')).toBeDefined();
    expect(registry.list().length).toBe(1);
    expect(registry.all().length).toBe(1);

    // SKILL.md should exist on disk
    const mdPath = skill.metadata.path;
    const content = await readFile(mdPath, 'utf8');
    expect(content).toContain('Test Skill');
    expect(content).toContain('Do the thing.');

    // Duplicate without overwrite should throw
    await expect(registry.register({
      name: 'Test Skill', description: 'dup', body: 'dup', overwrite: false
    })).rejects.toThrow('Skill already exists');

    // Overwrite should succeed
    const updated = await registry.register({
      name: 'Test Skill', description: 'updated', body: 'Updated body.', overwrite: true
    });
    expect(updated.body).toContain('Updated body.');

    // Delete
    const deleted = await registry.delete('Test Skill');
    expect(deleted).toBe(true);
    expect(registry.get('test skill')).toBeUndefined();

    // Delete non-existent
    expect(await registry.delete('nope')).toBe(false);
  });

  it('register with support files writes them to disk', async () => {
    const registry = new SkillRegistry({ managedRoot, roots: [] });
    await registry.reload();

    const skill = await registry.register({
      name: 'with-files',
      description: 'Has support files',
      body: 'Main body.',
      supportFiles: [
        { path: 'helpers/utils.md', content: '# Utils' },
        { path: 'data.json', content: '{"key": 1}' }
      ],
      overwrite: false
    });

    const dir = path.dirname(skill.metadata.path);
    const utilsContent = await readFile(path.join(dir, 'helpers', 'utils.md'), 'utf8');
    expect(utilsContent).toBe('# Utils');
    const dataContent = await readFile(path.join(dir, 'data.json'), 'utf8');
    expect(dataContent).toBe('{"key": 1}');
  });

  it('register rejects invalid name', async () => {
    const registry = new SkillRegistry({ managedRoot, roots: [] });
    await registry.reload();
    await expect(registry.register({
      name: '', description: 'empty', body: 'body', overwrite: false
    })).rejects.toThrow('Skill name is required');
  });

  it('register rejects path traversal in support files', async () => {
    const registry = new SkillRegistry({ managedRoot, roots: [] });
    await registry.reload();
    await expect(registry.register({
      name: 'traversal-test',
      description: 'bad path',
      body: 'body',
      supportFiles: [{ path: '../../../etc/passwd', content: 'evil' }],
      overwrite: false
    })).rejects.toThrow('Invalid support file path');
  });

  it('delete throws for non-managed skill', async () => {
    const externalRoot = path.join(tmpRoot, 'external');
    await mkdir(externalRoot, { recursive: true });
    const skillDir = path.join(externalRoot, 'ext-skill');
    await mkdir(skillDir, { recursive: true });
    const skillMdPath = path.join(skillDir, 'SKILL.md');
    await writeFile(skillMdPath, '---\nname: ext-skill\ndescription: external\n---\n\nExternal body.\n', 'utf8');

    const externalSkill = {
      metadata: { name: 'ext-skill', description: 'external', path: skillMdPath, scope: 'project' as const, keywords: [], keywordsAll: [] },
      body: 'External body.'
    };
    const loader = {
      getDefaultRoots: () => [],
      loadAllSkills: vi.fn().mockResolvedValue([externalSkill]),
      loadSkillFromSkillMd: vi.fn().mockResolvedValue(externalSkill)
    } as any;

    const registry = new SkillRegistry({ managedRoot, roots: [externalRoot], loader });
    await registry.reload();
    expect(registry.get('ext-skill')).toBeDefined();

    await expect(registry.delete('ext-skill')).rejects.toThrow('not managed');
  });

  it('getManagedRoot returns configured root', () => {
    const registry = new SkillRegistry({ managedRoot: '/tmp/test-managed', roots: [] });
    expect(registry.getManagedRoot()).toBe('/tmp/test-managed');
  });

  it('startWatch and stopWatch toggle without errors', async () => {
    const logger = makeLogger();
    const registry = new SkillRegistry({ logger, managedRoot, roots: [] });
    await registry.reload();

    await registry.startWatch();
    // Double start should be idempotent
    await registry.startWatch();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Starting'), expect.any(Object));

    registry.stopWatch();
    // Double stop should be idempotent
    registry.stopWatch();
  });
});

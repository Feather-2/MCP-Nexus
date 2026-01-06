import os from 'os';
import path from 'path';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { SkillLoader } from '../../skills/SkillLoader.js';

describe('SkillLoader', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'nexus-skills-'));
  });

  afterEach(async () => {
    if (tmpRoot) {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('discovers SKILL.md, parses frontmatter, and loads support files', async () => {
    const skillDir = path.join(tmpRoot, 'my-skill');
    await mkdir(path.join(skillDir, 'scripts'), { recursive: true });
    await mkdir(path.join(skillDir, 'references'), { recursive: true });

    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: my-skill',
        'description: Test skill',
        'capabilities:',
        '  filesystem:',
        '    read: ["./"]',
        '    write: []',
        '  network:',
        '    allowedHosts: []',
        '    allowedPorts: []',
        '  env: []',
        '  subprocess:',
        '    allowed: false',
        '    allowedCommands: []',
        '  resources:',
        '    maxMemoryMB: 512',
        '    maxCpuPercent: 50',
        '    timeoutMs: 60000',
        'metadata:',
        '  short-description: Quick',
        '  keywords: [sql, database]',
        '  tags:',
        '    domain: test',
        '  traits: [safe]',
        '  allowedTools: "sqlite, filesystem"',
        '  priority: 50',
        '---',
        '',
        '# My Skill',
        '',
        'Use it.'
      ].join('\n'),
      'utf8'
    );

    await writeFile(path.join(skillDir, 'scripts', 'hello.sh'), 'echo hello\n', 'utf8');
    await writeFile(path.join(skillDir, 'references', 'ref.md'), '# ref\n', 'utf8');

    const loader = new SkillLoader({ loadSupportFiles: true });
    const skills = await loader.loadAllSkills([tmpRoot]);

    expect(skills).toHaveLength(1);
    const skill = skills[0]!;
    expect(skill.metadata.name).toBe('my-skill');
    expect(skill.metadata.description).toBe('Test skill');
    expect(skill.metadata.shortDescription).toBe('Quick');
    expect(skill.metadata.allowedTools).toContain('sqlite');
    expect(skill.metadata.keywordsAll).toEqual(expect.arrayContaining(['sql', 'database', 'test']));
    expect(skill.body).toContain('Use it.');

    expect(skill.supportFiles).toBeDefined();
    expect(Object.fromEntries(skill.supportFiles!.entries())).toEqual(
      expect.objectContaining({
        'scripts/hello.sh': 'echo hello\n',
        'references/ref.md': '# ref\n'
      })
    );
  });
});

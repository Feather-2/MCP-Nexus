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

  it('verifies HMAC signature from frontmatter when signature enforcement is enabled', async () => {
    const skillDir = path.join(tmpRoot, 'signed-skill');
    await mkdir(skillDir, { recursive: true });

    const frontmatter = {
      name: 'signed-skill',
      description: 'Signed skill',
      capabilities: {
        filesystem: { read: ['./'], write: [] },
        network: { allowedHosts: [], allowedPorts: [] },
        env: [],
        subprocess: { allowed: false, allowedCommands: [] },
        resources: { maxMemoryMB: 256, maxCpuPercent: 50, timeoutMs: 10_000 }
      }
    };
    const body = '# Signed Skill\n\nRun safely.';
    const secret = 'skill-signature-secret';
    const signature = SkillLoader.computeSignature(frontmatter, body, secret);

    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        `signature: ${signature}`,
        'name: signed-skill',
        'description: Signed skill',
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
        '    maxMemoryMB: 256',
        '    maxCpuPercent: 50',
        '    timeoutMs: 10000',
        '---',
        '',
        body
      ].join('\n'),
      'utf8'
    );

    const loader = new SkillLoader({ signatureSecret: secret, enforceSignatures: true });
    const loaded = await loader.loadSkillFromDir(skillDir);

    expect(loaded).not.toBeNull();
    expect(loaded?.metadata.name).toBe('signed-skill');
  });

  it('rejects a skill when signature does not match content', async () => {
    const skillDir = path.join(tmpRoot, 'tampered-skill');
    await mkdir(skillDir, { recursive: true });

    const frontmatter = {
      name: 'tampered-skill',
      description: 'Tampered',
      capabilities: {
        filesystem: { read: ['./'], write: [] },
        network: { allowedHosts: [], allowedPorts: [] },
        env: [],
        subprocess: { allowed: false, allowedCommands: [] },
        resources: { maxMemoryMB: 256, maxCpuPercent: 50, timeoutMs: 10_000 }
      }
    };
    const originalBody = '# Skill\n\nOriginal body.';
    const tamperedBody = '# Skill\n\nTampered body.';
    const secret = 'skill-signature-secret';
    const signature = SkillLoader.computeSignature(frontmatter, originalBody, secret);
    const warn = vi.fn();

    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        `signature: ${signature}`,
        'name: tampered-skill',
        'description: Tampered',
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
        '    maxMemoryMB: 256',
        '    maxCpuPercent: 50',
        '    timeoutMs: 10000',
        '---',
        '',
        tamperedBody
      ].join('\n'),
      'utf8'
    );

    const loader = new SkillLoader({
      signatureSecret: secret,
      enforceSignatures: true,
      logger: { warn } as any
    });
    const loaded = await loader.loadSkillFromDir(skillDir);

    expect(loaded).toBeNull();
    expect(String(warn.mock.calls[0]?.[1]?.error || '')).toContain('signature mismatch');
  });

  it('rejects unsigned skills when signature enforcement is enabled', async () => {
    const skillDir = path.join(tmpRoot, 'unsigned-skill');
    await mkdir(skillDir, { recursive: true });
    const warn = vi.fn();

    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: unsigned-skill',
        'description: Missing signature',
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
        '    maxMemoryMB: 128',
        '    maxCpuPercent: 30',
        '    timeoutMs: 5000',
        '---',
        '',
        'No signature'
      ].join('\n'),
      'utf8'
    );

    const loader = new SkillLoader({
      signatureSecret: 'skill-signature-secret',
      enforceSignatures: true,
      logger: { warn } as any
    });
    const loaded = await loader.loadSkillFromDir(skillDir);

    expect(loaded).toBeNull();
    expect(String(warn.mock.calls[0]?.[1]?.error || '')).toContain('signature is required');
  });
});

import os from 'os';
import path from 'path';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { SkillLoader } from '../../skills/SkillLoader.js';
import { SkillResigner } from '../../skills/SkillResigner.js';

describe('SkillResigner', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'nexus-skill-resigner-'));
  });

  afterEach(async () => {
    if (tmpRoot) {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('resigns tampered skill and verifies it can be loaded', async () => {
    const skillDir = path.join(tmpRoot, 'demo-skill');
    await mkdir(skillDir, { recursive: true });
    const skillMdPath = path.join(skillDir, 'SKILL.md');
    const secret = 'skill-signature-secret';

    const frontmatter = {
      name: 'demo-skill',
      description: 'Demo skill',
      capabilities: {
        filesystem: { read: ['./'], write: [] },
        network: { allowedHosts: [], allowedPorts: [] },
        env: [],
        subprocess: { allowed: false, allowedCommands: [] },
        resources: { maxMemoryMB: 256, maxCpuPercent: 50, timeoutMs: 10_000 }
      }
    };
    const originalBody = '# Demo\n\nOriginal body';
    const tamperedBody = '# Demo\n\nTampered body';
    const signature = SkillLoader.computeSignature(frontmatter, originalBody, secret);

    await writeFile(
      skillMdPath,
      [
        '---',
        `signature: ${signature}`,
        'name: demo-skill',
        'description: Demo skill',
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

    const resigner = new SkillResigner({ signatureSecret: secret });
    const resignResult = await resigner.resign(skillMdPath);
    expect(resignResult.signature).toMatch(/^[0-9a-f]{64}$/);

    const loader = new SkillLoader({ signatureSecret: secret, enforceSignatures: true });
    const loaded = await loader.loadSkillFromSkillMd(skillMdPath);
    expect(loaded).not.toBeNull();
    expect(loaded?.metadata.name).toBe('demo-skill');
  });
});

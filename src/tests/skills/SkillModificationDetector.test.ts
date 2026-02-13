import os from 'os';
import path from 'path';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { SkillLoader } from '../../skills/SkillLoader.js';
import { SkillModificationDetector } from '../../skills/SkillModificationDetector.js';

describe('SkillModificationDetector', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'nexus-skill-mod-detector-'));
  });

  afterEach(async () => {
    if (tmpRoot) {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('detects signature mismatch as modified and returns diff summary', async () => {
    const skillDir = path.join(tmpRoot, 'demo-skill');
    await mkdir(skillDir, { recursive: true });
    const skillMdPath = path.join(skillDir, 'SKILL.md');

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
    const beforeBody = '# Demo\n\nOriginal body';
    const afterBody = '# Demo\n\nTampered body';
    const secret = 'skill-signature-secret';
    const signature = SkillLoader.computeSignature(frontmatter, beforeBody, secret);

    const previousContent = [
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
      beforeBody
    ].join('\n');

    const currentContent = [
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
      afterBody
    ].join('\n');
    await writeFile(skillMdPath, currentContent, 'utf8');

    const detector = new SkillModificationDetector({ signatureSecret: secret });
    const detected = await detector.detectModification(skillMdPath, previousContent);

    expect(detected.isModified).toBe(true);
    expect(detected.reason).toBe('signature_mismatch');
    expect(detected.summary?.bodyChanged).toBe(true);
    expect(detected.summary?.changedFields).toContain('body');
    expect(detected.diff?.lines.some((line) => line.type === 'added' && line.content.includes('Tampered body'))).toBe(true);
  });

  it('returns signature_valid when signature matches', async () => {
    const skillDir = path.join(tmpRoot, 'valid-skill');
    await mkdir(skillDir, { recursive: true });
    const skillMdPath = path.join(skillDir, 'SKILL.md');

    const frontmatter = {
      name: 'valid-skill',
      description: 'Valid skill',
      capabilities: {
        filesystem: { read: ['./'], write: [] },
        network: { allowedHosts: [], allowedPorts: [] },
        env: [],
        subprocess: { allowed: false, allowedCommands: [] },
        resources: { maxMemoryMB: 256, maxCpuPercent: 50, timeoutMs: 10_000 }
      }
    };
    const body = '# Demo\n\nBody';
    const secret = 'skill-signature-secret';
    const signature = SkillLoader.computeSignature(frontmatter, body, secret);

    await writeFile(
      skillMdPath,
      [
        '---',
        `signature: ${signature}`,
        'name: valid-skill',
        'description: Valid skill',
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

    const detector = new SkillModificationDetector({ signatureSecret: secret });
    const detected = await detector.detectModification(skillMdPath);
    expect(detected.isModified).toBe(false);
    expect(detected.reason).toBe('signature_valid');
  });
});

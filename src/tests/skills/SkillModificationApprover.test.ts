import os from 'os';
import path from 'path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { AuditLogger } from '../../security/AuditLogger.js';
import { SkillLoader } from '../../skills/SkillLoader.js';
import { SkillModificationApprover } from '../../skills/SkillModificationApprover.js';
import { SkillModificationDetector } from '../../skills/SkillModificationDetector.js';
import { SkillResigner } from '../../skills/SkillResigner.js';

async function createTamperedSkill(tmpRoot: string, secret: string): Promise<{
  skillMdPath: string;
  previousContent: string;
}> {
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
  const originalBody = '# Demo\n\nOriginal body';
  const tamperedBody = '# Demo\n\nTampered body';
  const signature = SkillLoader.computeSignature(frontmatter, originalBody, secret);

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
    originalBody
  ].join('\n');

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

  return { skillMdPath, previousContent };
}

describe('SkillModificationApprover', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'nexus-skill-mod-approver-'));
  });

  afterEach(async () => {
    if (tmpRoot) {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('approves pending modification and auto-resigns the skill', async () => {
    const secret = 'skill-signature-secret';
    const { skillMdPath, previousContent } = await createTamperedSkill(tmpRoot, secret);

    const detector = new SkillModificationDetector({ signatureSecret: secret });
    const detection = await detector.detectModification(skillMdPath, previousContent);
    expect(detection.isModified).toBe(true);

    const approver = new SkillModificationApprover({
      storeFilePath: path.join(tmpRoot, 'modifications.json'),
      auditLogger: new AuditLogger({ filePath: path.join(tmpRoot, 'audit.log') }),
      resigner: new SkillResigner({ signatureSecret: secret })
    });

    const pending = await approver.createPendingRecord({
      skillMdPath,
      skillName: 'demo-skill',
      detection
    });
    expect(pending.status).toBe('pending');

    const approved = await approver.approve(pending.id, 'reviewer-1', 'looks good');
    expect(approved?.status).toBe('approved');
    expect(approved?.signature).toMatch(/^[0-9a-f]{64}$/);

    const loader = new SkillLoader({ signatureSecret: secret, enforceSignatures: true });
    const loaded = await loader.loadSkillFromSkillMd(skillMdPath);
    expect(loaded).not.toBeNull();

    const logLines = (await readFile(path.join(tmpRoot, 'audit.log'), 'utf8')).trim().split('\n');
    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toContain('skill_modification_approved');
  });

  it('rejects pending modification and records audit decision', async () => {
    const secret = 'skill-signature-secret';
    const { skillMdPath, previousContent } = await createTamperedSkill(tmpRoot, secret);
    const detector = new SkillModificationDetector({ signatureSecret: secret });
    const detection = await detector.detectModification(skillMdPath, previousContent);

    const approver = new SkillModificationApprover({
      storeFilePath: path.join(tmpRoot, 'modifications.json'),
      auditLogger: new AuditLogger({ filePath: path.join(tmpRoot, 'audit.log') }),
      resigner: new SkillResigner({ signatureSecret: secret })
    });

    const pending = await approver.createPendingRecord({
      skillMdPath,
      skillName: 'demo-skill',
      detection
    });
    const rejected = await approver.reject(pending.id, 'reviewer-2', 'unexpected changes');

    expect(rejected?.status).toBe('rejected');
    expect(rejected?.decisionBy).toBe('reviewer-2');

    const logLines = (await readFile(path.join(tmpRoot, 'audit.log'), 'utf8')).trim().split('\n');
    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toContain('skill_modification_rejected');
  });
});

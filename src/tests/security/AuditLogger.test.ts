import os from 'os';
import path from 'path';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { AuditLogger } from '../../security/AuditLogger.js';

describe('AuditLogger', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'nexus-audit-log-'));
  });

  afterEach(async () => {
    if (tmpRoot) {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('persists append-only entries with a SHA-256 hash chain', async () => {
    const logPath = path.join(tmpRoot, 'audit.log');
    const logger = new AuditLogger({ filePath: logPath });

    const first = await logger.append({
      action: 'load',
      skillId: 'skill-a',
      userId: 'user-1',
      result: 'allow'
    });
    const second = await logger.append({
      action: 'execute',
      skillId: 'skill-a',
      userId: 'user-1',
      result: 'deny'
    });

    expect(first.prevHash).toBe('0'.repeat(64));
    expect(second.prevHash).toBe(first.hash);
    expect(await logger.verifyChain()).toBe(true);

    const lines = (await readFile(logPath, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('detects hash-chain corruption after tampering', async () => {
    const logPath = path.join(tmpRoot, 'audit.log');
    const logger = new AuditLogger({ filePath: logPath });

    await logger.append({
      action: 'load',
      skillId: 'skill-a',
      userId: 'user-1',
      result: 'allow'
    });
    await logger.append({
      action: 'execute',
      skillId: 'skill-a',
      userId: 'user-1',
      result: 'allow'
    });

    const lines = (await readFile(logPath, 'utf8')).trim().split('\n');
    const first = JSON.parse(lines[0] || '{}') as Record<string, unknown>;
    first.result = 'tampered';
    lines[0] = JSON.stringify(first);
    await writeFile(logPath, `${lines.join('\n')}\n`, 'utf8');

    expect(await logger.verifyChain()).toBe(false);
  });
});

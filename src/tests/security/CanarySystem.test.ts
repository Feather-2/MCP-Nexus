import os from 'os';
import path from 'path';
import { appendFile, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'fs/promises';
import { checkCanaryAccess, setupCanaries } from '../../security/CanarySystem.js';

describe('CanarySystem', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'nexus-canary-'));
  });

  afterEach(async () => {
    if (tmpRoot) {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('setupCanaries() creates decoy files with unique tokens', async () => {
    const setup = await setupCanaries(tmpRoot);

    expect(setup.sandboxRoot).toBe(tmpRoot);
    expect(setup.canaries).toHaveLength(4);

    const tokens = setup.canaries.map((c) => c.token);
    expect(new Set(tokens).size).toBe(tokens.length);

    for (const canary of setup.canaries) {
      const absPath = path.join(tmpRoot, canary.relativePath);
      const content = await readFile(absPath, { encoding: 'utf8' });
      expect(content).toContain(canary.token);
      const info = await stat(absPath);
      expect(info.size).toBeGreaterThan(0);
    }

    const stateRaw = await readFile(setup.stateFilePath, { encoding: 'utf8' });
    const state = JSON.parse(stateRaw) as any;
    expect(state.version).toBe(1);
    expect(state.canaries).toHaveLength(4);
  });

  it('checkCanaryAccess() returns not-triggered when untouched', async () => {
    await setupCanaries(tmpRoot);
    const result = await checkCanaryAccess(tmpRoot);
    expect(result).toEqual({ triggered: false, accessedFiles: [] });
  });

  it('checkCanaryAccess() detects reading a decoy file', async () => {
    await setupCanaries(tmpRoot);

    const before = await checkCanaryAccess(tmpRoot);
    expect(before.triggered).toBe(false);

    await readFile(path.join(tmpRoot, '.env'), { encoding: 'utf8' });

    const after = await checkCanaryAccess(tmpRoot);
    expect(after.triggered).toBe(true);
    expect(after.accessedFiles).toContain('.env');
  });

  it('checkCanaryAccess() detects modification/deletion of a decoy file', async () => {
    await setupCanaries(tmpRoot);

    await appendFile(path.join(tmpRoot, '.npmrc'), '\n# touched\n', { encoding: 'utf8' });
    await unlink(path.join(tmpRoot, '.ssh', 'id_rsa'));

    const result = await checkCanaryAccess(tmpRoot);
    expect(result.triggered).toBe(true);
    expect(result.accessedFiles).toContain('.npmrc');
    expect(result.accessedFiles).toContain('.ssh/id_rsa');
  });

  it('checkCanaryAccess() treats missing/invalid state as triggered', async () => {
    const setup = await setupCanaries(tmpRoot);
    await writeFile(setup.stateFilePath, JSON.stringify({ version: 2 }), { encoding: 'utf8' });

    const result = await checkCanaryAccess(tmpRoot);
    expect(result.triggered).toBe(true);
    expect(result.accessedFiles.sort()).toEqual(['.aws/credentials', '.env', '.npmrc', '.ssh/id_rsa'].sort());
  });
});


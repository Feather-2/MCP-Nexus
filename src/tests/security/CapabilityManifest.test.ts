import os from 'os';
import path from 'path';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { SkillLoader } from '../../skills/SkillLoader.js';
import {
  DEFAULT_SKILL_CAPABILITIES,
  mergeWithDefaults,
  validateCapabilities
} from '../../security/CapabilityManifest.js';

describe('CapabilityManifest', () => {
  it('mergeWithDefaults() returns a deep copy of defaults', () => {
    const merged = mergeWithDefaults(undefined);

    expect(merged).toEqual(DEFAULT_SKILL_CAPABILITIES);
    expect(merged).not.toBe(DEFAULT_SKILL_CAPABILITIES);
    expect(merged.filesystem.read).not.toBe(DEFAULT_SKILL_CAPABILITIES.filesystem.read);
    expect(merged.network.allowedPorts).not.toBe(DEFAULT_SKILL_CAPABILITIES.network.allowedPorts);
    expect(merged.resources).not.toBe(DEFAULT_SKILL_CAPABILITIES.resources);
  });

  it('mergeWithDefaults() fills missing fields and normalizes values', () => {
    const merged = mergeWithDefaults({
      filesystem: { read: ['  ./data  '], write: [] },
      network: { allowedHosts: ['example.com'], allowedPorts: ['443', 80] as any },
      env: ['OPENAI_API_KEY'],
      subprocess: { allowed: true, allowedCommands: ['git'] },
      resources: { maxMemoryMB: '256', maxCpuPercent: '25', timeoutMs: '5000' } as any
    });

    expect(merged.filesystem.read).toEqual(['./data']);
    expect(merged.network.allowedPorts).toEqual([443, 80]);
    expect(merged.resources).toEqual({ maxMemoryMB: 256, maxCpuPercent: 25, timeoutMs: 5000 });

    expect(() => validateCapabilities(merged)).not.toThrow();
  });

  it('validateCapabilities() accepts the default manifest', () => {
    expect(() => validateCapabilities(DEFAULT_SKILL_CAPABILITIES)).not.toThrow();
  });

  it('validateCapabilities() rejects invalid env var names', () => {
    const caps = {
      filesystem: { read: [], write: [] },
      network: { allowedHosts: [], allowedPorts: [] },
      env: ['BAD-NAME'],
      subprocess: { allowed: false, allowedCommands: [] },
      resources: { maxMemoryMB: 64, maxCpuPercent: 50, timeoutMs: 1000 }
    };

    expect(() => validateCapabilities(caps)).toThrow('invalid env var name');
  });

  it('validateCapabilities() reports structural/type errors', () => {
    const base = mergeWithDefaults(undefined);

    expect(() => validateCapabilities(null)).toThrow('capabilities must be an object');

    expect(() => validateCapabilities({ ...base, filesystem: 'nope' } as any)).toThrow('capabilities.filesystem must be an object');
    expect(() => validateCapabilities({ ...base, filesystem: { ...base.filesystem, read: 'x' } } as any)).toThrow(
      'capabilities.filesystem.read must be an array'
    );
    expect(() => validateCapabilities({ ...base, filesystem: { ...base.filesystem, read: [''] } } as any)).toThrow(
      'must contain non-empty strings'
    );

    expect(() => validateCapabilities({ ...base, network: 'nope' } as any)).toThrow('capabilities.network must be an object');
    expect(() => validateCapabilities({ ...base, network: { ...base.network, allowedHosts: 'x' } } as any)).toThrow(
      'capabilities.network.allowedHosts must be an array'
    );
    expect(() => validateCapabilities({ ...base, network: { ...base.network, allowedPorts: 'x' } } as any)).toThrow(
      'capabilities.network.allowedPorts must be an array'
    );
    expect(() => validateCapabilities({ ...base, network: { ...base.network, allowedPorts: ['443'] } } as any)).toThrow(
      'must contain numbers'
    );

    expect(() => validateCapabilities({ ...base, env: 'OPENAI_API_KEY' } as any)).toThrow('capabilities.env must be an array');

    expect(() => validateCapabilities({ ...base, subprocess: 'nope' } as any)).toThrow('capabilities.subprocess must be an object');
    expect(() =>
      validateCapabilities({ ...base, subprocess: { ...base.subprocess, allowed: 'yes' } } as any)
    ).toThrow('capabilities.subprocess.allowed must be a boolean');
    expect(() =>
      validateCapabilities({ ...base, subprocess: { ...base.subprocess, allowedCommands: 'git' } } as any)
    ).toThrow('capabilities.subprocess.allowedCommands must be an array');
    expect(() =>
      validateCapabilities({ ...base, subprocess: { allowed: true, allowedCommands: [] } } as any)
    ).toThrow('subprocess.allowed=true');

    expect(() => validateCapabilities({ ...base, resources: 'nope' } as any)).toThrow('capabilities.resources must be an object');
    expect(() =>
      validateCapabilities({ ...base, resources: { ...base.resources, maxMemoryMB: '64' } } as any)
    ).toThrow('capabilities.resources.maxMemoryMB must be a number');
    expect(() =>
      validateCapabilities({ ...base, resources: { ...base.resources, timeoutMs: 1.5 } } as any)
    ).toThrow('must be an integer');
    expect(() =>
      validateCapabilities({ ...base, resources: { ...base.resources, maxCpuPercent: 101 } } as any)
    ).toThrow('between 1 and 100');
  });

  it('validateCapabilities() rejects invalid ports and subprocess mismatches', () => {
    const badPort = {
      filesystem: { read: [], write: [] },
      network: { allowedHosts: [], allowedPorts: [0] },
      env: [],
      subprocess: { allowed: false, allowedCommands: [] },
      resources: { maxMemoryMB: 64, maxCpuPercent: 50, timeoutMs: 1000 }
    };
    expect(() => validateCapabilities(badPort)).toThrow('capabilities.network.allowedPorts');

    const mismatch = {
      filesystem: { read: [], write: [] },
      network: { allowedHosts: [], allowedPorts: [443] },
      env: [],
      subprocess: { allowed: false, allowedCommands: ['git'] },
      resources: { maxMemoryMB: 64, maxCpuPercent: 50, timeoutMs: 1000 }
    };
    expect(() => validateCapabilities(mismatch)).toThrow('subprocess.allowed=false');
  });

  it('mergeWithDefaults() throws on invalid field types', () => {
    expect(() => mergeWithDefaults('nope' as any)).toThrow('capabilities must be an object');
    expect(() => mergeWithDefaults({ env: 'OPENAI_API_KEY' } as any)).toThrow('capabilities.env must be an array');
    expect(() => mergeWithDefaults({ filesystem: 'nope' } as any)).toThrow('capabilities.filesystem must be an object');
    expect(() => mergeWithDefaults({ network: 'nope' } as any)).toThrow('capabilities.network must be an object');
    expect(() => mergeWithDefaults({ subprocess: 'nope' } as any)).toThrow('capabilities.subprocess must be an object');
    expect(() => mergeWithDefaults({ resources: 'nope' } as any)).toThrow('capabilities.resources must be an object');
  });

  it('mergeWithDefaults() rejects invalid number formats', () => {
    expect(() =>
      mergeWithDefaults({
        network: { allowedHosts: [], allowedPorts: ['not-a-number'] as any },
        filesystem: { read: [], write: [] },
        env: [],
        subprocess: { allowed: false, allowedCommands: [] },
        resources: { maxMemoryMB: 64, maxCpuPercent: 50, timeoutMs: 1000 }
      } as any)
    ).toThrow('non-numeric value');

    expect(() =>
      mergeWithDefaults({
        network: { allowedHosts: [], allowedPorts: [null] as any },
        filesystem: { read: [], write: [] },
        env: [],
        subprocess: { allowed: false, allowedCommands: [] },
        resources: { maxMemoryMB: 64, maxCpuPercent: 50, timeoutMs: 1000 }
      } as any)
    ).toThrow('invalid value');

    expect(() =>
      mergeWithDefaults({
        resources: { maxMemoryMB: '1.5', maxCpuPercent: 50, timeoutMs: 1000 } as any,
        filesystem: { read: [], write: [] },
        network: { allowedHosts: [], allowedPorts: [] },
        env: [],
        subprocess: { allowed: false, allowedCommands: [] }
      } as any)
    ).toThrow('capabilities.resources.maxMemoryMB must be an integer');
  });

  it('mergeWithDefaults() normalizes explicit undefined arrays', () => {
    const merged = mergeWithDefaults({
      filesystem: { read: undefined as any, write: undefined as any },
      network: { allowedHosts: undefined as any, allowedPorts: undefined as any }
    } as any);

    expect(merged.filesystem).toEqual({ read: [], write: [] });
    expect(merged.network).toEqual({ allowedHosts: [], allowedPorts: [] });
  });

  it('validateCapabilities() rejects control characters in whitelists', () => {
    const caps = {
      filesystem: { read: ['a\0b'], write: [] },
      network: { allowedHosts: [], allowedPorts: [] },
      env: [],
      subprocess: { allowed: false, allowedCommands: [] },
      resources: { maxMemoryMB: 64, maxCpuPercent: 50, timeoutMs: 1000 }
    };

    expect(() => validateCapabilities(caps)).toThrow('invalid characters');
  });
});

describe('SkillLoader capability validation', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'nexus-capabilities-'));
  });

  afterEach(async () => {
    if (tmpRoot) {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('fails to load a skill when capabilities are missing', async () => {
    const skillDir = path.join(tmpRoot, 'bad-skill');
    await mkdir(skillDir, { recursive: true });

    const warn = vi.fn();
    const loader = new SkillLoader({ logger: { warn } as any });

    const skillMdPath = path.join(skillDir, 'SKILL.md');
    await writeFile(
      skillMdPath,
      [
        '---',
        'name: bad-skill',
        'description: Missing capabilities',
        '---',
        '',
        'Body'
      ].join('\n'),
      'utf8'
    );

    const loaded = await loader.loadSkillFromSkillMd(skillMdPath);
    expect(loaded).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[1]?.error || '')).toContain('capabilities');
  });

  it('fails to load a skill when required capability fields are missing', async () => {
    const skillDir = path.join(tmpRoot, 'incomplete-skill');
    await mkdir(skillDir, { recursive: true });

    const loader = new SkillLoader();
    const skillMdPath = path.join(skillDir, 'SKILL.md');
    await writeFile(
      skillMdPath,
      [
        '---',
        'name: incomplete-skill',
        'description: Incomplete capabilities',
        'capabilities:',
        '  filesystem:',
        '    read: ["./"]',
        // missing filesystem.write
        '  network:',
        '    allowedHosts: []',
        '    allowedPorts: []',
        '  env: []',
        '  subprocess:',
        '    allowed: false',
        '    allowedCommands: []',
        '  resources:',
        '    maxMemoryMB: 64',
        '    maxCpuPercent: 50',
        '    timeoutMs: 1000',
        '---',
        '',
        'Body'
      ].join('\n'),
      'utf8'
    );

    const loaded = await loader.loadSkillFromSkillMd(skillMdPath);
    expect(loaded).toBeNull();
  });
});

import path from 'path';
import type { SkillCapabilities } from '../../security/CapabilityManifest.js';
import { DEFAULT_SKILL_CAPABILITIES } from '../../security/CapabilityManifest.js';
import { BehaviorValidator, type ExecutionTrace } from '../../security/BehaviorValidator.js';

function makeCaps(overrides: Partial<SkillCapabilities>): SkillCapabilities {
  return {
    ...DEFAULT_SKILL_CAPABILITIES,
    ...overrides,
    filesystem: { ...DEFAULT_SKILL_CAPABILITIES.filesystem, ...(overrides.filesystem || {}) },
    network: { ...DEFAULT_SKILL_CAPABILITIES.network, ...(overrides.network || {}) },
    subprocess: { ...DEFAULT_SKILL_CAPABILITIES.subprocess, ...(overrides.subprocess || {}) },
    resources: { ...DEFAULT_SKILL_CAPABILITIES.resources, ...(overrides.resources || {}) }
  };
}

function makeTrace(overrides: Partial<ExecutionTrace>): ExecutionTrace {
  return {
    fileAccesses: [],
    networkConnections: [],
    envAccessed: [],
    subprocesses: [],
    ...overrides
  };
}

describe('BehaviorValidator', () => {
  it('returns score=100 when behavior matches declarations', () => {
    const validator = new BehaviorValidator();
    const declared = makeCaps({
      filesystem: { read: ['./data'], write: ['./data'] },
      network: { allowedHosts: ['example.com'], allowedPorts: [443] },
      env: ['SAFE_ENV'],
      subprocess: { allowed: true, allowedCommands: ['node'] }
    });

    const trace = makeTrace({
      fileAccesses: [
        { path: path.resolve('data/input.txt'), operation: 'read' },
        { path: path.resolve('data/output.txt'), operation: 'write' }
      ],
      networkConnections: [{ host: 'api.example.com', port: 443 }],
      envAccessed: ['SAFE_ENV'],
      subprocesses: [{ command: '/usr/bin/node', argv: ['--version'] }]
    });

    const result = validator.validate(declared, trace);
    expect(result).toEqual({ violations: [], score: 100 });
  });

  it('flags undeclared filesystem accesses with graded severity', () => {
    const validator = new BehaviorValidator();
    const declared = makeCaps({
      filesystem: { read: ['/allowed'], write: ['/allowed'] }
    });

    const trace = makeTrace({
      fileAccesses: [
        { path: '/notallowed/one.txt', operation: 'read' },
        { path: '/notallowed/two.txt', operation: 'write' }
      ]
    });

    const result = validator.validate(declared, trace);
    expect(result.score).toBe(65);
    expect(result.violations).toHaveLength(2);
    expect(result.violations[0]).toMatchObject({ type: 'filesystem', operation: 'read', severity: 'medium' });
    expect(result.violations[1]).toMatchObject({ type: 'filesystem', operation: 'write', severity: 'high' });
  });

  it('treats filesystem prefixes as path-segment boundaries', () => {
    const validator = new BehaviorValidator();
    const declared = makeCaps({
      filesystem: { read: ['/tmp/data'], write: [] }
    });

    const trace = makeTrace({
      fileAccesses: [{ path: '/tmp/database/secret.txt', operation: 'read' }]
    });

    const result = validator.validate(declared, trace);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ type: 'filesystem', operation: 'read', severity: 'medium' });
  });

  it('flags undeclared network connections (host or port mismatch)', () => {
    const validator = new BehaviorValidator();
    const declared = makeCaps({
      network: { allowedHosts: ['example.com'], allowedPorts: [443] }
    });

    const trace = makeTrace({
      networkConnections: [
        { host: 'evil.com', port: 443 },
        { host: 'api.example.com', port: 80 }
      ]
    });

    const result = validator.validate(declared, trace);
    expect(result.score).toBe(50);
    expect(result.violations).toHaveLength(2);
    expect(result.violations[0]).toMatchObject({ type: 'network', severity: 'high' });
    expect(result.violations[1]).toMatchObject({ type: 'network', severity: 'high' });
  });

  it('flags undeclared environment variable reads with critical/high severity and dedupes repeats', () => {
    const validator = new BehaviorValidator();
    const declared = makeCaps({ env: ['SAFE_ENV'] });

    const trace = makeTrace({
      envAccessed: ['OPENAI_API_KEY', 'OPENAI_API_KEY', 'LANG']
    });

    const result = validator.validate(declared, trace);
    expect(result.score).toBe(35);
    expect(result.violations).toHaveLength(2);

    const keyViolation = result.violations.find((v) => v.type === 'env' && v.variable === 'OPENAI_API_KEY');
    expect(keyViolation).toMatchObject({ type: 'env', variable: 'OPENAI_API_KEY', severity: 'critical' });

    const langViolation = result.violations.find((v) => v.type === 'env' && v.variable === 'LANG');
    expect(langViolation).toMatchObject({ type: 'env', variable: 'LANG', severity: 'high' });
  });

  it('flags subprocess usage when subprocesses are disallowed', () => {
    const validator = new BehaviorValidator();
    const declared = makeCaps({ subprocess: { allowed: false, allowedCommands: [] } });

    const trace = makeTrace({
      subprocesses: [
        { command: '/usr/bin/node', argv: ['-v'] },
        { command: 'git', argv: ['status'] }
      ]
    });

    const result = validator.validate(declared, trace);
    expect(result.score).toBe(20);
    expect(result.violations).toHaveLength(2);
    expect(result.violations[0]).toMatchObject({ type: 'subprocess', severity: 'critical' });
    expect(result.violations[1]).toMatchObject({ type: 'subprocess', severity: 'critical' });
  });

  it('flags subprocess commands that are not in the allowlist', () => {
    const validator = new BehaviorValidator();
    const declared = makeCaps({ subprocess: { allowed: true, allowedCommands: ['node'] } });

    const trace = makeTrace({
      subprocesses: [
        { command: '/usr/bin/node', argv: ['-v'] },
        { command: '/usr/bin/curl', argv: ['https://example.com'] }
      ]
    });

    const result = validator.validate(declared, trace);
    expect(result.score).toBe(75);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ type: 'subprocess', severity: 'high' });
  });

  it('clamps score at 0 when penalties exceed 100', () => {
    const validator = new BehaviorValidator();
    const declared = makeCaps({
      env: [],
      subprocess: { allowed: false, allowedCommands: [] }
    });

    const trace = makeTrace({
      envAccessed: ['OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY'],
      subprocesses: [
        { command: 'node' },
        { command: 'git' }
      ]
    });

    const result = validator.validate(declared, trace);
    expect(result.score).toBe(0);
    expect(result.violations.length).toBeGreaterThanOrEqual(3);
  });

  it('supports exact filesystem matches and root-prefix permissions', () => {
    const validator = new BehaviorValidator();

    const exact = makeCaps({ filesystem: { read: ['/tmp/data'], write: [] } });
    const exactResult = validator.validate(
      exact,
      makeTrace({
        fileAccesses: [{ path: '/tmp/data', operation: 'read' }]
      })
    );
    expect(exactResult.violations).toEqual([]);

    const rootAllowed = makeCaps({ filesystem: { read: ['/'], write: [] } });
    const rootResult = validator.validate(
      rootAllowed,
      makeTrace({
        fileAccesses: [{ path: '/etc/passwd', operation: 'read' }]
      })
    );
    expect(rootResult.violations).toEqual([]);
  });

  it('normalizes hosts and supports wildcard, exact, and subdomain matching', () => {
    const validator = new BehaviorValidator();

    const wildcard = makeCaps({ network: { allowedHosts: ['*'], allowedPorts: [443] } });
    expect(
      validator.validate(wildcard, makeTrace({ networkConnections: [{ host: 'evil.com', port: 443 }] })).violations
    ).toEqual([]);

    const declared = makeCaps({ network: { allowedHosts: ['example.com', '::1'], allowedPorts: [443] } });
    (declared.network.allowedHosts as any).unshift(undefined, ''); // cover malformed allowlist entries

    const result = validator.validate(
      declared,
      makeTrace({
        networkConnections: [
          { host: 'EXAMPLE.COM.', port: 443 },
          { host: 'api.example.com', port: 443 },
          { host: '[::1]', port: 443 },
          { host: '   ', port: 443 }
        ]
      })
    );

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ type: 'network', host: '   ', severity: 'high' });
  });

  it('handles missing arrays and malformed trace entries without throwing', () => {
    const validator = new BehaviorValidator();

    const declared = makeCaps({ subprocess: { allowed: true, allowedCommands: ['node'] } });
    (declared as any).env = undefined;
    (declared as any).subprocess.allowedCommands = undefined;

    const emptyTrace = {
      fileAccesses: undefined,
      networkConnections: undefined,
      envAccessed: undefined,
      subprocesses: undefined
    } as any;

    expect(validator.validate(declared, emptyTrace)).toEqual({ violations: [], score: 100 });

    const malformed = validator.validate(
      makeCaps({
        filesystem: { read: ['/allowed'], write: ['/allowed'] },
        network: { allowedHosts: ['example.com'], allowedPorts: [443] },
        env: ['SAFE_ENV'],
        subprocess: { allowed: true, allowedCommands: ['node'] }
      }),
      {
        fileAccesses: [
          null,
          { path: 123, operation: 'read' },
          { path: '.', operation: 'read' },
          { path: '/allowed', operation: 'execute' }
        ] as any,
        networkConnections: [
          null,
          { host: 123, port: 443 },
          { host: 'example.com', port: Number.NaN },
          { host: '   ', port: 443 }
        ] as any,
        envAccessed: [undefined, ' ', 'SAFE_ENV'] as any,
        subprocesses: [
          null,
          { command: 123 },
          { command: '', argv: 'not-array' },
          { command: '/usr/bin/node.exe', argv: [] },
          { command: '/usr/bin/curl' }
        ] as any
      }
    );

    expect(malformed.violations.some((v) => v.type === 'filesystem')).toBe(true);
    expect(malformed.violations.some((v) => v.type === 'network')).toBe(true);
    expect(malformed.violations.some((v) => v.type === 'subprocess')).toBe(true);

    const emptyReadList = makeCaps({ filesystem: { read: [], write: [] } });
    expect(validator.validate(emptyReadList, makeTrace({ fileAccesses: [{ path: '/tmp/whatever', operation: 'read' }] })).violations).toHaveLength(1);

    const emptyNetworkHosts = makeCaps({ network: { allowedHosts: [], allowedPorts: [443] } });
    expect(
      validator.validate(emptyNetworkHosts, makeTrace({ networkConnections: [{ host: 'example.com', port: 443 }] })).violations
    ).toHaveLength(1);

    const badNetworkTypes = makeCaps({ network: { allowedHosts: ['example.com'], allowedPorts: [443] } });
    (badNetworkTypes as any).network.allowedHosts = 'example.com';
    expect(
      validator.validate(badNetworkTypes, makeTrace({ networkConnections: [{ host: 'example.com', port: 443 }] })).violations
    ).toHaveLength(1);
  });
});

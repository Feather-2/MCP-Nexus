import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { DependencyAuditor } from '../../../security/analyzers/DependencyAuditor.js';

class MockChildProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn();
}

function spawnWithBehavior(behavior: 'stdout' | 'stderr-only' | 'error' | 'timeout' | 'empty', data = ''): any {
  return vi.fn((_cmd: string, _args: string[], _opts: unknown) => {
    const proc = new MockChildProcess();
    queueMicrotask(() => {
      switch (behavior) {
        case 'stdout':
          proc.stdout.write(data);
          proc.stdout.end();
          proc.stderr.end();
          proc.emit('close', 0);
          break;
        case 'stderr-only':
          proc.stderr.write(data || 'npm ERR! something');
          proc.stdout.end();
          proc.stderr.end();
          proc.emit('close', 1);
          break;
        case 'error':
          proc.emit('error', new Error('spawn ENOENT'));
          break;
        case 'timeout':
          break;
        case 'empty':
          proc.stdout.end();
          proc.stderr.end();
          proc.emit('close', 0);
          break;
      }
    });
    return proc as any;
  });
}

async function makeTmpProject(files: Record<string, unknown>): Promise<{ root: string; packageJsonPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-depaudit-branch-'));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    await writeFile(full, text, 'utf8');
  }
  return { root, packageJsonPath: path.join(root, 'package.json') };
}

describe('DependencyAuditor \u2013 branch coverage', () => {
  describe('parseNpmAuditJson edge cases', () => {
    it('returns empty result when npm audit returns error object', async () => {
      const errorDoc = { error: { code: 'ENOLOCK', summary: 'no lock file' } };
      const { root, packageJsonPath } = await makeTmpProject({ 'package.json': { name: 'tmp', version: '1.0.0' } });
      try {
        const auditor = new DependencyAuditor({
          spawn: spawnWithBehavior('stdout', JSON.stringify(errorDoc)),
          fetch: vi.fn().mockRejectedValue(new Error('no fetch'))
        });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('handles npm v7 entry where via array has only string items (no record items)', async () => {
      const npmV7 = {
        vulnerabilities: {
          lodash: {
            severity: 'high',
            via: ['prototype-pollution-pkg']
          }
        },
        metadata: { vulnerabilities: { low: 0, moderate: 0, high: 1, critical: 0 } }
      };
      const { root, packageJsonPath } = await makeTmpProject({ 'package.json': { name: 'tmp', version: '1.0.0' } });
      try {
        const auditor = new DependencyAuditor({ spawn: spawnWithBehavior('stdout', JSON.stringify(npmV7)) });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.hasHigh).toBe(true);
        const lodash = result.vulnerabilities.find(v => v.packageName === 'lodash');
        expect(lodash).toBeDefined();
        expect(lodash?.severity).toBe('high');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('handles npm v7 entry where via item has no severity (uses topSeverity)', async () => {
      const npmV7 = {
        vulnerabilities: {
          foo: {
            severity: 'moderate',
            via: [{ name: 'foo', title: 'Issue', source: '999' }]
          }
        },
        metadata: { vulnerabilities: { low: 0, moderate: 1, high: 0, critical: 0 } }
      };
      const { root, packageJsonPath } = await makeTmpProject({ 'package.json': { name: 'tmp', version: '1.0.0' } });
      try {
        const auditor = new DependencyAuditor({ spawn: spawnWithBehavior('stdout', JSON.stringify(npmV7)) });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities[0]?.severity).toBe('moderate');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('handles npm v7 entry where entry itself is not a record', async () => {
      const npmV7 = {
        vulnerabilities: { broken: 'not-a-record' },
        metadata: { vulnerabilities: { low: 0, moderate: 0, high: 0, critical: 0 } }
      };
      const { root, packageJsonPath } = await makeTmpProject({ 'package.json': { name: 'tmp', version: '1.0.0' } });
      try {
        const auditor = new DependencyAuditor({ spawn: spawnWithBehavior('stdout', JSON.stringify(npmV7)) });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities).toHaveLength(0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('handles npm v6 advisory with missing module_name (uses name field)', async () => {
      const npmV6 = {
        advisories: {
          '200': { name: 'fallback-name', severity: 'low', title: 'Minor issue' }
        },
        metadata: { vulnerabilities: { low: 1, moderate: 0, high: 0, critical: 0 } }
      };
      const { root, packageJsonPath } = await makeTmpProject({ 'package.json': { name: 'tmp', version: '1.0.0' } });
      try {
        const auditor = new DependencyAuditor({ spawn: spawnWithBehavior('stdout', JSON.stringify(npmV6)) });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities[0]?.packageName).toBe('fallback-name');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('skips npm v6 advisory with no module_name or name', async () => {
      const npmV6 = {
        advisories: { '300': { severity: 'high', title: 'No name' } },
        metadata: { vulnerabilities: { low: 0, moderate: 0, high: 1, critical: 0 } }
      };
      const { root, packageJsonPath } = await makeTmpProject({ 'package.json': { name: 'tmp', version: '1.0.0' } });
      try {
        const auditor = new DependencyAuditor({ spawn: spawnWithBehavior('stdout', JSON.stringify(npmV6)) });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities).toHaveLength(0);
        expect(result.hasHigh).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('skips npm v6 advisory with invalid severity', async () => {
      const npmV6 = {
        advisories: { '400': { module_name: 'pkg', severity: 'unknown-sev' } },
        metadata: { vulnerabilities: { low: 0, moderate: 0, high: 0, critical: 0 } }
      };
      const { root, packageJsonPath } = await makeTmpProject({ 'package.json': { name: 'tmp', version: '1.0.0' } });
      try {
        const auditor = new DependencyAuditor({ spawn: spawnWithBehavior('stdout', JSON.stringify(npmV6)) });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities).toHaveLength(0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('handles npm v6 advisory that is not a record', async () => {
      const npmV6 = {
        advisories: { '500': 'not-a-record' },
        metadata: { vulnerabilities: { low: 0, moderate: 0, high: 0, critical: 0 } }
      };
      const { root, packageJsonPath } = await makeTmpProject({ 'package.json': { name: 'tmp', version: '1.0.0' } });
      try {
        const auditor = new DependencyAuditor({ spawn: spawnWithBehavior('stdout', JSON.stringify(npmV6)) });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities).toHaveLength(0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('returns null parse when doc has neither vulnerabilities nor advisories', async () => {
      const weirdDoc = { metadata: { vulnerabilities: {} } };
      const { root, packageJsonPath } = await makeTmpProject({
        'package.json': { name: 'tmp', version: '1.0.0' },
        'package-lock.json': { lockfileVersion: 2, packages: {} }
      });
      try {
        const auditor = new DependencyAuditor({
          spawn: spawnWithBehavior('stdout', JSON.stringify(weirdDoc)),
          fetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) })
        });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('extractNpmCounts edge cases', () => {
    it('handles non-number values in metadata.vulnerabilities', async () => {
      const doc = {
        vulnerabilities: {},
        metadata: { vulnerabilities: { low: 'not-a-number', moderate: null, high: Infinity, critical: NaN } }
      };
      const { root, packageJsonPath } = await makeTmpProject({ 'package.json': { name: 'tmp', version: '1.0.0' } });
      try {
        const auditor = new DependencyAuditor({ spawn: spawnWithBehavior('stdout', JSON.stringify(doc)) });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.hasCritical).toBe(false);
        expect(result.hasHigh).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('handles missing metadata entirely', async () => {
      const doc = { vulnerabilities: {} };
      const { root, packageJsonPath } = await makeTmpProject({ 'package.json': { name: 'tmp', version: '1.0.0' } });
      try {
        const auditor = new DependencyAuditor({ spawn: spawnWithBehavior('stdout', JSON.stringify(doc)) });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities).toHaveLength(0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('handles metadata.vulnerabilities that is not a record', async () => {
      const doc = { vulnerabilities: {}, metadata: { vulnerabilities: 'invalid' } };
      const { root, packageJsonPath } = await makeTmpProject({ 'package.json': { name: 'tmp', version: '1.0.0' } });
      try {
        const auditor = new DependencyAuditor({ spawn: spawnWithBehavior('stdout', JSON.stringify(doc)) });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities).toHaveLength(0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('extractCves edge cases', () => {
    it('handles CVE as single string (not array)', async () => {
      const npmV7 = {
        vulnerabilities: {
          pkg: {
            severity: 'high',
            via: [{ name: 'pkg', severity: 'high', cve: 'CVE-2023-9999' }]
          }
        },
        metadata: { vulnerabilities: { low: 0, moderate: 0, high: 1, critical: 0 } }
      };
      const { root, packageJsonPath } = await makeTmpProject({ 'package.json': { name: 'tmp', version: '1.0.0' } });
      try {
        const auditor = new DependencyAuditor({ spawn: spawnWithBehavior('stdout', JSON.stringify(npmV7)) });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities[0]?.cves).toEqual(['CVE-2023-9999']);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('filters out invalid CVE format strings', async () => {
      const npmV7 = {
        vulnerabilities: {
          pkg: {
            severity: 'low',
            via: [{ name: 'pkg', severity: 'low', cves: ['not-a-cve', 'CVE-2023-1234', '', 123] }]
          }
        },
        metadata: { vulnerabilities: { low: 1, moderate: 0, high: 0, critical: 0 } }
      };
      const { root, packageJsonPath } = await makeTmpProject({ 'package.json': { name: 'tmp', version: '1.0.0' } });
      try {
        const auditor = new DependencyAuditor({ spawn: spawnWithBehavior('stdout', JSON.stringify(npmV7)) });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities[0]?.cves).toEqual(['CVE-2023-1234']);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('deduplicates CVEs', async () => {
      const npmV7 = {
        vulnerabilities: {
          pkg: {
            severity: 'moderate',
            via: [{ name: 'pkg', severity: 'moderate', cves: ['CVE-2023-1111', 'cve-2023-1111'] }]
          }
        },
        metadata: { vulnerabilities: { low: 0, moderate: 1, high: 0, critical: 0 } }
      };
      const { root, packageJsonPath } = await makeTmpProject({ 'package.json': { name: 'tmp', version: '1.0.0' } });
      try {
        const auditor = new DependencyAuditor({ spawn: spawnWithBehavior('stdout', JSON.stringify(npmV7)) });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities[0]?.cves).toEqual(['CVE-2023-1111']);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('normalizeSeverity edge cases', () => {
    it('maps info to low', async () => {
      const npmV6 = {
        advisories: { '1': { module_name: 'pkg', severity: 'info', title: 'Informational' } },
        metadata: { vulnerabilities: { info: 1, low: 0, moderate: 0, high: 0, critical: 0 } }
      };
      const { root, packageJsonPath } = await makeTmpProject({ 'package.json': { name: 'tmp', version: '1.0.0' } });
      try {
        const auditor = new DependencyAuditor({ spawn: spawnWithBehavior('stdout', JSON.stringify(npmV6)) });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities[0]?.severity).toBe('low');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('npm audit process edge cases', () => {
    it('falls back to OSV when spawn emits error', async () => {
      const { root, packageJsonPath } = await makeTmpProject({
        'package.json': { name: 'tmp', version: '1.0.0' },
        'package-lock.json': { lockfileVersion: 2, packages: { '': { name: 'tmp', version: '1.0.0' } } }
      });
      try {
        const auditor = new DependencyAuditor({
          spawn: spawnWithBehavior('error'),
          fetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) })
        });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('falls back to OSV when npm audit returns empty stdout', async () => {
      const { root, packageJsonPath } = await makeTmpProject({
        'package.json': { name: 'tmp', version: '1.0.0' },
        'package-lock.json': { lockfileVersion: 2, packages: { '': { name: 'tmp', version: '1.0.0' } } }
      });
      try {
        const auditor = new DependencyAuditor({
          spawn: spawnWithBehavior('empty'),
          fetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) })
        });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('falls back to OSV when npm audit returns stderr only', async () => {
      const { root, packageJsonPath } = await makeTmpProject({
        'package.json': { name: 'tmp', version: '1.0.0' },
        'package-lock.json': { lockfileVersion: 2, packages: { '': { name: 'tmp', version: '1.0.0' } } }
      });
      try {
        const auditor = new DependencyAuditor({
          spawn: spawnWithBehavior('stderr-only', 'npm ERR! code ENOLOCK'),
          fetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) })
        });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('falls back to OSV when npm audit times out', async () => {
      const { root, packageJsonPath } = await makeTmpProject({
        'package.json': { name: 'tmp', version: '1.0.0' },
        'package-lock.json': { lockfileVersion: 2, packages: { '': { name: 'tmp', version: '1.0.0' } } }
      });
      try {
        const auditor = new DependencyAuditor({
          timeoutMs: 50,
          spawn: spawnWithBehavior('timeout'),
          fetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) })
        });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('OSV query edge cases', () => {
    it('returns empty when OSV returns non-ok status', async () => {
      const { root, packageJsonPath } = await makeTmpProject({
        'package.json': { name: 'tmp', version: '1.0.0' },
        'package-lock.json': { lockfileVersion: 2, packages: { 'node_modules/foo': { version: '1.0.0' } } }
      });
      try {
        const auditor = new DependencyAuditor({
          spawn: spawnWithBehavior('stdout', 'bad json'),
          fetch: vi.fn().mockResolvedValue({ ok: false, status: 500 })
        });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('handles OSV results with no vulns array', async () => {
      const { root, packageJsonPath } = await makeTmpProject({
        'package.json': { name: 'tmp', version: '1.0.0' },
        'package-lock.json': { lockfileVersion: 2, packages: { 'node_modules/foo': { version: '1.0.0' } } }
      });
      try {
        const auditor = new DependencyAuditor({
          spawn: spawnWithBehavior('stdout', 'bad'),
          fetch: vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ results: [{ vulns: null }, {}] })
          })
        });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('handles OSV vuln without database_specific - uses CVSS severity array', async () => {
      const { root, packageJsonPath } = await makeTmpProject({
        'package.json': { name: 'tmp', version: '1.0.0' },
        'package-lock.json': { lockfileVersion: 2, packages: { 'node_modules/bar': { version: '2.0.0' } } }
      });
      try {
        const auditor = new DependencyAuditor({
          spawn: spawnWithBehavior('stdout', 'bad'),
          fetch: vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
              results: [{
                vulns: [{
                  id: 'GHSA-1111',
                  summary: 'CVSS-based',
                  severity: [{ type: 'CVSS_V3', score: 9.5 }],
                  references: []
                }]
              }]
            })
          })
        });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities[0]?.severity).toBe('critical');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('maps CVSS score ranges correctly (moderate=4-6.9, low<4)', async () => {
      const { root, packageJsonPath } = await makeTmpProject({
        'package.json': { name: 'tmp', version: '1.0.0' },
        'package-lock.json': { lockfileVersion: 2, packages: { 'node_modules/baz': { version: '1.0.0' } } }
      });
      try {
        const auditor = new DependencyAuditor({
          spawn: spawnWithBehavior('stdout', 'bad'),
          fetch: vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
              results: [{
                vulns: [
                  { id: 'OSV-LOW', summary: 'Low', severity: [{ score: '2.5' }] },
                  { id: 'OSV-MOD', summary: 'Moderate', severity: [{ score: 5.0 }] }
                ]
              }]
            })
          })
        });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        const low = result.vulnerabilities.find(v => v.id === 'OSV-LOW');
        const mod = result.vulnerabilities.find(v => v.id === 'OSV-MOD');
        expect(low?.severity).toBe('low');
        expect(mod?.severity).toBe('moderate');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('handles OSV severity array with non-record entries', async () => {
      const { root, packageJsonPath } = await makeTmpProject({
        'package.json': { name: 'tmp', version: '1.0.0' },
        'package-lock.json': { lockfileVersion: 2, packages: { 'node_modules/qux': { version: '1.0.0' } } }
      });
      try {
        const auditor = new DependencyAuditor({
          spawn: spawnWithBehavior('stdout', 'bad'),
          fetch: vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
              results: [{
                vulns: [{
                  id: 'OSV-1',
                  summary: 'Test',
                  severity: ['not-a-record', null, { score: 7.5 }]
                }]
              }]
            })
          })
        });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities[0]?.severity).toBe('high');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('handles OSV vuln without severity info defaults to moderate', async () => {
      const { root, packageJsonPath } = await makeTmpProject({
        'package.json': { name: 'tmp', version: '1.0.0' },
        'package-lock.json': { lockfileVersion: 2, packages: { 'node_modules/noinfo': { version: '1.0.0' } } }
      });
      try {
        const auditor = new DependencyAuditor({
          spawn: spawnWithBehavior('stdout', 'bad'),
          fetch: vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
              results: [{
                vulns: [{ id: 'OSV-NOSEV', summary: 'No severity' }]
              }]
            })
          })
        });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities[0]?.severity).toBe('moderate');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('handles OSV vuln that is not a record', async () => {
      const { root, packageJsonPath } = await makeTmpProject({
        'package.json': { name: 'tmp', version: '1.0.0' },
        'package-lock.json': { lockfileVersion: 2, packages: { 'node_modules/x': { version: '1.0.0' } } }
      });
      try {
        const auditor = new DependencyAuditor({
          spawn: spawnWithBehavior('stdout', 'bad'),
          fetch: vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
              results: [{ vulns: ['not-record', null, 42] }]
            })
          })
        });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('extracts URL from references array', async () => {
      const { root, packageJsonPath } = await makeTmpProject({
        'package.json': { name: 'tmp', version: '1.0.0' },
        'package-lock.json': { lockfileVersion: 2, packages: { 'node_modules/refpkg': { version: '1.0.0' } } }
      });
      try {
        const auditor = new DependencyAuditor({
          spawn: spawnWithBehavior('stdout', 'bad'),
          fetch: vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
              results: [{
                vulns: [{
                  id: 'OSV-REF',
                  summary: 'With refs',
                  references: [
                    'not-a-record',
                    { url: '' },
                    { url: 'https://example.com/advisory' }
                  ]
                }]
              }]
            })
          })
        });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities[0]?.url).toBe('https://example.com/advisory');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('handles OSV response with non-record data', async () => {
      const { root, packageJsonPath } = await makeTmpProject({
        'package.json': { name: 'tmp', version: '1.0.0' },
        'package-lock.json': { lockfileVersion: 2, packages: { 'node_modules/a': { version: '1.0.0' } } }
      });
      try {
        const auditor = new DependencyAuditor({
          spawn: spawnWithBehavior('stdout', 'bad'),
          fetch: vi.fn().mockResolvedValue({
            ok: true,
            json: async () => 'not-an-object'
          })
        });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('handles OSV result entry that is not a record', async () => {
      const { root, packageJsonPath } = await makeTmpProject({
        'package.json': { name: 'tmp', version: '1.0.0' },
        'package-lock.json': { lockfileVersion: 2, packages: { 'node_modules/b': { version: '1.0.0' } } }
      });
      try {
        const auditor = new DependencyAuditor({
          spawn: spawnWithBehavior('stdout', 'bad'),
          fetch: vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ results: ['not-record'] })
          })
        });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('extractLockfilePackages edge cases', () => {
    it('handles scoped packages in lockfile v2', async () => {
      const lockfile = {
        lockfileVersion: 2,
        packages: {
          'node_modules/@scope/pkg': { version: '1.0.0' },
          'node_modules/@scope': {},
          'some-non-module-key': { version: '1.0.0' }
        }
      };
      const { root, packageJsonPath } = await makeTmpProject({
        'package.json': { name: 'tmp', version: '1.0.0' },
        'package-lock.json': lockfile
      });
      try {
        const auditor = new DependencyAuditor({
          spawn: spawnWithBehavior('stdout', 'bad'),
          fetch: vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ results: [{ vulns: [] }] })
          })
        });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('handles lockfile with no packages or dependencies', async () => {
      const lockfile = { lockfileVersion: 3 };
      const { root, packageJsonPath } = await makeTmpProject({
        'package.json': { name: 'tmp', version: '1.0.0' },
        'package-lock.json': lockfile
      });
      try {
        const auditor = new DependencyAuditor({
          spawn: spawnWithBehavior('stdout', 'bad'),
          fetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) })
        });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('handles lockfile v1 with nested dependencies', async () => {
      const lockfile = {
        lockfileVersion: 1,
        dependencies: {
          'parent': {
            version: '1.0.0',
            dependencies: {
              'child': { version: '0.5.0' },
              'broken': 'not-a-record'
            }
          },
          'no-version': {},
          'not-record': 'string-value'
        }
      };
      const { root, packageJsonPath } = await makeTmpProject({
        'package.json': { name: 'tmp', version: '1.0.0' },
        'package-lock.json': lockfile
      });
      try {
        const auditor = new DependencyAuditor({
          spawn: spawnWithBehavior('stdout', 'bad'),
          fetch: vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ results: [{ vulns: [] }, { vulns: [] }] })
          })
        });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('handles lockfile that is not a record', async () => {
      const { root, packageJsonPath } = await makeTmpProject({
        'package.json': { name: 'tmp', version: '1.0.0' },
        'package-lock.json': '"just a string"'
      });
      try {
        const auditor = new DependencyAuditor({
          spawn: spawnWithBehavior('stdout', 'bad'),
          fetch: vi.fn().mockRejectedValue(new Error('should not call'))
        });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('auditNpmDependencies fallback chain', () => {
    it('returns empty result when both npm audit and lockfile reading fail', async () => {
      const { root, packageJsonPath } = await makeTmpProject({
        'package.json': { name: 'tmp', version: '1.0.0' }
      });
      try {
        const auditor = new DependencyAuditor({
          spawn: spawnWithBehavior('error'),
          fetch: vi.fn().mockRejectedValue(new Error('no network'))
        });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result).toEqual({ vulnerabilities: [], hasCritical: false, hasHigh: false });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('uses npmCommand option', async () => {
      const { root, packageJsonPath } = await makeTmpProject({ 'package.json': { name: 'tmp', version: '1.0.0' } });
      try {
        const spawnMock = spawnWithBehavior('stdout', JSON.stringify({ vulnerabilities: {}, metadata: {} }));
        const auditor = new DependencyAuditor({ spawn: spawnMock, npmCommand: 'custom-npm' });
        await auditor.auditNpmDependencies(packageJsonPath);
        expect(spawnMock).toHaveBeenCalledWith('custom-npm', ['audit', '--json'], expect.any(Object));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('computeFlags edge cases', () => {
    it('detects hasCritical from counts even when no vulnerabilities in list', async () => {
      const doc = {
        vulnerabilities: {},
        metadata: { vulnerabilities: { low: 0, moderate: 0, high: 0, critical: 5 } }
      };
      const { root, packageJsonPath } = await makeTmpProject({ 'package.json': { name: 'tmp', version: '1.0.0' } });
      try {
        const auditor = new DependencyAuditor({ spawn: spawnWithBehavior('stdout', JSON.stringify(doc)) });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.hasCritical).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('detects hasHigh from counts even when no vulnerabilities in list', async () => {
      const doc = {
        vulnerabilities: {},
        metadata: { vulnerabilities: { low: 0, moderate: 0, high: 3, critical: 0 } }
      };
      const { root, packageJsonPath } = await makeTmpProject({ 'package.json': { name: 'tmp', version: '1.0.0' } });
      try {
        const auditor = new DependencyAuditor({ spawn: spawnWithBehavior('stdout', JSON.stringify(doc)) });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.hasHigh).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('npm v7 via item edge cases', () => {
    it('uses dependency field when name is missing', async () => {
      const npmV7 = {
        vulnerabilities: {
          pkg: {
            severity: 'moderate',
            via: [{ dependency: 'dep-name', severity: 'moderate', source: '42' }]
          }
        },
        metadata: { vulnerabilities: { low: 0, moderate: 1, high: 0, critical: 0 } }
      };
      const { root, packageJsonPath } = await makeTmpProject({ 'package.json': { name: 'tmp', version: '1.0.0' } });
      try {
        const auditor = new DependencyAuditor({ spawn: spawnWithBehavior('stdout', JSON.stringify(npmV7)) });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities[0]?.packageName).toBe('dep-name');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('uses pkgName when both name and dependency are missing from via item', async () => {
      const npmV7 = {
        vulnerabilities: {
          'my-pkg': {
            severity: 'low',
            via: [{ severity: 'low', source: '7' }]
          }
        },
        metadata: { vulnerabilities: { low: 1, moderate: 0, high: 0, critical: 0 } }
      };
      const { root, packageJsonPath } = await makeTmpProject({ 'package.json': { name: 'tmp', version: '1.0.0' } });
      try {
        const auditor = new DependencyAuditor({ spawn: spawnWithBehavior('stdout', JSON.stringify(npmV7)) });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities[0]?.packageName).toBe('my-pkg');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('isRecord edge cases', () => {
    it('handles non-record npm audit output (array)', async () => {
      const { root, packageJsonPath } = await makeTmpProject({
        'package.json': { name: 'tmp', version: '1.0.0' },
        'package-lock.json': { lockfileVersion: 2, packages: {} }
      });
      try {
        const auditor = new DependencyAuditor({
          spawn: spawnWithBehavior('stdout', '[]'),
          fetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) })
        });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('handles null npm audit output', async () => {
      const { root, packageJsonPath } = await makeTmpProject({
        'package.json': { name: 'tmp', version: '1.0.0' },
        'package-lock.json': { lockfileVersion: 2, packages: {} }
      });
      try {
        const auditor = new DependencyAuditor({
          spawn: spawnWithBehavior('stdout', 'null'),
          fetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) })
        });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('extractOsvUrl edge cases', () => {
    it('returns undefined when references is not an array', async () => {
      const { root, packageJsonPath } = await makeTmpProject({
        'package.json': { name: 'tmp', version: '1.0.0' },
        'package-lock.json': { lockfileVersion: 2, packages: { 'node_modules/z': { version: '1.0.0' } } }
      });
      try {
        const auditor = new DependencyAuditor({
          spawn: spawnWithBehavior('stdout', 'bad'),
          fetch: vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
              results: [{
                vulns: [{ id: 'NO-REFS', summary: 'No refs', references: 'not-array' }]
              }]
            })
          })
        });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities[0]?.url).toBeUndefined();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('cvssScoreToSeverity string parsing', () => {
    it('parses string CVSS scores', async () => {
      const { root, packageJsonPath } = await makeTmpProject({
        'package.json': { name: 'tmp', version: '1.0.0' },
        'package-lock.json': { lockfileVersion: 2, packages: { 'node_modules/strsc': { version: '1.0.0' } } }
      });
      try {
        const auditor = new DependencyAuditor({
          spawn: spawnWithBehavior('stdout', 'bad'),
          fetch: vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
              results: [{
                vulns: [{ id: 'STR-SCORE', summary: 'String score', severity: [{ score: '9.8' }] }]
              }]
            })
          })
        });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities[0]?.severity).toBe('critical');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('handles non-finite CVSS score', async () => {
      const { root, packageJsonPath } = await makeTmpProject({
        'package.json': { name: 'tmp', version: '1.0.0' },
        'package-lock.json': { lockfileVersion: 2, packages: { 'node_modules/nf': { version: '1.0.0' } } }
      });
      try {
        const auditor = new DependencyAuditor({
          spawn: spawnWithBehavior('stdout', 'bad'),
          fetch: vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
              results: [{
                vulns: [{ id: 'NAN-SCORE', summary: 'Bad score', severity: [{ score: 'not-a-number' }] }]
              }]
            })
          })
        });
        const result = await auditor.auditNpmDependencies(packageJsonPath);
        expect(result.vulnerabilities[0]?.severity).toBe('moderate');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});

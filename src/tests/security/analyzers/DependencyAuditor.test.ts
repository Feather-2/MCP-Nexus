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

function spawnWithStdout(stdout: string, stderr = ''): any {
  return vi.fn((_cmd: string, _args: string[], _opts: unknown) => {
    const proc = new MockChildProcess();
    queueMicrotask(() => {
      if (stderr) proc.stderr.write(stderr);
      proc.stdout.write(stdout);
      proc.stdout.end();
      proc.stderr.end();
      proc.emit('close', 1);
    });
    return proc as any;
  });
}

async function makeTmpProject(files: Record<string, unknown>): Promise<{ root: string; packageJsonPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-depaudit-'));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    await writeFile(full, text, 'utf8');
  }
  return { root, packageJsonPath: path.join(root, 'package.json') };
}

describe('DependencyAuditor', () => {
  it('sets hasCritical=true for critical CVE from npm audit (v6 advisories)', async () => {
    const npmV6 = {
      advisories: {
        '100': {
          module_name: 'lodash',
          severity: 'critical',
          title: 'Prototype Pollution',
          url: 'https://example.com/advisory',
          cves: ['CVE-2021-23337']
        }
      },
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 1 } }
    };

    const { root, packageJsonPath } = await makeTmpProject({ 'package.json': { name: 'tmp', version: '1.0.0' } });
    try {
      const auditor = new DependencyAuditor({ spawn: spawnWithStdout(JSON.stringify(npmV6)) });
      const result = await auditor.auditNpmDependencies(packageJsonPath);

      expect(result.hasCritical).toBe(true);
      expect(result.hasHigh).toBe(false);
      expect(result.vulnerabilities).toHaveLength(1);
      expect(result.vulnerabilities[0]).toMatchObject({
        source: 'npm-audit',
        packageName: 'lodash',
        severity: 'critical',
        title: 'Prototype Pollution',
        url: 'https://example.com/advisory'
      });
      expect(result.vulnerabilities[0].cves).toEqual(['CVE-2021-23337']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('parses npm audit v7+ vulnerabilities (via objects + fallback entries)', async () => {
    const npmV7 = {
      vulnerabilities: {
        minimatch: {
          name: 'minimatch',
          severity: 'high',
          via: [
            'brace-expansion',
            {
              source: '123',
              name: 'minimatch',
              severity: 'high',
              title: 'Regular Expression Denial of Service',
              url: 'https://github.com/advisories/GHSA-xxxxx',
              cve: 'CVE-2020-1234'
            }
          ]
        },
        leftpad: { name: 'leftpad', severity: 'info', via: [] }
      },
      metadata: { vulnerabilities: { info: 0, low: 1, moderate: 0, high: 1, critical: 0 } }
    };

    const { root, packageJsonPath } = await makeTmpProject({ 'package.json': { name: 'tmp', version: '1.0.0' } });
    try {
      const auditor = new DependencyAuditor({ spawn: spawnWithStdout(JSON.stringify(npmV7)) });
      const result = await auditor.auditNpmDependencies(packageJsonPath);

      expect(result.hasCritical).toBe(false);
      expect(result.hasHigh).toBe(true);
      expect(result.vulnerabilities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ packageName: 'minimatch', severity: 'high', id: '123' }),
          expect.objectContaining({ packageName: 'leftpad', severity: 'low' })
        ])
      );

      const minimatch = result.vulnerabilities.find((v) => v.packageName === 'minimatch');
      expect(minimatch?.cves).toEqual(['CVE-2020-1234']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('falls back to OSV when npm audit output is not JSON (lockfile v2 packages)', async () => {
    const lockfileV2 = {
      name: 'tmp',
      lockfileVersion: 2,
      packages: {
        '': { name: 'tmp', version: '1.0.0' },
        'node_modules/lodash': { version: '4.17.20' },
        'node_modules/@scope/pkg': { version: '1.2.3' },
        'node_modules/foo/node_modules/bar': { version: '0.1.0' }
      }
    };

    const { root, packageJsonPath } = await makeTmpProject({
      'package.json': { name: 'tmp', version: '1.0.0' },
      'package-lock.json': lockfileV2
    });

    const fetchMock = vi.fn(async (_url: string, init?: any) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const queries: any[] = Array.isArray(body.queries) ? body.queries : [];
      const results = queries.map(() => ({ vulns: [] as any[] }));

      const lodashIdx = queries.findIndex((q) => q?.package?.name === 'lodash');
      if (lodashIdx >= 0) {
        results[lodashIdx] = {
          vulns: [
            {
              id: 'GHSA-xxxx',
              summary: 'Critical issue',
              aliases: ['CVE-2021-23337', 'GHSA-xxxx'],
              database_specific: { severity: 'CRITICAL' },
              references: [{ type: 'ADVISORY', url: 'https://osv.dev/vulnerability/GHSA-xxxx' }]
            }
          ]
        };
      }

      return { ok: true, status: 200, json: async () => ({ results }) } as any;
    });

    try {
      const auditor = new DependencyAuditor({
        spawn: spawnWithStdout('this is not json'),
        fetch: fetchMock as typeof fetch
      });

      const result = await auditor.auditNpmDependencies(packageJsonPath);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.hasCritical).toBe(true);
      expect(result.vulnerabilities).toEqual(
        expect.arrayContaining([expect.objectContaining({ source: 'osv', packageName: 'lodash', severity: 'critical' })])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('supports lockfile v1 dependency trees and CVSS severity mapping', async () => {
    const lockfileV1 = {
      lockfileVersion: 1,
      dependencies: {
        minimist: {
          version: '1.2.5',
          dependencies: {
            subdep: { version: '0.0.1' }
          }
        }
      }
    };

    const { root, packageJsonPath } = await makeTmpProject({
      'package.json': { name: 'tmp', version: '1.0.0' },
      'package-lock.json': lockfileV1
    });

    const fetchMock = vi.fn(async (_url: string, init?: any) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const queries: any[] = Array.isArray(body.queries) ? body.queries : [];
      const results = queries.map(() => ({ vulns: [] as any[] }));

      const minimistIdx = queries.findIndex((q) => q?.package?.name === 'minimist');
      if (minimistIdx >= 0) {
        results[minimistIdx] = {
          vulns: [
            {
              id: 'OSV-2020-XYZ',
              summary: 'High severity issue',
              aliases: ['CVE-2020-1234'],
              severity: [{ type: 'CVSS_V3', score: '7.5' }],
              references: [{ type: 'ADVISORY', url: 'https://osv.dev/vulnerability/OSV-2020-XYZ' }]
            }
          ]
        };
      }

      return { ok: true, status: 200, json: async () => ({ results }) } as any;
    });

    try {
      const auditor = new DependencyAuditor({
        spawn: spawnWithStdout('not json'),
        fetch: fetchMock as typeof fetch
      });

      const result = await auditor.auditNpmDependencies(packageJsonPath);

      expect(result.hasCritical).toBe(false);
      expect(result.hasHigh).toBe(true);
      expect(result.vulnerabilities).toEqual(
        expect.arrayContaining([expect.objectContaining({ source: 'osv', packageName: 'minimist', severity: 'high' })])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});


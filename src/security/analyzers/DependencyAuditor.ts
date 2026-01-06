import path from 'path';
import { readFile } from 'fs/promises';
import { spawn } from 'child_process';

export type DependencySeverity = 'low' | 'moderate' | 'high' | 'critical';

export interface DependencyVulnerability {
  source: 'npm-audit' | 'osv';
  packageName: string;
  severity: DependencySeverity;
  title?: string;
  url?: string;
  cves?: string[];
  id?: string;
}

export interface DependencyAuditResult {
  vulnerabilities: DependencyVulnerability[];
  hasCritical: boolean;
  hasHigh: boolean;
}

export interface DependencyAuditorOptions {
  timeoutMs?: number;
  fetch?: typeof fetch;
  spawn?: typeof spawn;
  osvEndpoint?: string;
  npmCommand?: string;
}

type SeverityCounts = Record<DependencySeverity, number>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeSeverity(value: unknown): DependencySeverity | undefined {
  const v = typeof value === 'string' ? value.toLowerCase().trim() : '';
  if (v === 'critical') return 'critical';
  if (v === 'high') return 'high';
  if (v === 'moderate') return 'moderate';
  if (v === 'low') return 'low';
  if (v === 'info') return 'low';
  return undefined;
}

function defaultSeverityCounts(): SeverityCounts {
  return { low: 0, moderate: 0, high: 0, critical: 0 };
}

function extractNpmCounts(doc: unknown): SeverityCounts {
  if (!isRecord(doc)) return defaultSeverityCounts();
  const meta = doc.metadata;
  if (!isRecord(meta)) return defaultSeverityCounts();
  const vulns = meta.vulnerabilities;
  if (!isRecord(vulns)) return defaultSeverityCounts();

  const out = defaultSeverityCounts();
  for (const sev of ['low', 'moderate', 'high', 'critical'] as const) {
    const value = vulns[sev];
    out[sev] = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }
  return out;
}

function extractCves(value: unknown): string[] | undefined {
  const out: string[] = [];

  const push = (entry: unknown) => {
    if (typeof entry !== 'string') return;
    const trimmed = entry.trim();
    if (!trimmed) return;
    if (!/^CVE-\d{4}-\d{4,}$/i.test(trimmed)) return;
    out.push(trimmed.toUpperCase());
  };

  if (Array.isArray(value)) {
    for (const v of value) push(v);
  } else if (typeof value === 'string') {
    push(value);
  }

  return out.length ? Array.from(new Set(out)) : undefined;
}

function computeFlags(vulnerabilities: DependencyVulnerability[], counts?: SeverityCounts): Pick<DependencyAuditResult, 'hasCritical' | 'hasHigh'> {
  const hasCriticalFromList = vulnerabilities.some((v) => v.severity === 'critical');
  const hasHighFromList = vulnerabilities.some((v) => v.severity === 'high');

  const hasCriticalFromCounts = Boolean(counts && counts.critical > 0);
  const hasHighFromCounts = Boolean(counts && counts.high > 0);

  return {
    hasCritical: hasCriticalFromList || hasCriticalFromCounts,
    hasHigh: hasHighFromList || hasHighFromCounts
  };
}

function parseNpmAuditJson(doc: unknown): DependencyAuditResult | null {
  if (!isRecord(doc)) return null;
  if (isRecord(doc.error)) return null;

  const vulnerabilities: DependencyVulnerability[] = [];
  const counts = extractNpmCounts(doc);

  // npm v7+ output
  if (isRecord(doc.vulnerabilities)) {
    for (const [pkgName, entry] of Object.entries(doc.vulnerabilities)) {
      if (!isRecord(entry)) continue;
      const topSeverity = normalizeSeverity(entry.severity);
      const via = entry.via;
      let added = false;

      if (Array.isArray(via)) {
        for (const item of via) {
          if (!isRecord(item)) continue;
          const severity = normalizeSeverity(item.severity) ?? topSeverity;
          if (!severity) continue;

          vulnerabilities.push({
            source: 'npm-audit',
            packageName: asNonEmptyString(item.name) ?? asNonEmptyString(item.dependency) ?? pkgName,
            severity,
            title: asNonEmptyString(item.title),
            url: asNonEmptyString(item.url),
            cves: extractCves(item.cves ?? item.cve),
            id: asNonEmptyString(item.source)
          });
          added = true;
        }
      }

      if (!added && topSeverity) {
        vulnerabilities.push({
          source: 'npm-audit',
          packageName: pkgName,
          severity: topSeverity
        });
      }
    }

    return { vulnerabilities, ...computeFlags(vulnerabilities, counts) };
  }

  // npm v6 output
  if (isRecord(doc.advisories)) {
    for (const [advisoryId, advisory] of Object.entries(doc.advisories)) {
      if (!isRecord(advisory)) continue;
      const moduleName = asNonEmptyString(advisory.module_name) ?? asNonEmptyString(advisory.name);
      if (!moduleName) continue;
      const severity = normalizeSeverity(advisory.severity);
      if (!severity) continue;

      vulnerabilities.push({
        source: 'npm-audit',
        packageName: moduleName,
        severity,
        title: asNonEmptyString(advisory.title),
        url: asNonEmptyString(advisory.url),
        cves: extractCves(advisory.cves ?? advisory.cve),
        id: advisoryId
      });
    }

    return { vulnerabilities, ...computeFlags(vulnerabilities, counts) };
  }

  return null;
}

function cvssScoreToSeverity(scoreValue: unknown): DependencySeverity | undefined {
  const score = typeof scoreValue === 'number' ? scoreValue : typeof scoreValue === 'string' ? Number.parseFloat(scoreValue) : NaN;
  if (!Number.isFinite(score)) return undefined;
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'moderate';
  return 'low';
}

function extractOsvSeverity(vuln: Record<string, unknown>): DependencySeverity | undefined {
  const dbSpecific = vuln.database_specific;
  if (isRecord(dbSpecific)) {
    const sev = normalizeSeverity(dbSpecific.severity);
    if (sev) return sev;
  }

  const sev = vuln.severity;
  if (Array.isArray(sev) && sev.length > 0) {
    for (const entry of sev) {
      if (!isRecord(entry)) continue;
      const score = entry.score;
      const mapped = cvssScoreToSeverity(score);
      if (mapped) return mapped;
    }
  }

  return undefined;
}

function extractOsvUrl(vuln: Record<string, unknown>): string | undefined {
  const refs = vuln.references;
  if (!Array.isArray(refs)) return undefined;
  for (const ref of refs) {
    if (!isRecord(ref)) continue;
    const url = asNonEmptyString(ref.url);
    if (url) return url;
  }
  return undefined;
}

function extractLockfilePackages(lockfile: unknown): Array<{ name: string; version: string }> {
  if (!isRecord(lockfile)) return [];

  // lockfileVersion >= 2
  if (isRecord(lockfile.packages)) {
    const out = new Map<string, string>();
    for (const [key, entry] of Object.entries(lockfile.packages)) {
      if (!key || key === '') continue;
      if (!key.includes('node_modules/')) continue;
      if (!isRecord(entry)) continue;

      const version = asNonEmptyString(entry.version);
      if (!version) continue;

      const idx = key.lastIndexOf('node_modules/');
      const tail = key.slice(idx + 'node_modules/'.length);
      const parts = tail.split('/').filter(Boolean);
      if (!parts.length) continue;

      const name = parts[0].startsWith('@') ? (parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined) : parts[0];
      if (!name) continue;
      if (!out.has(name)) out.set(name, version);
    }
    return Array.from(out, ([name, version]) => ({ name, version }));
  }

  // lockfileVersion 1
  const deps = lockfile.dependencies;
  if (!isRecord(deps)) return [];

  const out = new Map<string, string>();
  const stack: Array<{ name: string; node: unknown }> = Object.entries(deps).map(([name, node]) => ({ name, node }));
  while (stack.length) {
    const current = stack.pop()!;
    if (!isRecord(current.node)) continue;
    const version = asNonEmptyString(current.node.version);
    if (version && !out.has(current.name)) out.set(current.name, version);
    const childDeps = current.node.dependencies;
    if (isRecord(childDeps)) {
      for (const [childName, childNode] of Object.entries(childDeps)) {
        stack.push({ name: childName, node: childNode });
      }
    }
  }

  return Array.from(out, ([name, version]) => ({ name, version }));
}

async function runNpmAuditJson(
  spawnImpl: typeof spawn,
  opts: { cwd: string; timeoutMs: number; npmCommand?: string }
): Promise<unknown> {
  const npmCmd = opts.npmCommand ?? (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const args = ['audit', '--json'];

  return await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawnImpl(npmCmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      reject(new Error('npm audit timed out'));
    }, opts.timeoutMs);

    const finalize = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.on('error', (err) => finalize(() => reject(err)));
    child.stdout?.on('data', (d) => {
      stdout += Buffer.isBuffer(d) ? d.toString('utf8') : String(d);
    });
    child.stderr?.on('data', (d) => {
      stderr += Buffer.isBuffer(d) ? d.toString('utf8') : String(d);
    });
    child.on('close', () =>
      finalize(() => {
        const text = stdout.trim();
        if (!text) {
          reject(new Error(stderr.trim() || 'npm audit returned empty output'));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (e) {
          reject(new Error(`npm audit returned invalid JSON: ${e instanceof Error ? e.message : String(e)}`));
        }
      })
    );
  });
}

async function queryOsv(
  fetchImpl: typeof fetch,
  endpoint: string,
  packages: Array<{ name: string; version: string }>
): Promise<DependencyVulnerability[]> {
  if (!packages.length) return [];

  const resp = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      queries: packages.map((p) => ({
        package: { ecosystem: 'npm', name: p.name },
        version: p.version
      }))
    })
  });

  if (!resp.ok) {
    throw new Error(`OSV query failed: HTTP ${resp.status}`);
  }

  const data: unknown = await resp.json();
  if (!isRecord(data) || !Array.isArray(data.results)) return [];

  const vulnerabilities: DependencyVulnerability[] = [];
  for (let i = 0; i < data.results.length; i++) {
    const result = data.results[i];
    const pkg = packages[i];
    if (!pkg || !isRecord(result)) continue;
    const vulns = (result as any).vulns;
    if (!Array.isArray(vulns)) continue;

    for (const v of vulns) {
      if (!isRecord(v)) continue;
      const severity = extractOsvSeverity(v) ?? 'moderate';
      vulnerabilities.push({
        source: 'osv',
        packageName: pkg.name,
        severity,
        id: asNonEmptyString(v.id),
        title: asNonEmptyString(v.summary) ?? asNonEmptyString(v.details),
        url: extractOsvUrl(v),
        cves: extractCves(v.aliases)
      });
    }
  }

  return vulnerabilities;
}

export class DependencyAuditor {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: typeof spawn;
  private readonly osvEndpoint: string;
  private readonly npmCommand?: string;

  constructor(options: DependencyAuditorOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetch ?? fetch;
    this.spawnImpl = options.spawn ?? spawn;
    this.osvEndpoint = options.osvEndpoint ?? 'https://api.osv.dev/v1/querybatch';
    this.npmCommand = options.npmCommand;
  }

  async auditNpmDependencies(packageJsonPath: string): Promise<DependencyAuditResult> {
    const resolvedPath = path.resolve(packageJsonPath);
    const cwd = path.dirname(resolvedPath);

    try {
      const doc = await runNpmAuditJson(this.spawnImpl, { cwd, timeoutMs: this.timeoutMs, npmCommand: this.npmCommand });
      const parsed = parseNpmAuditJson(doc);
      if (parsed) return parsed;
    } catch {
      // Fall through to OSV.
    }

    try {
      const lockfilePath = path.join(cwd, 'package-lock.json');
      const lockfileRaw = await readFile(lockfilePath, 'utf8');
      const lockfile = JSON.parse(lockfileRaw) as unknown;

      const packages = extractLockfilePackages(lockfile).slice(0, 2000);
      const vulnerabilities = await queryOsv(this.fetchImpl, this.osvEndpoint, packages);
      return { vulnerabilities, ...computeFlags(vulnerabilities) };
    } catch {
      return { vulnerabilities: [], hasCritical: false, hasHigh: false };
    }
  }
}


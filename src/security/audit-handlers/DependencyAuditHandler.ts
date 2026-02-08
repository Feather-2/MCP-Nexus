import type { SemanticUnit } from '../AuditDecomposer.js';
import type { AuditSkillFinding, AuditSkillHandler, AuditSkillResult } from '../AuditSkillRouter.js';

const DEFAULT_RISKY_PACKAGE_PATTERN = /(^@?(evil|malicious|backdoor|hack|exploit))|(-stealer|-keylogger|-miner|-malware)$/i;
const DEFAULT_VERSION_PIN_PATTERN = /@\d+\.\d+\.\d+/;
const DEFAULT_MAX_IMPORT_COUNT = 20;
const PENALTY: Record<AuditSkillFinding['severity'], number> = { info: 0, low: 8, medium: 16, high: 28, critical: 40 };

function scoreFromFindings(findings: AuditSkillFinding[]): number {
  return Math.max(0, 100 - findings.reduce((total, item) => total + PENALTY[item.severity], 0));
}

function extractImportTarget(content: string): string | undefined {
  const match = content.match(/['"]([^'"]+)['"]/);
  return match?.[1];
}

function isPackageImport(target: string): boolean {
  return !target.startsWith('.') && !target.startsWith('/') && !target.startsWith('node:') && !/^https?:\/\//i.test(target);
}

export interface DependencyAuditHandlerOptions {
  riskyPackagePattern?: RegExp;
  versionPinPattern?: RegExp;
  maxImportCount?: number;
}

export class DependencyAuditHandler implements AuditSkillHandler {
  name = 'audit-dependency';
  targetUnits: Array<'imports'> = ['imports'];
  private readonly riskyPackagePattern: RegExp;
  private readonly versionPinPattern: RegExp;
  private readonly maxImportCount: number;

  constructor(options: DependencyAuditHandlerOptions = {}) {
    this.riskyPackagePattern = options.riskyPackagePattern ?? DEFAULT_RISKY_PACKAGE_PATTERN;
    this.versionPinPattern = options.versionPinPattern ?? DEFAULT_VERSION_PIN_PATTERN;
    this.maxImportCount = options.maxImportCount ?? DEFAULT_MAX_IMPORT_COUNT;
  }

  analyze(units: SemanticUnit[]): AuditSkillResult {
    const findings: AuditSkillFinding[] = [];
    const imports = units.map((unit) => extractImportTarget(unit.content)).filter((target): target is string => Boolean(target));

    const risky = imports.filter((target) => this.riskyPackagePattern.test(target));
    if (risky.length) findings.push({ auditSkill: this.name, severity: 'high', message: 'High-risk package naming pattern detected', evidence: risky.slice(0, 5).join(', '), unit: 'imports' });

    const unpinned = imports.filter((target) => isPackageImport(target) && !this.versionPinPattern.test(target));
    if (unpinned.length) findings.push({ auditSkill: this.name, severity: 'low', message: 'Dependency imports appear unpinned', evidence: `count=${unpinned.length}`, unit: 'imports' });

    if (imports.length > this.maxImportCount) findings.push({ auditSkill: this.name, severity: 'medium', message: 'Dependency import count is unusually high', evidence: `imports=${imports.length}`, unit: 'imports' });

    return { findings, score: scoreFromFindings(findings) };
  }
}

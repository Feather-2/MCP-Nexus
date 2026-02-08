import type { SemanticUnit } from '../AuditDecomposer.js';
import type { AuditSkillFinding, AuditSkillHandler, AuditSkillResult } from '../AuditSkillRouter.js';

const DEFAULT_TEMPLATE_INJECTION_PATTERN = /\$\{|\{\{|\beval\s*\(|new\s+Function\s*\(/i;
const DEFAULT_EXECUTION_PATTERN = /\b(exec|execSync|spawn|spawnSync|eval|shelljs)\b/i;
const DEFAULT_SQL_CONCAT_PATTERN = /(?:\b(query|sql)\b[\s\S]{0,80}\+)|(?:\+\s*['"`]\s*(select|insert|update|delete)\b)/i;
const PENALTY: Record<AuditSkillFinding['severity'], number> = { info: 0, low: 8, medium: 16, high: 28, critical: 40 };

function scoreFromFindings(findings: AuditSkillFinding[]): number {
  return Math.max(0, 100 - findings.reduce((total, item) => total + PENALTY[item.severity], 0));
}

export interface InjectionAuditHandlerOptions {
  templateInjectionPattern?: RegExp;
  executionPattern?: RegExp;
  sqlConcatPattern?: RegExp;
}

export class InjectionAuditHandler implements AuditSkillHandler {
  name = 'audit-injection';
  targetUnits: Array<'parameter_schemas' | 'code_blocks'> = ['parameter_schemas', 'code_blocks'];
  private readonly templateInjectionPattern: RegExp;
  private readonly executionPattern: RegExp;
  private readonly sqlConcatPattern: RegExp;

  constructor(options: InjectionAuditHandlerOptions = {}) {
    this.templateInjectionPattern = options.templateInjectionPattern ?? DEFAULT_TEMPLATE_INJECTION_PATTERN;
    this.executionPattern = options.executionPattern ?? DEFAULT_EXECUTION_PATTERN;
    this.sqlConcatPattern = options.sqlConcatPattern ?? DEFAULT_SQL_CONCAT_PATTERN;
  }

  analyze(units: SemanticUnit[]): AuditSkillResult {
    const findings: AuditSkillFinding[] = [];

    for (const unit of units) {
      if (unit.type === 'parameter_schemas' && this.templateInjectionPattern.test(unit.content)) {
        findings.push({ auditSkill: this.name, severity: 'high', message: 'Template injection marker detected in schema', evidence: unit.content, unit: 'parameter_schemas' });
      }

      if (unit.type === 'code_blocks' && this.executionPattern.test(unit.content)) {
        findings.push({ auditSkill: this.name, severity: 'high', message: 'Dangerous runtime execution API detected', evidence: unit.content, unit: 'code_blocks' });
      }

      if (unit.type === 'code_blocks' && this.sqlConcatPattern.test(unit.content)) {
        findings.push({ auditSkill: this.name, severity: 'medium', message: 'Possible SQL string concatenation detected', evidence: unit.content, unit: 'code_blocks' });
      }
    }

    return { findings, score: scoreFromFindings(findings) };
  }
}

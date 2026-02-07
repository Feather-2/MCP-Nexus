import type { SemanticUnit } from '../AuditDecomposer.js';
import type { AuditSkillFinding, AuditSkillHandler, AuditSkillResult } from '../AuditSkillRouter.js';

const TEMPLATE_INJECTION = /\$\{|\{\{|\beval\s*\(|new\s+Function\s*\(/i;
const EXECUTION_PATTERNS = /\b(exec|execSync|spawn|spawnSync|eval|shelljs)\b/i;
const SQL_CONCAT = /(?:\b(query|sql)\b[\s\S]{0,80}\+)|(?:\+\s*['"`]\s*(select|insert|update|delete)\b)/i;
const PENALTY: Record<AuditSkillFinding['severity'], number> = { info: 0, low: 8, medium: 16, high: 28, critical: 40 };

function scoreFromFindings(findings: AuditSkillFinding[]): number {
  return Math.max(0, 100 - findings.reduce((total, item) => total + PENALTY[item.severity], 0));
}

export class InjectionAuditHandler implements AuditSkillHandler {
  name = 'audit-injection';
  targetUnits: Array<'parameter_schemas' | 'code_blocks'> = ['parameter_schemas', 'code_blocks'];

  analyze(units: SemanticUnit[]): AuditSkillResult {
    const findings: AuditSkillFinding[] = [];

    for (const unit of units) {
      if (unit.type === 'parameter_schemas' && TEMPLATE_INJECTION.test(unit.content)) {
        findings.push({ auditSkill: this.name, severity: 'high', message: 'Template injection marker detected in schema', evidence: unit.content, unit: 'parameter_schemas' });
      }

      if (unit.type === 'code_blocks' && EXECUTION_PATTERNS.test(unit.content)) {
        findings.push({ auditSkill: this.name, severity: 'high', message: 'Dangerous runtime execution API detected', evidence: unit.content, unit: 'code_blocks' });
      }

      if (unit.type === 'code_blocks' && SQL_CONCAT.test(unit.content)) {
        findings.push({ auditSkill: this.name, severity: 'medium', message: 'Possible SQL string concatenation detected', evidence: unit.content, unit: 'code_blocks' });
      }
    }

    return { findings, score: scoreFromFindings(findings) };
  }
}

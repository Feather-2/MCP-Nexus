import type { SemanticUnit } from '../AuditDecomposer.js';
import type { AuditSkillFinding, AuditSkillHandler, AuditSkillResult } from '../AuditSkillRouter.js';

const NETWORK_PATTERN = /\b(fetch\s*\(|axios\.[\w$]+\s*\(|https?:\/\/|request\s*\(|curl\s+)/i;
const SENSITIVE_PATTERN = /\b(env|secret|api[_-]?key|token|password)\b/i;
const INSECURE_WRITE = /\b(writeFile|appendFile|cat\s+>)\b[\s\S]{0,120}(['"`](\/tmp\/|\.{1,2}\/)[^'"`\s]+['"`])/i;
const HTTP_ONLY = /\bhttp:\/\/[^\s'"`]+/i;
const PENALTY: Record<AuditSkillFinding['severity'], number> = { info: 0, low: 8, medium: 16, high: 28, critical: 40 };

function scoreFromFindings(findings: AuditSkillFinding[]): number {
  return Math.max(0, 100 - findings.reduce((total, item) => total + PENALTY[item.severity], 0));
}

export class DataflowAuditHandler implements AuditSkillHandler {
  name = 'audit-dataflow';
  targetUnits: Array<'data_flows' | 'code_blocks'> = ['data_flows', 'code_blocks'];

  analyze(units: SemanticUnit[]): AuditSkillResult {
    const findings: AuditSkillFinding[] = [];

    for (const unit of units) {
      const content = unit.content;
      if (NETWORK_PATTERN.test(content) && SENSITIVE_PATTERN.test(content)) {
        findings.push({ auditSkill: this.name, severity: 'high', message: 'Potential sensitive data exfiltration detected', evidence: content, unit: unit.type });
      }
      if (INSECURE_WRITE.test(content)) {
        findings.push({ auditSkill: this.name, severity: 'medium', message: 'Data write to insecure path detected', evidence: content, unit: unit.type });
      }
      if (HTTP_ONLY.test(content)) {
        findings.push({ auditSkill: this.name, severity: 'medium', message: 'Unencrypted network endpoint detected', evidence: content, unit: unit.type });
      }
    }

    return { findings, score: scoreFromFindings(findings) };
  }
}

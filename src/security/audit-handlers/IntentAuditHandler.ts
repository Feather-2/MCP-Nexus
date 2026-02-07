import type { SemanticUnit } from '../AuditDecomposer.js';
import type { AuditSkillFinding, AuditSkillHandler, AuditSkillResult } from '../AuditSkillRouter.js';

const SUSPICIOUS_NAME = /\b(hack|exploit|reverse|shell|payload|backdoor)\b/i;
const VAGUE_DESCRIPTION = /\b(todo|tbd|misc|various|something|generic)\b/i;
const PENALTY: Record<AuditSkillFinding['severity'], number> = { info: 0, low: 8, medium: 16, high: 28, critical: 40 };

function scoreFromFindings(findings: AuditSkillFinding[]): number {
  return Math.max(0, 100 - findings.reduce((total, item) => total + PENALTY[item.severity], 0));
}

function declaredToolCount(unit: SemanticUnit): number {
  const tools = unit.metadata?.['tools'];
  if (Array.isArray(tools)) return tools.length;
  const match = unit.content.match(/allowedTools:\s*([^\n]+)/i);
  if (!match?.[1]) return 0;
  return match[1].split(/[, \t\r\n]+/g).map((item) => item.trim()).filter(Boolean).length;
}

export class IntentAuditHandler implements AuditSkillHandler {
  name = 'audit-intent';
  targetUnits: Array<'tool_definitions'> = ['tool_definitions'];

  analyze(units: SemanticUnit[]): AuditSkillResult {
    const findings: AuditSkillFinding[] = [];
    let declaredTools = 0;

    for (const unit of units) {
      declaredTools += declaredToolCount(unit);
      if (SUSPICIOUS_NAME.test(unit.content)) {
        findings.push({ auditSkill: this.name, severity: 'high', message: 'Suspicious tool name pattern detected', evidence: unit.content, unit: 'tool_definitions' });
      }

      const compact = unit.content.replace(/\s+/g, ' ').trim();
      if (compact.length < 24 || VAGUE_DESCRIPTION.test(compact)) {
        findings.push({ auditSkill: this.name, severity: 'medium', message: 'Tool description is missing or vague', evidence: compact, unit: 'tool_definitions' });
      }
    }

    if (declaredTools > 10) {
      findings.push({ auditSkill: this.name, severity: 'medium', message: 'Tool declaration count is unusually high', evidence: `declared=${declaredTools}`, unit: 'tool_definitions' });
    }

    return { findings, score: scoreFromFindings(findings) };
  }
}

import type { SemanticUnit } from '../AuditDecomposer.js';
import type { AuditSkillFinding, AuditSkillHandler, AuditSkillResult } from '../AuditSkillRouter.js';

const PRIVILEGE_ESCALATION = /\b(sudo|chmod\s+777|chown\s+root|setuid)\b/i;
const CONTAINER_ESCAPE = /\b(docker\.sock|\/proc\/self|\/sys\/fs\/cgroup)\b/i;
const KERNEL_MODULE = /\b(insmod|modprobe)\b/i;
const PENALTY: Record<AuditSkillFinding['severity'], number> = { info: 0, low: 8, medium: 16, high: 28, critical: 40 };

function scoreFromFindings(findings: AuditSkillFinding[]): number {
  return Math.max(0, 100 - findings.reduce((total, item) => total + PENALTY[item.severity], 0));
}

export class PrivilegeAuditHandler implements AuditSkillHandler {
  name = 'audit-privilege';
  targetUnits: Array<'code_blocks'> = ['code_blocks'];

  analyze(units: SemanticUnit[]): AuditSkillResult {
    const findings: AuditSkillFinding[] = [];

    for (const unit of units) {
      if (PRIVILEGE_ESCALATION.test(unit.content)) {
        findings.push({ auditSkill: this.name, severity: 'high', message: 'Privilege escalation command detected', evidence: unit.content, unit: 'code_blocks' });
      }
      if (CONTAINER_ESCAPE.test(unit.content)) {
        findings.push({ auditSkill: this.name, severity: 'critical', message: 'Container escape indicator detected', evidence: unit.content, unit: 'code_blocks' });
      }
      if (KERNEL_MODULE.test(unit.content)) {
        findings.push({ auditSkill: this.name, severity: 'high', message: 'Kernel module load command detected', evidence: unit.content, unit: 'code_blocks' });
      }
    }

    return { findings, score: scoreFromFindings(findings) };
  }
}

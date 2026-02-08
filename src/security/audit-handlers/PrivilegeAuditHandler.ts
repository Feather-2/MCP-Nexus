import type { SemanticUnit } from '../AuditDecomposer.js';
import type { AuditSkillFinding, AuditSkillHandler, AuditSkillResult } from '../AuditSkillRouter.js';

const DEFAULT_PRIVILEGE_ESCALATION_PATTERN = /\b(sudo|chmod\s+777|chown\s+root|setuid)\b/i;
const DEFAULT_CONTAINER_ESCAPE_PATTERN = /\b(docker\.sock|\/proc\/self|\/sys\/fs\/cgroup)\b/i;
const DEFAULT_KERNEL_MODULE_PATTERN = /\b(insmod|modprobe)\b/i;
const PENALTY: Record<AuditSkillFinding['severity'], number> = { info: 0, low: 8, medium: 16, high: 28, critical: 40 };

function scoreFromFindings(findings: AuditSkillFinding[]): number {
  return Math.max(0, 100 - findings.reduce((total, item) => total + PENALTY[item.severity], 0));
}

export interface PrivilegeAuditHandlerOptions {
  privilegeEscalationPattern?: RegExp;
  containerEscapePattern?: RegExp;
  kernelModulePattern?: RegExp;
}

export class PrivilegeAuditHandler implements AuditSkillHandler {
  name = 'audit-privilege';
  targetUnits: Array<'code_blocks'> = ['code_blocks'];
  private readonly privilegeEscalationPattern: RegExp;
  private readonly containerEscapePattern: RegExp;
  private readonly kernelModulePattern: RegExp;

  constructor(options: PrivilegeAuditHandlerOptions = {}) {
    this.privilegeEscalationPattern = options.privilegeEscalationPattern ?? DEFAULT_PRIVILEGE_ESCALATION_PATTERN;
    this.containerEscapePattern = options.containerEscapePattern ?? DEFAULT_CONTAINER_ESCAPE_PATTERN;
    this.kernelModulePattern = options.kernelModulePattern ?? DEFAULT_KERNEL_MODULE_PATTERN;
  }

  analyze(units: SemanticUnit[]): AuditSkillResult {
    const findings: AuditSkillFinding[] = [];

    for (const unit of units) {
      if (this.privilegeEscalationPattern.test(unit.content)) {
        findings.push({ auditSkill: this.name, severity: 'high', message: 'Privilege escalation command detected', evidence: unit.content, unit: 'code_blocks' });
      }
      if (this.containerEscapePattern.test(unit.content)) {
        findings.push({ auditSkill: this.name, severity: 'critical', message: 'Container escape indicator detected', evidence: unit.content, unit: 'code_blocks' });
      }
      if (this.kernelModulePattern.test(unit.content)) {
        findings.push({ auditSkill: this.name, severity: 'high', message: 'Kernel module load command detected', evidence: unit.content, unit: 'code_blocks' });
      }
    }

    return { findings, score: scoreFromFindings(findings) };
  }
}

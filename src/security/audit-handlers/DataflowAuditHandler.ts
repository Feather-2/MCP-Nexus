import type { SemanticUnit } from '../AuditDecomposer.js';
import type { AuditSkillFinding, AuditSkillHandler, AuditSkillResult } from '../AuditSkillRouter.js';

const DEFAULT_NETWORK_PATTERN = /\b(fetch\s*\(|axios\.[\w$]+\s*\(|https?:\/\/|request\s*\(|curl\s+)/i;
const DEFAULT_SENSITIVE_PATTERN = /\b(env|secret|api[_-]?key|token|password)\b/i;
const DEFAULT_INSECURE_WRITE_PATTERN = /\b(writeFile|appendFile|cat\s+>)\b[\s\S]{0,120}(['"`](\/tmp\/|\.{1,2}\/)[^'"`\s]+['"`])/i;
const DEFAULT_HTTP_ONLY_PATTERN = /\bhttp:\/\/[^\s'"`]+/i;
const PENALTY: Record<AuditSkillFinding['severity'], number> = { info: 0, low: 8, medium: 16, high: 28, critical: 40 };

function scoreFromFindings(findings: AuditSkillFinding[]): number {
  return Math.max(0, 100 - findings.reduce((total, item) => total + PENALTY[item.severity], 0));
}

export interface DataflowAuditHandlerOptions {
  networkPattern?: RegExp;
  sensitivePattern?: RegExp;
  insecureWritePattern?: RegExp;
  httpOnlyPattern?: RegExp;
}

export class DataflowAuditHandler implements AuditSkillHandler {
  name = 'audit-dataflow';
  targetUnits: Array<'data_flows' | 'code_blocks'> = ['data_flows', 'code_blocks'];
  private readonly networkPattern: RegExp;
  private readonly sensitivePattern: RegExp;
  private readonly insecureWritePattern: RegExp;
  private readonly httpOnlyPattern: RegExp;

  constructor(options: DataflowAuditHandlerOptions = {}) {
    this.networkPattern = options.networkPattern ?? DEFAULT_NETWORK_PATTERN;
    this.sensitivePattern = options.sensitivePattern ?? DEFAULT_SENSITIVE_PATTERN;
    this.insecureWritePattern = options.insecureWritePattern ?? DEFAULT_INSECURE_WRITE_PATTERN;
    this.httpOnlyPattern = options.httpOnlyPattern ?? DEFAULT_HTTP_ONLY_PATTERN;
  }

  analyze(units: SemanticUnit[]): AuditSkillResult {
    const findings: AuditSkillFinding[] = [];

    for (const unit of units) {
      const content = unit.content;
      if (this.networkPattern.test(content) && this.sensitivePattern.test(content)) {
        findings.push({ auditSkill: this.name, severity: 'high', message: 'Potential sensitive data exfiltration detected', evidence: content, unit: unit.type });
      }
      if (this.insecureWritePattern.test(content)) {
        findings.push({ auditSkill: this.name, severity: 'medium', message: 'Data write to insecure path detected', evidence: content, unit: unit.type });
      }
      if (this.httpOnlyPattern.test(content)) {
        findings.push({ auditSkill: this.name, severity: 'medium', message: 'Unencrypted network endpoint detected', evidence: content, unit: unit.type });
      }
    }

    return { findings, score: scoreFromFindings(findings) };
  }
}

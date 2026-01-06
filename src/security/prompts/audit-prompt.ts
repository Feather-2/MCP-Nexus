import type { Skill } from '../../skills/types.js';

export const AI_AUDIT_OUTPUT_JSON_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'AiAuditResult',
  type: 'object',
  additionalProperties: false,
  required: ['riskLevel', 'confidence', 'findings', 'recommendation', 'explanation'],
  properties: {
    riskLevel: {
      type: 'string',
      enum: ['safe', 'suspicious', 'malicious'],
      description: 'Overall risk classification for the skill.'
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'Model confidence in the assessment (0-1).'
    },
    findings: {
      type: 'array',
      description: 'Concrete findings with evidence and reasoning.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['category', 'severity', 'evidence', 'reasoning'],
        properties: {
          category: {
            type: 'string',
            enum: [
              'intent_consistency',
              'obfuscation',
              'data_exfiltration',
              'credential_access',
              'social_engineering',
              'excessive_privileges',
              'supply_chain'
            ],
            description: 'Which analysis dimension this finding belongs to.'
          },
          severity: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'critical'],
            description: 'Finding severity.'
          },
          evidence: {
            type: 'string',
            description: 'Direct evidence (quotes/snippets, file path hints, or indicators).'
          },
          reasoning: {
            type: 'string',
            description: 'Why the evidence is risky and how it relates to the category.'
          }
        }
      }
    },
    recommendation: {
      type: 'string',
      enum: ['approve', 'review', 'reject'],
      description: 'Suggested action for a human reviewer (non-binding).'
    },
    explanation: {
      type: 'string',
      description: 'Short summary of the overall assessment.'
    }
  }
} as const;

function truncate(text: string, maxChars: number): string {
  const s = String(text ?? '');
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 24))}\n…(truncated, ${s.length} chars total)…`;
}

function formatSupportFiles(supportFiles?: Map<string, string>): string {
  if (!supportFiles || supportFiles.size === 0) return '(none)';

  const parts: string[] = [];
  let index = 0;

  for (const [relativePath, content] of supportFiles.entries()) {
    index += 1;
    const header = `--- file: ${relativePath} ---`;
    const body = truncate(content, 4_000);
    parts.push(`${header}\n${body}`);
    if (index >= 20) {
      parts.push(`--- (additional files omitted: total=${supportFiles.size}) ---`);
      break;
    }
  }

  return parts.join('\n\n');
}

export function buildAuditPrompt(skill: Skill): string {
  const capabilities = truncate(JSON.stringify(skill.capabilities ?? {}, null, 2), 6_000);
  const body = truncate(skill.body ?? '', 18_000);
  const support = formatSupportFiles(skill.supportFiles);

  return `
You are an expert security auditor for MCP Skills. Analyze the skill and return a STRUCTURED JSON result.

Key constraint: You DO NOT have veto power. Your output is a soft signal only. The downstream system will apply:
- If riskLevel="suspicious": weight=0.3, score=-30
- If riskLevel="malicious": weight=0.5, score=-50
- Final impact = score × weight × confidence

Analyze across these dimensions (use the mapped category values in findings):
1) 意图一致性 / Intent consistency (category="intent_consistency"): does behavior match the stated purpose?
2) 混淆检测 / Obfuscation (category="obfuscation"): high-entropy/base64/hex blobs, eval, self-modifying code.
3) 数据外传 / Data exfiltration (category="data_exfiltration"): unexpected network calls, uploads, hidden channels.
4) 凭证访问 / Credential access (category="credential_access"): env vars, .ssh, cloud creds, tokens, canaries.
5) 社会工程 / Social engineering (category="social_engineering"): phishing, coercive prompts, asking for secrets.
6) 权限过度 / Excessive privileges (category="excessive_privileges"): broad filesystem/network/subprocess access.
7) 供应链风险 / Supply chain risk (category="supply_chain"): download+execute, unpinned deps, install scripts.

Output requirements:
- Return ONLY a single JSON object.
- Must conform to the JSON Schema below.
- confidence must be within [0, 1].
- evidence should quote snippets or reference support file names when possible.

Skill metadata:
- name: ${skill.metadata?.name ?? ''}
- description: ${skill.metadata?.description ?? ''}
- allowedTools: ${skill.metadata?.allowedTools ?? ''}
- path: ${skill.metadata?.path ?? ''}
- scope: ${skill.metadata?.scope ?? ''}

Declared capabilities (JSON):
${capabilities}

----- BEGIN SKILL BODY -----
${body}
----- END SKILL BODY -----

----- BEGIN SUPPORT FILES -----
${support}
----- END SUPPORT FILES -----

JSON Schema (must match exactly):
${JSON.stringify(AI_AUDIT_OUTPUT_JSON_SCHEMA, null, 2)}
`.trim();
}


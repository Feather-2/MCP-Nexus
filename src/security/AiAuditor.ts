import { z } from 'zod';

import type { AiRequest, AiResult } from '../ai/types.js';
import type { Skill } from '../skills/types.js';
import { buildAuditPrompt } from './prompts/audit-prompt.js';

export type AiRiskLevel = 'safe' | 'suspicious' | 'malicious';
export type AiRecommendation = 'approve' | 'review' | 'reject';
export type AiFindingSeverity = 'low' | 'medium' | 'high' | 'critical';
export type AiFindingCategory =
  | 'intent_consistency'
  | 'obfuscation'
  | 'data_exfiltration'
  | 'credential_access'
  | 'social_engineering'
  | 'excessive_privileges'
  | 'supply_chain';

export interface AiFinding {
  category: AiFindingCategory;
  severity: AiFindingSeverity;
  evidence: string;
  reasoning: string;
}

export interface AiAuditResult {
  riskLevel: AiRiskLevel;
  confidence: number; // 0-1
  findings: AiFinding[];
  recommendation: AiRecommendation;
  explanation: string;
}

export interface AiSignalImpact {
  /**
   * The configured weight (base weight) for this riskLevel (0.3-0.5 for non-safe).
   * The final weight is multiplied by confidence at scoring time.
   */
  weight: number;
  /**
   * The configured score (negative penalty) for this riskLevel.
   */
  score: number;
  /**
   * Final impact = score × weight × confidence.
   */
  impact: number;
}

export const AI_SIGNAL_CONFIG: Readonly<Record<AiRiskLevel, Readonly<{ weight: number; score: number }>>> = {
  safe: { weight: 0, score: 0 },
  suspicious: { weight: 0.3, score: -30 },
  malicious: { weight: 0.5, score: -50 }
};

export function computeAiSignalImpact(input: Pick<AiAuditResult, 'riskLevel' | 'confidence'>): AiSignalImpact {
  const confidence = clamp01(input.confidence);
  const cfg = AI_SIGNAL_CONFIG[input.riskLevel];
  const rawImpact = cfg.score * cfg.weight * confidence;
  const impact = rawImpact === 0 ? 0 : rawImpact;
  return { weight: cfg.weight, score: cfg.score, impact };
}

export interface AiAuditorClient {
  generate(request: AiRequest, channelId?: string): Promise<Pick<AiResult, 'text'>>;
}

export interface AiAuditorOptions {
  channelId?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

const DEFAULT_SYSTEM_PROMPT =
  'You are a security auditor. Return ONLY a single JSON object that conforms to the provided JSON Schema. No markdown.';

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeToken(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.toLowerCase();
}

function normalizeCategory(value: unknown): string | undefined {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return undefined;

  const chineseMap: Record<string, AiFindingCategory> = {
    意图一致性: 'intent_consistency',
    混淆检测: 'obfuscation',
    数据外传: 'data_exfiltration',
    凭证访问: 'credential_access',
    社会工程: 'social_engineering',
    权限过度: 'excessive_privileges',
    供应链风险: 'supply_chain'
  };

  const mapped = chineseMap[raw];
  if (mapped) return mapped;

  const snake = raw.toLowerCase().trim().replace(/[\s-]+/g, '_');
  return snake || undefined;
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function extractJsonFromCodeFence(text: string): string | undefined {
  const match = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(text);
  if (!match) return undefined;
  const payload = String(match[1] ?? '').trim();
  return payload || undefined;
}

function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let idx = start; idx < text.length; idx += 1) {
    const ch = text[idx]!;

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (ch === '\\') {
        escaping = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;

    if (depth === 0 && idx > start) {
      const slice = text.slice(start, idx + 1).trim();
      return slice || undefined;
    }
  }

  return undefined;
}

const RiskLevelSchema = z.preprocess((value) => normalizeToken(value), z.enum(['safe', 'suspicious', 'malicious']));
const RecommendationSchema = z.preprocess((value) => normalizeToken(value), z.enum(['approve', 'review', 'reject']));
const SeveritySchema = z.preprocess((value) => normalizeToken(value), z.enum(['low', 'medium', 'high', 'critical']));
const CategorySchema = z.preprocess(
  (value) => normalizeCategory(value),
  z.enum([
    'intent_consistency',
    'obfuscation',
    'data_exfiltration',
    'credential_access',
    'social_engineering',
    'excessive_privileges',
    'supply_chain'
  ])
);
const ConfidenceSchema = z.preprocess((value) => coerceNumber(value), z.number().min(0).max(1));

const FindingSchema = z
  .object({
    category: CategorySchema,
    severity: SeveritySchema,
    evidence: z.string(),
    reasoning: z.string()
  })
  .strip();

const FindingsSchema = z.preprocess(
  (value) => (Array.isArray(value) ? value : undefined),
  z.array(FindingSchema).default([])
);

const AuditResultSchema = z
  .object({
    riskLevel: RiskLevelSchema,
    confidence: ConfidenceSchema,
    findings: FindingsSchema,
    recommendation: RecommendationSchema,
    explanation: z.string().default('')
  })
  .strip();

function parseAiAuditResult(text: string): AiAuditResult {
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error('Empty AI response');

  const candidates: string[] = [];
  candidates.push(raw);
  const fenced = extractJsonFromCodeFence(raw);
  if (fenced) candidates.push(fenced);
  const firstObject = extractFirstJsonObject(raw);
  if (firstObject) candidates.push(firstObject);

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate) as unknown;
      const parsed = AuditResultSchema.safeParse(obj);
      if (!parsed.success) throw parsed.error;
      const normalized = parsed.data as AiAuditResult;
      return {
        ...normalized,
        confidence: clamp01(normalized.confidence),
        explanation: String(normalized.explanation ?? '')
      };
    } catch (e) {
      lastError = e;
    }
  }

  throw new Error(`Invalid AI audit JSON: ${String((lastError as any)?.message ?? lastError)}`);
}

function fallbackResult(message: string): AiAuditResult {
  return {
    riskLevel: 'suspicious',
    confidence: 0,
    findings: [],
    recommendation: 'review',
    explanation: message
  };
}

export class AiAuditor {
  private readonly channelId?: string;
  private readonly model?: string;
  private readonly temperature: number;
  private readonly maxTokens: number;

  constructor(
    private readonly client: AiAuditorClient,
    options: AiAuditorOptions = {}
  ) {
    this.channelId = options.channelId;
    this.model = options.model;
    this.temperature = options.temperature ?? 0.1;
    this.maxTokens = options.maxTokens ?? 900;
  }

  async auditSkill(skill: Skill): Promise<AiAuditResult> {
    const prompt = buildAuditPrompt(skill);
    const request: AiRequest = {
      messages: [
        { role: 'system', content: DEFAULT_SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ],
      model: this.model,
      temperature: this.temperature,
      maxTokens: this.maxTokens
    };

    try {
      const result = await this.client.generate(request, this.channelId);
      return parseAiAuditResult(result.text);
    } catch (e: any) {
      const message = e?.message ? String(e.message) : String(e);
      return fallbackResult(`AI audit failed: ${message}`);
    }
  }
}

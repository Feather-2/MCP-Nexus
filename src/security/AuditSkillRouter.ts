import type { SemanticUnit, SemanticUnitType } from './AuditDecomposer.js';
import type { Logger } from '../types/index.js';
import { createDefaultHandlers } from './audit-handlers/index.js';

export interface AuditSkillFinding {
  auditSkill: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  message: string;
  evidence?: string;
  unit: SemanticUnitType;
}

export interface AuditSkillResult {
  findings: AuditSkillFinding[];
  score: number;
}

export interface AuditSkillHandler {
  name: string;
  targetUnits: SemanticUnitType[];
  analyze(units: SemanticUnit[]): AuditSkillResult;
}

export interface AuditSkillRouterOptions {
  logger?: Logger;
  handlers?: AuditSkillHandler[];
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

export class AuditSkillRouter {
  private readonly logger?: Logger;
  private readonly handlers: AuditSkillHandler[] = [];

  constructor(options: AuditSkillRouterOptions = {}) {
    this.logger = options.logger;
    const initial = options.handlers ?? createDefaultHandlers();
    for (const handler of initial) this.registerHandler(handler);
  }

  registerHandler(handler: AuditSkillHandler): void {
    const index = this.handlers.findIndex((item) => item.name === handler.name);
    if (index >= 0) {
      this.handlers[index] = handler;
      return;
    }
    this.handlers.push(handler);
  }

  getRegisteredHandlers(): string[] {
    return this.handlers.map((handler) => handler.name);
  }

  route(units: SemanticUnit[]): AuditSkillResult {
    const inputUnits = Array.isArray(units) ? units : [];
    if (this.handlers.length === 0) return { findings: [], score: 100 };

    const findings: AuditSkillFinding[] = [];
    const scores: number[] = [];

    for (const handler of this.handlers) {
      const matched = inputUnits.filter((unit) => handler.targetUnits.includes(unit.type));
      if (matched.length === 0) continue;

      try {
        const result = handler.analyze(matched);
        findings.push(...result.findings);
        scores.push(clampScore(result.score));
      } catch (error) {
        this.logger?.warn('Audit skill handler failed', { handler: handler.name, error });
        findings.push({
          auditSkill: handler.name,
          severity: 'high',
          message: 'Audit handler execution failed',
          evidence: error instanceof Error ? error.message : String(error),
          unit: handler.targetUnits[0] ?? 'code_blocks'
        });
        scores.push(30);
      }
    }

    if (scores.length === 0) return { findings, score: 100 };
    const average = Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length);
    return { findings, score: average };
  }
}

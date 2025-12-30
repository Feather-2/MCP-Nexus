import type { McpServiceConfig, SubagentConfig } from '../../types/index.js';
import type { OrchestratorStep } from '../types.js';
import { PlanningTree } from './types.js';

export interface PlanContext {
  subagents: SubagentConfig[];
  templates: McpServiceConfig[];
}

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function splitGoal(goal: string): string[] {
  const raw = goal
    .split(/(?:\band\b|\bthen\b|然后|并且|以及|;|\n|\r)/gi)
    .map((s) => s.trim())
    .filter(Boolean);
  return raw.length ? raw : [goal.trim()];
}

function hasAny(text: string, keywords: string[]): boolean {
  return keywords.some((k) => text.includes(k));
}

function pickTemplateByName(templates: McpServiceConfig[], names: string[]): string | undefined {
  const set = new Set(templates.map((t) => t.name));
  for (const n of names) {
    if (set.has(n)) return n;
  }
  return undefined;
}

function pickSearchTemplate(ctx: PlanContext): string {
  return pickTemplateByName(ctx.templates, ['brave-search']) || ctx.templates[0]?.name || 'brave-search';
}

function pickFilesystemTemplate(ctx: PlanContext): string {
  return pickTemplateByName(ctx.templates, ['filesystem']) || pickSearchTemplate(ctx);
}

function pickSqlTemplate(ctx: PlanContext): string {
  return pickTemplateByName(ctx.templates, ['sqlite']) || pickSearchTemplate(ctx);
}

function pickGithubTemplate(ctx: PlanContext): string {
  return pickTemplateByName(ctx.templates, ['github']) || pickSearchTemplate(ctx);
}

function bestSubagentForTemplate(ctx: PlanContext, templateName: string): string | undefined {
  const direct = ctx.subagents.find((s) => Array.isArray(s.tools) && s.tools.includes(templateName));
  return direct?.name;
}

function planForPart(part: string, ctx: PlanContext): OrchestratorStep {
  const text = normalize(part);

  // Rough intent classification (MVP)
  if (hasAny(text, ['search', 'find', 'lookup', 'query', '查', '搜', '?'])) {
    const template = pickSearchTemplate(ctx);
    return {
      subagent: bestSubagentForTemplate(ctx, template),
      template,
      tool: 'search',
      params: { query: part }
    };
  }

  if (hasAny(text, ['file', 'filesystem', 'read', 'write', 'ls', 'dir', '目录', '文件', '/'])) {
    const template = pickFilesystemTemplate(ctx);
    // Leave tool unset to allow engine auto-pick (read_file/write_file/list_directory) after tools/list.
    return { subagent: bestSubagentForTemplate(ctx, template), template, params: { goal: part } };
  }

  if (hasAny(text, ['sql', 'sqlite', 'database', 'db', '表', '查询'])) {
    const template = pickSqlTemplate(ctx);
    return { subagent: bestSubagentForTemplate(ctx, template), template, params: { goal: part } };
  }

  if (hasAny(text, ['github', 'repo', 'issue', 'pull', 'pr'])) {
    const template = pickGithubTemplate(ctx);
    return { subagent: bestSubagentForTemplate(ctx, template), template, params: { goal: part } };
  }

  // Fallback: if any subagent exists, prefer the first one; otherwise search template.
  const template = ctx.subagents[0]?.tools?.[0] || pickSearchTemplate(ctx);
  return { subagent: ctx.subagents[0]?.name, template, params: { goal: part } };
}

export class LocalPlanner {
  plan(goal: string, ctx: PlanContext): { plan: OrchestratorStep[]; tree: PlanningTree } {
    const tree = new PlanningTree(goal);
    const parts = splitGoal(goal);
    for (const p of parts) {
      const gap = tree.addGap(p, tree.rootGapId);
      const step = planForPart(p, ctx);
      tree.addStep(gap.id, step);
      tree.resolveGap(gap.id);
    }
    return { plan: tree.toPlan(), tree };
  }
}


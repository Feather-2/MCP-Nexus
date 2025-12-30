import { z } from 'zod';

export const OrchestratorStepSchema = z.object({
  subagent: z.string().min(1).optional(),
  /**
   * Explicit template name (preferred when known). When omitted, the engine will infer from subagent/tool.
   */
  template: z.string().min(1).optional(),
  /**
   * Tool name inside the selected MCP server. When omitted, the engine will auto-pick from tools/list.
   */
  tool: z.string().min(1).optional(),
  params: z.record(z.any()).optional(),
  retries: z.number().int().min(0).max(5).optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional()
});

export type OrchestratorStep = z.infer<typeof OrchestratorStepSchema>;

export const ExecuteRequestSchema = z.object({
  goal: z.string().min(1).optional(),
  steps: z.array(OrchestratorStepSchema).optional(),
  parallel: z.boolean().optional(),
  maxSteps: z.number().int().positive().max(64).optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional()
});

export type ExecuteRequest = z.infer<typeof ExecuteRequestSchema>;

export interface ExecuteResult {
  success: boolean;
  plan: OrchestratorStep[];
  results: Array<{ step: OrchestratorStep; ok: boolean; response?: any; error?: string; durationMs: number }>;
  used: { steps: number; durationMs: number };
}

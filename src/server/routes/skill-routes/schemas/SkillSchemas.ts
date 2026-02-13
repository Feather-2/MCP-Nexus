import { z } from 'zod';

export const ListQuerySchema = z.object({
  q: z.string().optional(),
  scope: z.enum(['repo', 'user', 'system', 'remote']).optional()
}).partial();

export const GetSkillQuerySchema = z.object({
  includeSupportFiles: z.coerce.boolean().optional()
}).partial();

export const LocalizedSkillQuerySchema = z.object({
  platform: z.string().optional()
}).partial();

export const DistributeBodySchema = z.object({
  platforms: z.array(z.string()).optional()
}).partial();

export const RegisterSkillBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  body: z.string().min(1),
  shortDescription: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  tags: z.record(z.string(), z.string()).optional(),
  traits: z.array(z.string()).optional(),
  allowedTools: z.string().optional(),
  priority: z.number().optional(),
  supportFiles: z.array(z.object({ path: z.string().min(1), content: z.string() })).optional(),
  overwrite: z.boolean().optional()
});

export const AuditBodySchema = z.object({
  name: z.string().min(1),
  dryRun: z.boolean().optional(),
  timeoutMsPerTool: z.number().int().positive().max(60000).optional()
});

export const SkillCapabilitiesSchema = z.object({
  filesystem: z.object({
    read: z.array(z.string()).optional(),
    write: z.array(z.string()).optional()
  }).partial().optional(),
  network: z.object({
    allowedHosts: z.array(z.string()).optional(),
    allowedPorts: z.array(z.union([z.number(), z.string()])).optional()
  }).partial().optional(),
  env: z.array(z.string()).optional(),
  subprocess: z.object({
    allowed: z.boolean().optional(),
    allowedCommands: z.array(z.string()).optional()
  }).partial().optional(),
  resources: z.object({
    maxMemoryMB: z.union([z.number(), z.string()]).optional(),
    maxCpuPercent: z.union([z.number(), z.string()]).optional(),
    timeoutMs: z.union([z.number(), z.string()]).optional()
  }).partial().optional()
}).partial();

export const SkillDefinitionSchema = z.object({
  metadata: z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    shortDescription: z.string().optional(),
    scope: z.enum(['repo', 'user', 'system', 'remote']).optional(),
    path: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    keywordsAll: z.array(z.string()).optional(),
    tags: z.record(z.string(), z.string()).optional(),
    traits: z.array(z.string()).optional(),
    allowedTools: z.string().optional(),
    priority: z.number().optional()
  }),
  body: z.string().min(1),
  capabilities: SkillCapabilitiesSchema.optional(),
  supportFiles: z.union([
    z.array(z.object({ path: z.string().min(1), content: z.string() })),
    z.record(z.string(), z.string())
  ]).optional()
});

export const MatchBodySchema = z.object({
  input: z.string().min(1),
  maxResults: z.number().int().positive().max(20).optional(),
  minScore: z.number().min(0).max(1).optional(),
  includeBodies: z.boolean().optional(),
  includeSupportFiles: z.boolean().optional()
});

export const CreateVersionBodySchema = z.object({
  reason: z.string().optional()
}).partial();

export const AuthorizeBodySchema = z.object({
  capabilities: SkillCapabilitiesSchema.optional(),
  userId: z.string().min(1).optional()
}).partial();

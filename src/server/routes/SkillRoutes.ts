import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';
import { SkillAuditor, SkillMatcher, SkillRegistry, SkillLoader } from '../../skills/index.js';
import type { Skill } from '../../skills/types.js';
import { mergeWithDefaults, validateCapabilities } from '../../security/CapabilityManifest.js';

const ListQuerySchema = z.object({
  q: z.string().optional(),
  scope: z.enum(['repo', 'user', 'system', 'remote']).optional()
}).partial();

const GetSkillQuerySchema = z.object({
  includeSupportFiles: z.coerce.boolean().optional()
}).partial();

const RegisterSkillBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  body: z.string().min(1),
  shortDescription: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  tags: z.record(z.string()).optional(),
  traits: z.array(z.string()).optional(),
  allowedTools: z.string().optional(),
  priority: z.number().optional(),
  supportFiles: z.array(z.object({ path: z.string().min(1), content: z.string() })).optional(),
  overwrite: z.boolean().optional()
});

const AuditBodySchema = z.object({
  name: z.string().min(1),
  dryRun: z.boolean().optional(),
  timeoutMsPerTool: z.number().int().positive().max(60000).optional()
});

const SkillCapabilitiesSchema = z.object({
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

const SkillDefinitionSchema = z.object({
  metadata: z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    shortDescription: z.string().optional(),
    scope: z.enum(['repo', 'user', 'system', 'remote']).optional(),
    path: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    keywordsAll: z.array(z.string()).optional(),
    tags: z.record(z.string()).optional(),
    traits: z.array(z.string()).optional(),
    allowedTools: z.string().optional(),
    priority: z.number().optional()
  }),
  body: z.string().min(1),
  capabilities: SkillCapabilitiesSchema.optional(),
  supportFiles: z.union([
    z.array(z.object({ path: z.string().min(1), content: z.string() })),
    z.record(z.string())
  ]).optional()
});

function normalizeSupportFiles(input?: z.infer<typeof SkillDefinitionSchema>['supportFiles']): Map<string, string> | undefined {
  if (!input) return undefined;
  if (Array.isArray(input)) {
    const entries = input.map((f) => [String(f.path), String(f.content ?? '')] as const);
    return new Map(entries);
  }
  const record = input as Record<string, string>;
  return new Map(Object.entries(record).map(([p, c]) => [String(p), String(c ?? '')]));
}

function buildSkillFromDefinition(input: z.infer<typeof SkillDefinitionSchema>): Skill {
  const caps = mergeWithDefaults(input.capabilities as any);
  validateCapabilities(caps);

  const keywords = Array.isArray(input.metadata.keywords) ? input.metadata.keywords.map(String) : [];
  const keywordsAll = Array.isArray(input.metadata.keywordsAll)
    ? input.metadata.keywordsAll.map(String)
    : keywords;

  return {
    metadata: {
      name: String(input.metadata.name),
      description: String(input.metadata.description),
      shortDescription: input.metadata.shortDescription,
      path: input.metadata.path ?? '',
      scope: input.metadata.scope ?? 'remote',
      keywords,
      keywordsAll,
      tags: input.metadata.tags,
      traits: input.metadata.traits,
      allowedTools: input.metadata.allowedTools,
      priority: input.metadata.priority ?? 0
    },
    body: String(input.body),
    capabilities: caps,
    supportFiles: normalizeSupportFiles(input.supportFiles)
  };
}

const MatchBodySchema = z.object({
  input: z.string().min(1),
  maxResults: z.number().int().positive().max(20).optional(),
  minScore: z.number().min(0).max(1).optional(),
  includeBodies: z.boolean().optional(),
  includeSupportFiles: z.boolean().optional()
});

export class SkillRoutes extends BaseRouteHandler {
  private readonly registry: SkillRegistry;
  private readonly matcher = new SkillMatcher();
  private readonly auditor: SkillAuditor;
  private readonly supportLoader: SkillLoader;
  private readonly initPromise: Promise<void>;
  private registryVersion = 0;
  private matcherIndexVersion = -1;
  private matcherIndexCache?: ReturnType<SkillMatcher['buildIndex']>;

  constructor(ctx: RouteContext) {
    super(ctx);

    const cfg: any = this.ctx.configManager?.getConfig?.() || {};
    const roots: string[] | undefined = Array.isArray(cfg?.skills?.roots) ? cfg.skills.roots : undefined;
    const managedRoot: string | undefined = typeof cfg?.skills?.managedRoot === 'string' ? cfg.skills.managedRoot : undefined;

    this.registry = new SkillRegistry({
      logger: this.ctx.logger,
      roots,
      managedRoot
    });

    this.auditor = new SkillAuditor({
      logger: this.ctx.logger,
      getGatewayConfig: () => this.ctx.configManager.getConfig(),
      templates: this.ctx.serviceRegistry,
      protocolAdapters: this.ctx.protocolAdapters
    });

    this.supportLoader = new SkillLoader({
      logger: this.ctx.logger,
      loadSupportFiles: true
    });

    this.initPromise = this.registry.reload().then(() => {
      this.registryVersion += 1;
    });
  }

  private getMatcherIndex(): ReturnType<SkillMatcher['buildIndex']> {
    if (this.matcherIndexCache && this.matcherIndexVersion === this.registryVersion) return this.matcherIndexCache;
    const index = this.matcher.buildIndex(this.registry.all());
    this.matcherIndexCache = index;
    this.matcherIndexVersion = this.registryVersion;
    return index;
  }

  setupRoutes(): void {
    const { server } = this.ctx;

    server.get('/api/skills', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await this.initPromise;
        const query = ListQuerySchema.parse((request.query as any) || {});
        const q = query.q?.trim().toLowerCase();
        const scope = query.scope;

        let skills = this.registry.list();
        if (scope) skills = skills.filter((s) => s.scope === scope);
        if (q) {
          const tokens = q.split(/\s+/).filter(Boolean);
          skills = skills.filter((s) => {
            const hay = `${s.name} ${s.description} ${(s.shortDescription || '')}`.toLowerCase();
            if (hay.includes(q)) return true;
            return tokens.some((t) => s.keywordsAll.includes(t));
          });
        }

        reply.send({ success: true, skills });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to list skills';
        return this.respondError(reply, 500, message, { code: 'SKILLS_LIST_FAILED' });
      }
    });

    server.get('/api/skills/:name', async (request: FastifyRequest, reply: FastifyReply) => {
      const params = z.object({ name: z.string().min(1) }).parse(request.params as any);
      const query = GetSkillQuerySchema.parse((request.query as any) || {});

      try {
        await this.initPromise;
        const skill = this.registry.get(params.name);
        if (!skill) {
          return this.respondError(reply, 404, `Skill not found: ${params.name}`, { code: 'SKILL_NOT_FOUND', recoverable: true });
        }

        if (!query.includeSupportFiles) {
          reply.send({ success: true, skill: { metadata: skill.metadata, body: skill.body } });
          return;
        }

        const loaded = await this.supportLoader.loadSkillFromSkillMd(skill.metadata.path);
        const supportFiles = loaded?.supportFiles ? Object.fromEntries(loaded.supportFiles.entries()) : {};
        reply.send({
          success: true,
          skill: {
            metadata: skill.metadata,
            body: loaded?.body ?? skill.body,
            supportFiles
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to get skill';
        return this.respondError(reply, 500, message, { code: 'SKILL_GET_FAILED' });
      }
    });

    server.post('/api/skills/register', async (request: FastifyRequest, reply: FastifyReply) => {
      let body: z.infer<typeof RegisterSkillBodySchema>;
      try {
        body = RegisterSkillBodySchema.parse((request.body as any) || {});
      } catch (e) {
        const err = e as z.ZodError;
        return this.respondError(reply, 400, 'Invalid request body', { code: 'BAD_REQUEST', recoverable: true, meta: err.errors });
      }

      try {
        await this.initPromise;
        const skill = await this.registry.register(body);
        this.registryVersion += 1;
        this.matcherIndexCache = undefined;
        reply.send({ success: true, skill: { metadata: skill.metadata } });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to register skill';
        return this.respondError(reply, 500, message, { code: 'SKILL_REGISTER_FAILED' });
      }
    });

    server.delete('/api/skills/:name', async (request: FastifyRequest, reply: FastifyReply) => {
      const params = z.object({ name: z.string().min(1) }).parse(request.params as any);

      try {
        await this.initPromise;
        const deleted = await this.registry.delete(params.name);
        if (deleted) {
          this.registryVersion += 1;
          this.matcherIndexCache = undefined;
        }
        reply.send({ success: true, deleted });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to delete skill';
        return this.respondError(reply, 500, message, { code: 'SKILL_DELETE_FAILED' });
      }
    });

    server.post('/api/skills/audit', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const raw = (request.body as any) || {};

        const isDefinition =
          raw &&
          typeof raw === 'object' &&
          raw.metadata &&
          typeof raw.metadata === 'object' &&
          typeof raw.body === 'string';

        if (isDefinition) {
          const def = SkillDefinitionSchema.parse(raw);
          let skill: Skill;
          try {
            skill = buildSkillFromDefinition(def);
          } catch (e: any) {
            return this.respondError(reply, 400, e?.message || 'Invalid skill definition', {
              code: 'BAD_REQUEST',
              recoverable: true
            });
          }
          const result = await this.auditor.auditSecurity(skill);
          reply.send({ success: true, result });
          return;
        }

        const body = AuditBodySchema.parse(raw);
        await this.initPromise;
        const skill = this.registry.get(body.name);
        if (!skill) {
          return this.respondError(reply, 404, `Skill not found: ${body.name}`, { code: 'SKILL_NOT_FOUND', recoverable: true });
        }

        const result = await this.auditor.auditSkill(skill, { dryRun: body.dryRun, timeoutMsPerTool: body.timeoutMsPerTool });
        reply.send({ success: true, result });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return this.respondError(reply, 400, 'Invalid request body', { code: 'BAD_REQUEST', recoverable: true, meta: error.errors });
        }
        const message = error instanceof Error ? error.message : 'Failed to audit skill';
        return this.respondError(reply, 500, message, { code: 'SKILL_AUDIT_FAILED' });
      }
    });

    server.post('/api/skills/match', async (request: FastifyRequest, reply: FastifyReply) => {
      let body: z.infer<typeof MatchBodySchema>;
      try {
        body = MatchBodySchema.parse((request.body as any) || {});
      } catch (e) {
        const err = e as z.ZodError;
        return this.respondError(reply, 400, 'Invalid request body', { code: 'BAD_REQUEST', recoverable: true, meta: err.errors });
      }

      try {
        await this.initPromise;
        const matches = this.matcher.match(body.input, this.getMatcherIndex(), {
          maxResults: body.maxResults,
          minScore: body.minScore
        });

        const includeBodies = Boolean(body.includeBodies);
        const includeSupportFiles = Boolean(body.includeSupportFiles);

        const payload = await Promise.all(matches.map(async (m) => {
          if (!includeBodies && !includeSupportFiles) {
            return { metadata: m.skill.metadata, ...m.result };
          }
          const loaded = includeSupportFiles
            ? await this.supportLoader.loadSkillFromSkillMd(m.skill.metadata.path)
            : undefined;
          const supportFiles = includeSupportFiles && loaded?.supportFiles ? Object.fromEntries(loaded.supportFiles.entries()) : undefined;
          return {
            metadata: m.skill.metadata,
            ...m.result,
            body: includeBodies ? (loaded?.body ?? m.skill.body) : undefined,
            supportFiles
          };
        }));

        const injection = includeBodies ? this.matcher.formatInjection(matches.map((m) => m.skill)) : undefined;
        reply.send({ success: true, matches: payload, injection });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to match skills';
        return this.respondError(reply, 500, message, { code: 'SKILL_MATCH_FAILED' });
      }
    });
  }
}

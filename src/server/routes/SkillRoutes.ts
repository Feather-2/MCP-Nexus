import path from 'path';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';
import { SkillAuditor, SkillMatcher, SkillRegistry, SkillLoader, SkillVersionStore, SkillAuthorization, SkillLocalizer } from '../../skills/index.js';
import {
  createListHandler,
  createGetHandler,
  createGetContentHandler,
  createRegisterHandler,
  createDeleteHandler
} from './skill-routes/handlers/SkillCrudHandlers.js';
import {
  createAuditHandler,
  createAuditSummaryHandler
} from './skill-routes/handlers/SkillAuditHandlers.js';
import { createMatchHandler } from './skill-routes/handlers/SkillMatchHandlers.js';
import {
  createListVersionsHandler,
  createCreateVersionHandler,
  createRollbackHandler
} from './skill-routes/handlers/SkillVersionHandlers.js';
import {
  createGetPermissionsHandler,
  createAuthorizeHandler,
  createRevokeHandler
} from './skill-routes/handlers/SkillAuthHandlers.js';
import {
  createGetLocalizedHandler,
  createDistributeHandler,
  createUndistributeHandler,
  createGetPlatformsHandler
} from './skill-routes/handlers/SkillDistributionHandlers.js';

export class SkillRoutes extends BaseRouteHandler {
  private readonly registry: SkillRegistry;
  private readonly matcher = new SkillMatcher();
  private readonly auditor: SkillAuditor;
  private readonly supportLoader: SkillLoader;
  private readonly versionStore: SkillVersionStore;
  private readonly authorization: SkillAuthorization;
  private readonly localizer: SkillLocalizer;
  private readonly initPromise: Promise<void>;
  private registryVersion = 0;
  private matcherIndexVersion = -1;
  private matcherIndexCache?: ReturnType<SkillMatcher['buildIndex']>;

  constructor(ctx: RouteContext) {
    super(ctx);

    const cfg = (this.ctx.configManager?.getConfig?.() || {}) as Record<string, unknown>;
    const skillsCfg = (cfg?.skills || {}) as Record<string, unknown>;
    const roots: string[] | undefined = Array.isArray(skillsCfg?.roots) ? skillsCfg.roots as string[] : undefined;
    const managedRoot: string | undefined = typeof skillsCfg?.managedRoot === 'string' ? skillsCfg.managedRoot as string : undefined;

    this.registry = new SkillRegistry({
      logger: this.ctx.logger,
      roots,
      managedRoot
    });

    this.auditor = new SkillAuditor({
      logger: this.ctx.logger,
      getGatewayConfig: () => this.ctx.configManager.getConfig(),
      templates: this.ctx.serviceRegistry,
      protocolAdapters: this.ctx.protocolAdapters,
      eventBus: this.ctx.eventBus
    });

    this.supportLoader = new SkillLoader({
      logger: this.ctx.logger,
      loadSupportFiles: true
    });

    const storageRoot = typeof skillsCfg?.versionsRoot === 'string' && (skillsCfg.versionsRoot as string).trim().length
      ? skillsCfg.versionsRoot as string
      : path.resolve(process.cwd(), 'data');
    this.versionStore = new SkillVersionStore({
      storageRoot,
      logger: this.ctx.logger
    });
    this.authorization = new SkillAuthorization({
      storageRoot,
      logger: this.ctx.logger
    });
    this.localizer = new SkillLocalizer({
      logger: this.ctx.logger
    });

    this.initPromise = this.registry.reload().then(() => {
      this.registryVersion += 1;
    }).catch((error) => {
      this.ctx.logger.error('Skill registry initial load failed', { error: (error as Error).message });
    });
  }

  private getMatcherIndex(): ReturnType<SkillMatcher['buildIndex']> {
    if (this.matcherIndexCache && this.matcherIndexVersion === this.registryVersion) return this.matcherIndexCache;
    const index = this.matcher.buildIndex(this.registry.all());
    this.matcherIndexCache = index;
    this.matcherIndexVersion = this.registryVersion;
    return index;
  }

  private onRegistryChange(): void {
    this.registryVersion += 1;
    this.matcherIndexCache = undefined;
  }

  setupRoutes(): void {
    const { server } = this.ctx;

    // CRUD operations
    server.get('/api/skills', createListHandler(this.ctx, this.registry, this.authorization, this.initPromise));
    server.get('/api/skills/:name', createGetHandler(this.ctx, this.registry, this.supportLoader, this.initPromise));
    server.get('/api/skills/:name/content', createGetContentHandler(this.ctx, this.registry, this.supportLoader, this.initPromise));
    server.post('/api/skills/register', createRegisterHandler(this.ctx, this.registry, this.localizer, this.initPromise, () => this.onRegistryChange()));
    server.delete('/api/skills/:name', createDeleteHandler(this.ctx, this.registry, this.initPromise, () => this.onRegistryChange()));

    // Audit operations
    server.post('/api/skills/audit', createAuditHandler(this.ctx, this.registry, this.auditor, this.initPromise));
    server.get('/api/skills/:name/audit-summary', createAuditSummaryHandler(this.ctx, this.registry, this.auditor, this.initPromise));

    // Match operations
    server.post('/api/skills/match', createMatchHandler(this.ctx, this.matcher, this.supportLoader, this.authorization, () => this.getMatcherIndex(), this.initPromise));

    // Version management
    server.get('/api/skills/:name/versions', createListVersionsHandler(this.ctx, this.versionStore, this.initPromise));
    server.post('/api/skills/:name/versions', createCreateVersionHandler(this.ctx, this.registry, this.versionStore, this.supportLoader, this.initPromise));
    server.post('/api/skills/:name/rollback/:versionId', createRollbackHandler(this.ctx, this.registry, this.versionStore, this.localizer, this.initPromise, () => this.onRegistryChange()));

    // Permission/Authorization
    server.get('/api/skills/:name/permissions', createGetPermissionsHandler(this.ctx, this.registry, this.authorization, this.initPromise));
    server.post('/api/skills/:name/authorize', createAuthorizeHandler(this.ctx, this.registry, this.authorization, this.initPromise));
    server.post('/api/skills/:name/revoke', createRevokeHandler(this.ctx, this.registry, this.authorization, this.initPromise));

    // Localization/Distribution
    server.get('/api/skills/:name/localized', createGetLocalizedHandler(this.ctx, this.registry, this.localizer, this.initPromise));
    server.post('/api/skills/:name/distribute', createDistributeHandler(this.ctx, this.registry, this.localizer, this.initPromise));
    server.delete('/api/skills/:name/distribute', createUndistributeHandler(this.ctx, this.registry, this.localizer, this.initPromise));
    server.get('/api/skills/platforms', createGetPlatformsHandler(this.ctx, this.localizer));
  }
}

import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';
import { GitHubPackageResolver } from '../../gateway/GitHubPackageResolver.js';
import { SandboxPackageInstaller } from '../../gateway/SandboxPackageInstaller.js';
import { SandboxPaths, dirSize } from '../../utils/SandboxUtils.js';

const ResolveBody = z.object({
  source: z.string().min(1)
});

const InstallBody = z.object({
  packageSpec: z.string().min(1),
  timeout: z.number().int().positive().optional()
});

const InstanceIdParams = z.object({
  id: z.string().min(1)
});

const AutostartBody = z.object({
  autostart: z.boolean()
});

/**
 * Deployment chain routes: resolve/install/policy/status + instance persistence controls.
 */
export class DeploymentRoutes extends BaseRouteHandler {
  constructor(ctx: RouteContext) {
    super(ctx);
  }

  setupRoutes(): void {
    const { server } = this.ctx;

    // Resolve GitHub URL/npm package into deployable template config
    server.post('/api/deploy/resolve', async (request: FastifyRequest, reply: FastifyReply) => {
      let body: z.infer<typeof ResolveBody>;
      try {
        body = ResolveBody.parse((request.body as Record<string, unknown>) || {});
      } catch (e) {
        const err = e as z.ZodError;
        return this.respondError(reply, 400, 'Invalid request body', { code: 'BAD_REQUEST', recoverable: true, meta: err.issues });
      }

      if (!this.ctx.deploymentPolicy) {
        return this.respondError(reply, 503, 'Deployment subsystem not configured', { code: 'SERVICE_UNAVAILABLE', recoverable: true });
      }

      try {
        const resolver = new GitHubPackageResolver(this.ctx.logger, this.ctx.deploymentPolicy);
        const resolved = await resolver.resolve(body.source);
        reply.send({ success: true, package: resolved });
      } catch (error) {
        return this.respondError(reply, 400, (error as Error)?.message || 'Failed to resolve package source', { code: 'RESOLVE_FAILED', recoverable: true });
      }
    });

    // Install package into sandbox
    server.post('/api/deploy/install', async (request: FastifyRequest, reply: FastifyReply) => {
      let body: z.infer<typeof InstallBody>;
      try {
        body = InstallBody.parse((request.body as Record<string, unknown>) || {});
      } catch (e) {
        const err = e as z.ZodError;
        return this.respondError(reply, 400, 'Invalid request body', { code: 'BAD_REQUEST', recoverable: true, meta: err.issues });
      }

      if (!this.ctx.deploymentPolicy) {
        return this.respondError(reply, 503, 'Deployment subsystem not configured', { code: 'SERVICE_UNAVAILABLE', recoverable: true });
      }

      try {
        const installer = new SandboxPackageInstaller(this.ctx.logger, this.ctx.deploymentPolicy);
        const result = await installer.install(body.packageSpec, { timeout: body.timeout });
        if (!result.success) {
          return this.respondError(reply, 400, result.error || 'Package installation failed', { code: 'INSTALL_FAILED', recoverable: true });
        }
        reply.send({ success: true, result });
      } catch (error) {
        return this.respondError(reply, 400, (error as Error)?.message || 'Failed to install package', { code: 'INSTALL_FAILED', recoverable: true });
      }
    });

    // Get deployment policy status/limits
    server.get('/api/deploy/policy', async (_request: FastifyRequest, reply: FastifyReply) => {
      if (!this.ctx.deploymentPolicy) {
        return this.respondError(reply, 503, 'Deployment subsystem not configured', { code: 'SERVICE_UNAVAILABLE', recoverable: true });
      }

      reply.send({
        limits: this.ctx.deploymentPolicy.getLimits(),
        authorizationMode: this.ctx.deploymentPolicy.getAuthorizationMode(),
        activeProcesses: this.ctx.deploymentPolicy.getActiveProcessCount()
      });
    });

    // Get deployment sandbox disk/process status
    server.get('/api/deploy/status', async (_request: FastifyRequest, reply: FastifyReply) => {
      let diskUsageBytes = 0;
      try {
        diskUsageBytes = await dirSize(SandboxPaths.base);
      } catch {
        diskUsageBytes = 0;
      }

      if (!this.ctx.deploymentPolicy) {
        return reply.send({ diskUsageBytes });
      }

      const limits = this.ctx.deploymentPolicy.getLimits();
      reply.send({
        diskUsageBytes,
        activeProcesses: this.ctx.deploymentPolicy.getActiveProcessCount(),
        limits: {
          maxSandboxDiskBytes: limits.maxSandboxDiskBytes,
          maxConcurrentProcesses: limits.maxConcurrentProcesses
        }
      });
    });

    // List persisted service instances
    server.get('/api/instances/persisted', async (_request: FastifyRequest, reply: FastifyReply) => {
      if (!this.ctx.instancePersistence) {
        return this.respondError(reply, 503, 'Instance persistence not configured', { code: 'SERVICE_UNAVAILABLE', recoverable: true });
      }

      const instances = this.ctx.instancePersistence.getAllEntries();
      const autostartCount = Object.values(instances).filter((entry) => entry.autostart === true).length;
      reply.send({ instances, autostartCount });
    });

    // Toggle autostart flag for a persisted instance
    server.put('/api/instances/:id/autostart', async (request: FastifyRequest, reply: FastifyReply) => {
      let params: z.infer<typeof InstanceIdParams>;
      let body: z.infer<typeof AutostartBody>;
      try {
        params = InstanceIdParams.parse(request.params as Record<string, unknown>);
        body = AutostartBody.parse((request.body as Record<string, unknown>) || {});
      } catch (e) {
        const err = e as z.ZodError;
        return this.respondError(reply, 400, 'Invalid request', { code: 'BAD_REQUEST', recoverable: true, meta: err.issues });
      }

      if (!this.ctx.instancePersistence) {
        return this.respondError(reply, 503, 'Instance persistence not configured', { code: 'SERVICE_UNAVAILABLE', recoverable: true });
      }

      const instances = this.ctx.instancePersistence.getAllEntries();
      if (!instances[params.id]) {
        return this.respondError(reply, 404, 'Persisted instance not found', { code: 'NOT_FOUND', recoverable: true });
      }

      this.ctx.instancePersistence.setAutostart(params.id, body.autostart);
      await this.ctx.instancePersistence.flush();
      reply.send({ success: true });
    });
  }
}

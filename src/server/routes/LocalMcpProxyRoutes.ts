import { FastifyRequest, FastifyReply } from 'fastify';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';
import { randomBytes, createHash, createHmac, pbkdf2Sync, scryptSync, randomUUID } from 'crypto';
import { z } from 'zod';

/**
 * Local MCP Proxy routes for secure browser-based MCP access
 * Implements handshake-based authentication with verification codes
 */
export class LocalMcpProxyRoutes extends BaseRouteHandler {
  // Constants
  private static readonly HANDSHAKE_EXPIRY_SECONDS = 60; // 1 minute
  private static readonly TOKEN_EXPIRY_SECONDS = 600; // 10 minutes
  private static readonly CODE_ROTATION_MS = 60_000; // 60s
  private static readonly RATE_CLEANUP_INTERVAL_MS = 5 * 60_000; // 5 minutes

  // Verification code rotation
  private currentVerificationCode: string = '';
  private previousVerificationCode: string = '';
  private codeExpiresAt: number = 0;
  private codeRotationMs: number = LocalMcpProxyRoutes.CODE_ROTATION_MS; // 60s
  private codeRotationTimer?: ReturnType<typeof setInterval>;

  // Handshake and token stores
  private handshakeStore = new Map<string, {
    id: string;
    origin: string;
    clientNonce: string;
    serverNonce: string;
    kdf: 'pbkdf2' | 'scrypt';
    kdfParams: any;
    approved: boolean;
    expiresAt: number;
  }>();
  private tokenStore = new Map<string, { origin: string; expiresAt: number }>();
  private rateCounters = new Map<string, number[]>();
  private rateCleanupTimer?: ReturnType<typeof setInterval>;

  constructor(ctx: RouteContext) {
    super(ctx);
    this.rotateVerificationCode();
    this.codeRotationTimer = setInterval(() => this.rotateVerificationCode(), this.codeRotationMs);
    // Periodic cleanup to prevent rateCounters memory leak
    this.rateCleanupTimer = setInterval(() => this.cleanupRateCounters(), LocalMcpProxyRoutes.RATE_CLEANUP_INTERVAL_MS);
  }

  setupRoutes(): void {
    const { server } = this.ctx;

    // Get current verification code
    server.get('/local-proxy/code', async (_req, reply) => {
      const now = Date.now();
      const expiresIn = Math.max(0, Math.floor((this.codeExpiresAt - now) / 1000));
      reply.send({ code: this.currentVerificationCode, expiresIn });
    });

    // Handshake init
    server.post('/handshake/init', async (request, reply) => {
      try {
        const origin = this.requireAndValidateOrigin(request, reply);
        if (!origin) return; // replied

        const initSchema = z.object({
          clientNonce: z.string().min(1),
          codeProof: z.string().regex(/^[a-fA-F0-9]{64}$/)
        });
        const { clientNonce, codeProof } = initSchema.parse((request.body as any) || {});

        // Rate limit per origin (max 5/minute)
        if (!this.checkRateLimit(`init:${origin}`, 5, 60_000)) {
          this.ctx.addLogEntry('warn', `mcp.local.handshake_init rate_limited for ${origin}`);
          return this.respondError(reply, 429, 'Rate limited', { code: 'RATE_LIMIT', recoverable: true });
        }

        // Validate codeProof against current or previous code
        const expectedCurrent = createHash('sha256').update(`${this.currentVerificationCode}|${origin}|${clientNonce}`).digest('hex');
        const expectedPrev = this.previousVerificationCode
          ? createHash('sha256').update(`${this.previousVerificationCode}|${origin}|${clientNonce}`).digest('hex')
          : '';
        if (codeProof !== expectedCurrent && codeProof !== expectedPrev) {
          this.ctx.addLogEntry('warn', `mcp.local.handshake_init invalid_code origin=${origin}`);
          return this.respondError(reply, 401, 'Invalid code proof', { code: 'INVALID_CODE', recoverable: true });
        }

        const handshakeId = randomUUID();
        const serverNonceBytes = randomBytes(16);
        const serverNonce = serverNonceBytes.toString('base64');
        const kdf: 'pbkdf2' = 'pbkdf2';
        const kdfParams = { iterations: 200_000, hash: 'SHA-256', length: 32 };
        const expiresIn = LocalMcpProxyRoutes.HANDSHAKE_EXPIRY_SECONDS; // seconds

        this.handshakeStore.set(handshakeId, {
          id: handshakeId,
          origin,
          clientNonce,
          serverNonce,
          kdf,
          kdfParams,
          approved: false,
          expiresAt: Date.now() + expiresIn * 1000
        });

        this.ctx.addLogEntry('info', 'mcp.local.handshake_init', undefined, { origin, handshakeId });
        reply.send({ handshakeId, serverNonce, expiresIn, kdf, kdfParams });
      } catch (err: any) {
        if (err instanceof z.ZodError) {
          return this.respondError(reply, 400, 'Invalid request body', { code: 'BAD_REQUEST', recoverable: true, meta: err.errors });
        }
        // Error already handled in requireAndValidateOrigin
        if (!reply.sent) return this.respondError(reply, 500, err?.message || 'Internal error', { code: 'INTERNAL_ERROR' });
      }
    });

    // Approve handshake (UI action)
    server.post('/handshake/approve', async (request, reply) => {
      const approveSchema = z.object({
        handshakeId: z.string().min(1),
        approve: z.boolean().optional().default(true)
      });
      let parsed: z.infer<typeof approveSchema>;
      try {
        parsed = approveSchema.parse((request.body as any) || {});
      } catch (e) {
        const err = e as z.ZodError;
        return this.respondError(reply, 400, 'Invalid request body', { code: 'BAD_REQUEST', recoverable: true, meta: err.errors });
      }
      const { handshakeId, approve } = parsed;
      const hs = this.handshakeStore.get(handshakeId);
      if (!hs) return this.respondError(reply, 404, 'Handshake not found', { code: 'NOT_FOUND', recoverable: true });
      if (Date.now() > hs.expiresAt) return this.respondError(reply, 409, 'Handshake expired', { code: 'HANDSHAKE_EXPIRED', recoverable: true });
      hs.approved = !!approve;
      this.ctx.addLogEntry('info', `mcp.local.handshake_${approve ? 'approve' : 'reject'}`, undefined, { handshakeId, origin: hs.origin });
      reply.send({ success: true });
    });

    // Confirm handshake
    server.post('/handshake/confirm', async (request, reply) => {
      try {
        const origin = this.requireAndValidateOrigin(request, reply);
        if (!origin) return;
        const confirmSchema = z.object({
          handshakeId: z.string().min(1),
          response: z.string().min(1)
        });
        const { handshakeId, response } = confirmSchema.parse((request.body as any) || {});
        const hs = this.handshakeStore.get(handshakeId);
        if (!hs) return this.respondError(reply, 404, 'Handshake not found', { code: 'NOT_FOUND', recoverable: true });
        if (Date.now() > hs.expiresAt) return this.respondError(reply, 409, 'Handshake expired', { code: 'EXPIRED', recoverable: true });
        if (!hs.approved) return this.respondError(reply, 403, 'Handshake not approved', { code: 'NOT_APPROVED', recoverable: true });
        if (hs.origin !== origin) return this.respondError(reply, 403, 'Origin mismatch', { code: 'ORIGIN_MISMATCH', recoverable: true });

        // Derive key with current or previous code
        const keyFrom = (code: string) => {
          if (hs.kdf === 'pbkdf2') {
            return pbkdf2Sync(code, Buffer.from(hs.serverNonce, 'base64'), hs.kdfParams.iterations, hs.kdfParams.length, 'sha256');
          }
          return scryptSync(code, Buffer.from(hs.serverNonce, 'base64'), hs.kdfParams.length, { N: 32768, r: 8, p: 1 });
        };
        const expectedFor = (code: string) => {
          const key = keyFrom(code);
          const data = `${origin}|${hs.clientNonce}|${handshakeId}`;
          return createHmac('sha256', key).update(data).digest('base64');
        };
        const ok = response === expectedFor(this.currentVerificationCode) || (!!this.previousVerificationCode && response === expectedFor(this.previousVerificationCode));
        if (!ok) return this.respondError(reply, 401, 'Invalid response', { code: 'BAD_RESPONSE', recoverable: true });

        // Issue token
        const token = randomBytes(32).toString('base64');
        const expiresIn = LocalMcpProxyRoutes.TOKEN_EXPIRY_SECONDS; // 10 minutes
        this.tokenStore.set(token, { origin, expiresAt: Date.now() + expiresIn * 1000 });

        // One-time handshake consumption
        this.handshakeStore.delete(handshakeId);
        this.ctx.addLogEntry('info', 'mcp.local.handshake_confirm', undefined, { origin });
        reply.send({ success: true, token, expiresIn });
      } catch (err: any) {
        if (err instanceof z.ZodError) {
          return this.respondError(reply, 400, 'Invalid request body', { code: 'BAD_REQUEST', recoverable: true, meta: err.errors });
        }
        if (!reply.sent) return this.respondError(reply, 500, err?.message || 'Internal error', { code: 'INTERNAL_ERROR' });
      }
    });

    // List tools (main endpoint) + compatibility alias
    server.get('/tools', (req, rep) => this.handleToolsList(req, rep));
    server.get('/local-proxy/tools', (req, rep) => this.handleToolsList(req, rep));

    // Call tool (main endpoint) + compatibility alias
    server.post('/call', (req, rep) => this.handleToolCall(req, rep));
    server.post('/local-proxy/call', (req, rep) => this.handleToolCall(req, rep));
  }

  // Shared handler: list tools
  private async handleToolsList(request: FastifyRequest, reply: FastifyReply) {
    const origin = request.headers.origin as string | undefined;
    const token = this.extractLocalMcpToken(request);
    if (!token) return this.respondError(reply, 401, 'Missing Authorization', { code: 'UNAUTHORIZED', recoverable: true });
    if (!this.validateToken(token, origin)) return this.respondError(reply, 403, 'Forbidden', { code: 'FORBIDDEN', recoverable: true });
    const qSchema = z.object({ serviceId: z.string().min(1).optional() });
    let serviceId: string | undefined;
    try {
      const parsed = qSchema.parse((request.query as any) || {});
      serviceId = parsed.serviceId;
    } catch (e) {
      const err = e as z.ZodError;
      return this.respondError(reply, 400, 'Invalid query', { code: 'BAD_REQUEST', recoverable: true, meta: err.errors });
    }
    try {
      const service = await this.findTargetService(serviceId);
      if (!service) return this.respondError(reply, 404, 'No suitable service', { code: 'NO_SERVICE', recoverable: true });
      const adapter = await this.ctx.protocolAdapters.createAdapter(service.config);
      await adapter.connect();
      try {
        const msg: any = { jsonrpc: '2.0', id: `tools-list-${Date.now()}`, method: 'tools/list', params: {} };
        const res = hasSendAndReceive(adapter) ? await (adapter as any).sendAndReceive(msg) : await adapter.send(msg);
        this.ctx.addLogEntry('info', 'mcp.local.tools_list', service.id);
        reply.send({ success: true, tools: res?.result?.tools ?? res?.result ?? res, requestId: msg.id });
      } finally {
        await adapter.disconnect();
      }
    } catch (error: any) {
      return this.respondError(reply, 500, error?.message || 'Internal error', { code: 'INTERNAL_ERROR' });
    }
  }

  // Shared handler: call tool
  private async handleToolCall(request: FastifyRequest, reply: FastifyReply) {
    const origin = request.headers.origin as string | undefined;
    const token = this.extractLocalMcpToken(request);
    if (!token) return this.respondError(reply, 401, 'Missing Authorization', { code: 'UNAUTHORIZED', recoverable: true });
    if (!this.validateToken(token, origin)) return this.respondError(reply, 403, 'Forbidden', { code: 'FORBIDDEN', recoverable: true });
    const callSchema = z.object({
      tool: z.string().min(1),
      params: z.record(z.any()).optional(),
      serviceId: z.string().min(1).optional()
    });
    let tool: string, params: any, serviceId: string | undefined;
    try {
      const parsed = callSchema.parse((request.body as any) || {});
      tool = parsed.tool;
      params = parsed.params || {};
      serviceId = parsed.serviceId;
    } catch (e) {
      const err = e as z.ZodError;
      return this.respondError(reply, 400, 'Invalid request body', { code: 'BAD_REQUEST', recoverable: true, meta: err.errors });
    }
    try {
      const service = await this.findTargetService(serviceId);
      if (!service) return this.respondError(reply, 404, 'No suitable service', { code: 'NO_SERVICE', recoverable: true });
      const adapter = await this.ctx.protocolAdapters.createAdapter(service.config);
      await adapter.connect();
      try {
        const msg: any = { jsonrpc: '2.0', id: `call-${Date.now()}`, method: 'tools/call', params: { name: tool, arguments: params || {} } };
        const res = hasSendAndReceive(adapter) ? await (adapter as any).sendAndReceive(msg) : await adapter.send(msg);
        this.ctx.addLogEntry('info', 'mcp.local.call', service.id, { tool });
        reply.send({ success: true, result: res?.result ?? res, requestId: msg.id });
      } finally {
        await adapter.disconnect();
      }
    } catch (error: any) {
      return this.respondError(reply, 500, error?.message || 'Internal error', { code: 'INTERNAL_ERROR' });
    }
  }

  private rotateVerificationCode(): void {
    this.previousVerificationCode = this.currentVerificationCode;
    this.currentVerificationCode = randomBytes(3).toString('hex').toUpperCase();
    this.codeExpiresAt = Date.now() + this.codeRotationMs;
    this.ctx.logger.info('Local MCP verification code rotated', { expiresIn: this.codeRotationMs / 1000 });
  }

  private requireAndValidateOrigin(request: FastifyRequest, reply: FastifyReply): string | null {
    const origin = request.headers.origin as string | undefined;
    if (!origin) {
      this.respondError(reply, 400, 'Missing Origin header', { code: 'BAD_REQUEST', recoverable: true });
      return null;
    }
    // Basic validation: must be http://localhost or http://127.0.0.1
    if (!origin.startsWith('http://localhost') && !origin.startsWith('http://127.0.0.1')) {
      this.respondError(reply, 403, 'Invalid origin', { code: 'FORBIDDEN', recoverable: true });
      return null;
    }
    return origin;
  }

  private extractLocalMcpToken(request: FastifyRequest): string | undefined {
    const auth = request.headers.authorization as string | undefined;
    if (!auth) return undefined;
    const prefix = 'LocalMCP ';
    if (auth.startsWith(prefix)) return auth.substring(prefix.length).trim();
    return undefined;
  }

  private validateToken(token: string, origin?: string): boolean {
    const rec = this.tokenStore.get(token);
    if (!rec) return false;
    if (!origin || rec.origin !== origin) return false;
    if (Date.now() > rec.expiresAt) {
      this.tokenStore.delete(token);
      return false;
    }
    return true;
  }

  private async findTargetService(serviceId?: string | null) {
    if (serviceId) {
      // Return the serviceId to be fetched by caller
      const svc = await this.ctx.serviceRegistry.getService(serviceId);
      return svc;
    }
    // Fallback: find any running service
    const services = await this.ctx.serviceRegistry.listServices();
    const running = services.filter(s => s.state === 'running');
    return running.length ? running[0] : null;
  }

  private checkRateLimit(key: string, maxCount: number, windowMs: number): boolean {
    const now = Date.now();
    const arr = this.rateCounters.get(key) || [];
    const recent = arr.filter(ts => now - ts < windowMs);

    // Immediately cleanup if no recent entries
    if (recent.length === 0) {
      this.rateCounters.delete(key);
      return true; // No recent requests, allow
    }

    recent.push(now);
    this.rateCounters.set(key, recent);
    return recent.length <= maxCount;
  }

  private cleanupRateCounters(): void {
    const now = Date.now();
    const windowMs = 60_000; // current use-case window
    for (const [key, timestamps] of this.rateCounters.entries()) {
      const recent = timestamps.filter(ts => now - ts < windowMs);
      if (recent.length === 0) {
        this.rateCounters.delete(key);
      } else if (recent.length < timestamps.length) {
        this.rateCounters.set(key, recent);
      }
    }
  }

  cleanup(): void {
    if (this.codeRotationTimer) {
      clearInterval(this.codeRotationTimer);
    }
    if (this.rateCleanupTimer) {
      clearInterval(this.rateCleanupTimer);
    }
  }
}

// Helper type guard to safely use optional sendAndReceive when available
function hasSendAndReceive(adapter: any): adapter is { sendAndReceive: (msg: any) => Promise<any> } {
  return adapter && typeof adapter.sendAndReceive === 'function';
}

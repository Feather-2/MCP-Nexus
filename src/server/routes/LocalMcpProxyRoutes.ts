import { FastifyRequest, FastifyReply } from 'fastify';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';
import { randomBytes, createHash, createHmac, pbkdf2Sync, scryptSync, randomUUID } from 'crypto';

/**
 * Local MCP Proxy routes for secure browser-based MCP access
 * Implements handshake-based authentication with verification codes
 */
export class LocalMcpProxyRoutes extends BaseRouteHandler {
  // Verification code rotation
  private currentVerificationCode: string = '';
  private previousVerificationCode: string = '';
  private codeExpiresAt: number = 0;
  private codeRotationMs: number = 60_000; // 60s
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

  constructor(ctx: RouteContext) {
    super(ctx);
    this.rotateVerificationCode();
    this.codeRotationTimer = setInterval(() => this.rotateVerificationCode(), this.codeRotationMs);
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

        const { clientNonce, codeProof } = (request.body as any) || {};
        if (!clientNonce || !codeProof) {
          return reply.code(400).send({ success: false, error: 'Missing clientNonce or codeProof', code: 'BAD_REQUEST' });
        }

        // Rate limit per origin (max 5/minute)
        if (!this.checkRateLimit(`init:${origin}`, 5, 60_000)) {
          this.ctx.addLogEntry('warn', `mcp.local.handshake_init rate_limited for ${origin}`);
          return reply.code(429).send({ success: false, error: 'Rate limited', code: 'RATE_LIMIT' });
        }

        // Validate codeProof against current or previous code
        const expectedCurrent = createHash('sha256').update(`${this.currentVerificationCode}|${origin}|${clientNonce}`).digest('hex');
        const expectedPrev = this.previousVerificationCode
          ? createHash('sha256').update(`${this.previousVerificationCode}|${origin}|${clientNonce}`).digest('hex')
          : '';
        if (codeProof !== expectedCurrent && codeProof !== expectedPrev) {
          this.ctx.addLogEntry('warn', `mcp.local.handshake_init invalid_code origin=${origin}`);
          return reply.code(401).send({ success: false, error: 'Invalid code proof', code: 'INVALID_CODE' });
        }

        const handshakeId = randomUUID();
        const serverNonceBytes = randomBytes(16);
        const serverNonce = serverNonceBytes.toString('base64');
        const kdf: 'pbkdf2' = 'pbkdf2';
        const kdfParams = { iterations: 200_000, hash: 'SHA-256', length: 32 };
        const expiresIn = 60; // seconds

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
        // Error already handled in requireAndValidateOrigin
        if (!reply.sent) reply.code(500).send({ success: false, error: err.message, code: 'INTERNAL_ERROR' });
      }
    });

    // Approve handshake (UI action)
    server.post('/handshake/approve', async (request, reply) => {
      const { handshakeId, approve } = (request.body as any) || {};
      if (!handshakeId) return reply.code(400).send({ success: false, error: 'handshakeId required' });
      const hs = this.handshakeStore.get(handshakeId);
      if (!hs) return reply.code(404).send({ success: false, error: 'Handshake not found' });
      if (Date.now() > hs.expiresAt) return reply.code(409).send({ success: false, error: 'Handshake expired' });
      hs.approved = !!approve;
      this.ctx.addLogEntry('info', `mcp.local.handshake_${approve ? 'approve' : 'reject'}`, undefined, { handshakeId, origin: hs.origin });
      reply.send({ success: true });
    });

    // Confirm handshake
    server.post('/handshake/confirm', async (request, reply) => {
      try {
        const origin = this.requireAndValidateOrigin(request, reply);
        if (!origin) return;
        const { handshakeId, response } = (request.body as any) || {};
        if (!handshakeId || !response) return reply.code(400).send({ success: false, error: 'Missing handshakeId or response', code: 'BAD_REQUEST' });
        const hs = this.handshakeStore.get(handshakeId);
        if (!hs) return reply.code(404).send({ success: false, error: 'Handshake not found', code: 'NOT_FOUND' });
        if (Date.now() > hs.expiresAt) return reply.code(409).send({ success: false, error: 'Handshake expired', code: 'EXPIRED' });
        if (!hs.approved) return reply.code(403).send({ success: false, error: 'Handshake not approved', code: 'NOT_APPROVED' });
        if (hs.origin !== origin) return reply.code(403).send({ success: false, error: 'Origin mismatch', code: 'ORIGIN_MISMATCH' });

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
        if (!ok) return reply.code(401).send({ success: false, error: 'Invalid response', code: 'BAD_RESPONSE' });

        // Issue token
        const token = randomBytes(32).toString('base64');
        const expiresIn = 600; // 10 minutes
        this.tokenStore.set(token, { origin, expiresAt: Date.now() + expiresIn * 1000 });

        // One-time handshake consumption
        this.handshakeStore.delete(handshakeId);
        this.ctx.addLogEntry('info', 'mcp.local.handshake_confirm', undefined, { origin });
        reply.send({ success: true, token, expiresIn });
      } catch (err: any) {
        if (!reply.sent) reply.code(500).send({ success: false, error: err.message, code: 'INTERNAL_ERROR' });
      }
    });

    // List tools (main endpoint)
    server.get('/tools', async (request, reply) => {
      const origin = request.headers.origin as string | undefined;
      const token = this.extractLocalMcpToken(request);
      if (!token) return reply.code(401).send({ success: false, error: 'Missing Authorization', code: 'UNAUTHORIZED' });
      if (!this.validateToken(token, origin)) return reply.code(403).send({ success: false, error: 'Forbidden', code: 'FORBIDDEN' });
      const { serviceId } = (request.query as any) || {};
      try {
        const service = await this.findTargetService(serviceId);
        if (!service) return reply.code(404).send({ success: false, error: 'No suitable service', code: 'NO_SERVICE' });
        const adapter = await this.ctx.protocolAdapters.createAdapter(service.config);
        await adapter.connect();
        try {
          const msg: any = { jsonrpc: '2.0', id: `tools-list-${Date.now()}`, method: 'tools/list', params: {} };
          const res = (adapter as any).sendAndReceive ? await (adapter as any).sendAndReceive(msg) : await adapter.send(msg);
          this.ctx.addLogEntry('info', 'mcp.local.tools_list', service.id);
          reply.send({ success: true, tools: res?.result?.tools ?? res?.result ?? res, requestId: msg.id });
        } finally {
          await adapter.disconnect();
        }
      } catch (error: any) {
        reply.code(500).send({ success: false, error: error.message, code: 'INTERNAL_ERROR' });
      }
    });

    // Compatibility alias for tools listing
    server.get('/local-proxy/tools', async (request, reply) => {
      const origin = request.headers.origin as string | undefined;
      const token = this.extractLocalMcpToken(request);
      if (!token) return reply.code(401).send({ success: false, error: 'Missing Authorization', code: 'UNAUTHORIZED' });
      if (!this.validateToken(token, origin)) return reply.code(403).send({ success: false, error: 'Forbidden', code: 'FORBIDDEN' });
      const { serviceId } = (request.query as any) || {};
      try {
        const service = await this.findTargetService(serviceId);
        if (!service) return reply.code(404).send({ success: false, error: 'No suitable service', code: 'NO_SERVICE' });
        const adapter = await this.ctx.protocolAdapters.createAdapter(service.config);
        await adapter.connect();
        try {
          const msg: any = { jsonrpc: '2.0', id: `tools-list-${Date.now()}`, method: 'tools/list', params: {} };
          const res = (adapter as any).sendAndReceive ? await (adapter as any).sendAndReceive(msg) : await adapter.send(msg);
          this.ctx.addLogEntry('info', 'mcp.local.tools_list', service.id);
          reply.send({ success: true, tools: res?.result?.tools ?? res?.result ?? res, requestId: msg.id });
        } finally { await adapter.disconnect(); }
      } catch (error: any) { reply.code(500).send({ success: false, error: error.message, code: 'INTERNAL_ERROR' }); }
    });

    // Call tool (main endpoint)
    server.post('/call', async (request, reply) => {
      const origin = request.headers.origin as string | undefined;
      const token = this.extractLocalMcpToken(request);
      if (!token) return reply.code(401).send({ success: false, error: 'Missing Authorization', code: 'UNAUTHORIZED' });
      if (!this.validateToken(token, origin)) return reply.code(403).send({ success: false, error: 'Forbidden', code: 'FORBIDDEN' });
      const { tool, params, serviceId } = (request.body as any) || {};
      if (!tool) return reply.code(400).send({ success: false, error: 'tool is required', code: 'BAD_REQUEST' });
      try {
        const service = await this.findTargetService(serviceId);
        if (!service) return reply.code(404).send({ success: false, error: 'No suitable service', code: 'NO_SERVICE' });
        const adapter = await this.ctx.protocolAdapters.createAdapter(service.config);
        await adapter.connect();
        try {
          const msg: any = { jsonrpc: '2.0', id: `call-${Date.now()}`, method: 'tools/call', params: { name: tool, arguments: params || {} } };
          const res = (adapter as any).sendAndReceive ? await (adapter as any).sendAndReceive(msg) : await adapter.send(msg);
          this.ctx.addLogEntry('info', 'mcp.local.call', service.id, { tool });
          reply.send({ success: true, result: res?.result ?? res, requestId: msg.id });
        } finally {
          await adapter.disconnect();
        }
      } catch (error: any) {
        reply.code(500).send({ success: false, error: error.message, code: 'INTERNAL_ERROR' });
      }
    });

    // Compatibility alias for call
    server.post('/local-proxy/call', async (request, reply) => {
      const origin = request.headers.origin as string | undefined;
      const token = this.extractLocalMcpToken(request);
      if (!token) return reply.code(401).send({ success: false, error: 'Missing Authorization', code: 'UNAUTHORIZED' });
      if (!this.validateToken(token, origin)) return reply.code(403).send({ success: false, error: 'Forbidden', code: 'FORBIDDEN' });
      const { tool, params, serviceId } = (request.body as any) || {};
      if (!tool) return reply.code(400).send({ success: false, error: 'tool is required', code: 'BAD_REQUEST' });
      try {
        const service = await this.findTargetService(serviceId);
        if (!service) return reply.code(404).send({ success: false, error: 'No suitable service', code: 'NO_SERVICE' });
        const adapter = await this.ctx.protocolAdapters.createAdapter(service.config);
        await adapter.connect();
        try {
          const msg: any = { jsonrpc: '2.0', id: `call-${Date.now()}`, method: 'tools/call', params: { name: tool, arguments: params || {} } };
          const res = (adapter as any).sendAndReceive ? await (adapter as any).sendAndReceive(msg) : await adapter.send(msg);
          this.ctx.addLogEntry('info', 'mcp.local.call', service.id, { tool });
          reply.send({ success: true, result: res?.result ?? res, requestId: msg.id });
        } finally { await adapter.disconnect(); }
      } catch (error: any) { reply.code(500).send({ success: false, error: error.message, code: 'INTERNAL_ERROR' }); }
    });
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
      reply.code(400).send({ success: false, error: 'Missing Origin header', code: 'BAD_REQUEST' });
      return null;
    }
    // Basic validation: must be http://localhost or http://127.0.0.1
    if (!origin.startsWith('http://localhost') && !origin.startsWith('http://127.0.0.1')) {
      reply.code(403).send({ success: false, error: 'Invalid origin', code: 'FORBIDDEN' });
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
    recent.push(now);
    this.rateCounters.set(key, recent);
    return recent.length <= maxCount;
  }

  cleanup(): void {
    if (this.codeRotationTimer) {
      clearInterval(this.codeRotationTimer);
    }
  }
}

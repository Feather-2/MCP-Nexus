import { FastifyRequest, FastifyReply } from 'fastify';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';
import { randomBytes, createHmac } from 'crypto';

/**
 * Local MCP Proxy routes for browser-based MCP access
 */
export class LocalMcpProxyRoutes extends BaseRouteHandler {
  private verificationCode: string = '';
  private codeExpiresAt: number = 0;
  private rateCounters = new Map<string, number[]>();

  constructor(ctx: RouteContext) {
    super(ctx);
    this.rotateVerificationCode();
  }

  setupRoutes(): void {
    const { server } = this.ctx;

    // Get current verification code
    server.get('/local-proxy/code', async (_req, reply) => {
      const now = Date.now();
      const expiresIn = Math.max(0, Math.floor((this.codeExpiresAt - now) / 1000));
      reply.send({ code: this.verificationCode, expiresIn });
    });

    // Main proxy endpoint
    server.post('/local-proxy', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = this.extractLocalMcpToken(request);
        const origin = request.headers['origin'] as string | undefined;
        
        if (!token || !this.validateToken(token, origin)) {
          return reply.code(403).send({ error: 'Invalid or missing token' });
        }

        if (!this.checkRateLimit(token, 60, 60000)) {
          return reply.code(429).send({ error: 'Rate limit exceeded' });
        }

        const serviceId = await this.findTargetService((request.body as any)?.serviceId);
        if (!serviceId) {
          return reply.code(404).send({ error: 'No service found' });
        }

        const service = await this.ctx.serviceRegistry.getService(serviceId);
        if (!service) {
          return reply.code(404).send({ error: 'Service not found' });
        }

        const adapter = await this.ctx.protocolAdapters.createAdapter(service.config);
        await adapter.connect();

        try {
          const mcpMessage = request.body as any;
          const response = await (adapter as any).sendAndReceive?.(mcpMessage) || await adapter.send(mcpMessage);
          reply.send(response);
        } finally {
          await adapter.disconnect();
        }
      } catch (error) {
        this.ctx.logger.error('Local MCP proxy error', error);
        reply.code(500).send({ error: (error as Error).message });
      }
    });

    // Generate new token
    server.post('/local-proxy/token', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { code } = request.body as { code?: string };
        
        if (code !== this.verificationCode) {
          return reply.code(403).send({ error: 'Invalid verification code' });
        }

        const token = this.generateToken();
        reply.send({ token, expiresIn: 3600 });
      } catch (error) {
        reply.code(500).send({ error: (error as Error).message });
      }
    });
  }

  private rotateVerificationCode(): void {
    this.verificationCode = randomBytes(3).toString('hex').toUpperCase();
    this.codeExpiresAt = Date.now() + 300000; // 5 minutes
    
    setTimeout(() => this.rotateVerificationCode(), 300000);
  }

  private generateToken(): string {
    const payload = JSON.stringify({ iat: Date.now(), exp: Date.now() + 3600000 });
    const signature = createHmac('sha256', this.verificationCode).update(payload).digest('hex');
    return Buffer.from(`${payload}.${signature}`).toString('base64url');
  }

  private extractLocalMcpToken(request: FastifyRequest): string | undefined {
    const auth = request.headers['authorization'];
    if (auth?.startsWith('Bearer ')) return auth.substring(7);
    return (request.headers['x-local-mcp-token'] as string) || undefined;
  }

  private validateToken(token: string, origin?: string): boolean {
    try {
      const decoded = Buffer.from(token, 'base64url').toString();
      const [payload, signature] = decoded.split('.');
      const data = JSON.parse(payload);
      
      if (data.exp < Date.now()) return false;
      
      const expectedSig = createHmac('sha256', this.verificationCode).update(payload).digest('hex');
      return signature === expectedSig;
    } catch {
      return false;
    }
  }

  private async findTargetService(serviceId?: string | null) {
    if (serviceId) return serviceId;
    
    const services = await this.ctx.serviceRegistry.listServices();
    return services.find(s => s.state === 'running')?.id;
  }

  private isLocalHost(hostHeader?: string): boolean {
    return !hostHeader || /^(localhost|127\.0\.0\.1|::1)(:\d+)?$/.test(hostHeader);
  }

  private checkRateLimit(key: string, maxCount: number, windowMs: number): boolean {
    const now = Date.now();
    const arr = this.rateCounters.get(key) || [];
    const recent = arr.filter(ts => now - ts < windowMs);
    recent.push(now);
    this.rateCounters.set(key, recent);
    return recent.length <= maxCount;
  }
}

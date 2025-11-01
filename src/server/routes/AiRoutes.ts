import { FastifyRequest, FastifyReply } from 'fastify';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';

/**
 * AI provider configuration and testing routes
 */
export class AiRoutes extends BaseRouteHandler {
  constructor(ctx: RouteContext) {
    super(ctx);
  }

  setupRoutes(): void {
    const { server } = this.ctx;

    // Get AI configuration
    server.get('/api/ai/config', async (_request: FastifyRequest, reply: FastifyReply) => {
      const config = (this.ctx.configManager.getConfig() as any).ai || {};
      reply.send({ config });
    });

    // Update AI configuration
    server.put('/api/ai/config', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const updates = request.body as any;
        const currentConfig = this.ctx.configManager.getConfig();
        const newConfig = { ...currentConfig, ai: { ...(currentConfig as any).ai, ...updates } };
        await this.ctx.configManager.updateConfig(newConfig);
        reply.send({ success: true, config: newConfig.ai });
      } catch (error) {
        reply.code(500).send({ success: false, error: (error as Error).message });
      }
    });

    // Test AI connection
    server.post('/api/ai/test', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { provider, prompt = 'Hello' } = request.body as { provider?: string; prompt?: string };
        const aiCfg = (this.ctx.configManager.getConfig() as any).ai || {};

        if (!provider) {
          return this.respondError(reply, 400, 'provider is required', { code: 'BAD_REQUEST', recoverable: true });
        }

        const envCheck = this.checkAiEnv(provider);
        if (!envCheck.ok) {
          const missingVars = envCheck.missing.join(', ');
          return reply.send({
            success: false,
            error: `Missing required env vars: ${missingVars}`
          });
        }

        const messages = [{ role: 'user', content: prompt }];
        let response = '';

        switch (provider.toLowerCase()) {
          case 'openai':
            response = await this.callOpenAI(aiCfg, messages);
            break;
          case 'anthropic':
            response = await this.callAnthropic(aiCfg, messages);
            break;
          case 'azure-openai':
            response = await this.callAzureOpenAI(aiCfg, messages);
            break;
          case 'ollama':
            response = await this.callOllama(aiCfg, messages);
            break;
          default:
            return this.respondError(reply, 400, `Unsupported provider: ${provider}`, { code: 'BAD_REQUEST', recoverable: true });
        }

        reply.send({ success: true, response });
      } catch (error) {
        this.ctx.logger.error('AI test failed', error);
        reply.code(500).send({ success: false, error: (error as Error).message });
      }
    });

    // AI orchestration helper
    server.post('/api/ai/orchestrate', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { messages } = request.body as { messages: Array<{ role: string; content: string }> };
        const aiCfg = (this.ctx.configManager.getConfig() as any).ai || {};
        const provider = aiCfg.provider || 'none';

        if (provider === 'none') {
          return reply.send({
            success: false,
            plan: this.buildHeuristicPlan(messages)
          });
        }

        const orchestrationPrompt = this.buildOrchestrationPrompt(messages);
        let plan = '';

        switch (provider.toLowerCase()) {
          case 'openai':
            plan = await this.callOpenAI(aiCfg, [{ role: 'user', content: orchestrationPrompt }]);
            break;
          case 'anthropic':
            plan = await this.callAnthropic(aiCfg, [{ role: 'user', content: orchestrationPrompt }]);
            break;
          default:
            plan = this.buildHeuristicPlan(messages);
        }

        reply.send({ success: true, plan });
      } catch (error) {
        reply.send({ success: false, plan: this.buildHeuristicPlan((request.body as any).messages) });
      }
    });
  }

  private buildHeuristicPlan(messages: Array<{ role: string; content: string }>): string {
    const user = messages.find(m => m.role === 'user')?.content || '';
    return this.buildHeuristicPlanLines(user).join('\n');
  }

  private buildHeuristicPlanLines(user: string): string[] {
    const lower = user.toLowerCase();
    const lines: string[] = [];

    if (lower.includes('list') || lower.includes('show')) {
      lines.push('1. List available services');
    }
    if (lower.includes('create') || lower.includes('start')) {
      lines.push('2. Create new service instance');
    }
    if (lower.includes('stop') || lower.includes('delete')) {
      lines.push('3. Stop service');
    }

    if (lines.length === 0) {
      lines.push('1. Analyze user query');
      lines.push('2. Execute appropriate action');
    }

    return lines;
  }

  private buildOrchestrationPrompt(messages: Array<{ role: string; content: string }>): string {
    const userMsg = messages.find(m => m.role === 'user')?.content || '';
    return `Create a step-by-step plan for: ${userMsg}\nRespond with numbered steps only.`;
  }

  private async callOpenAI(aiCfg: any, messages: any[]): Promise<string> {
    const endpoint = aiCfg.endpoint || 'https://api.openai.com/v1/chat/completions';
    const apiKey = process.env.OPENAI_API_KEY || aiCfg.apiKey;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: aiCfg.model || 'gpt-3.5-turbo',
        messages,
        max_tokens: 500
      })
    });

    const data = await response.json() as any;
    return data.choices?.[0]?.message?.content || 'No response';
  }

  private async callAnthropic(aiCfg: any, messages: any[]): Promise<string> {
    const endpoint = aiCfg.endpoint || 'https://api.anthropic.com/v1/messages';
    const apiKey = process.env.ANTHROPIC_API_KEY || aiCfg.apiKey;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: aiCfg.model || 'claude-3-haiku-20240307',
        messages,
        max_tokens: 500
      })
    });

    const data = await response.json() as any;
    return data.content?.[0]?.text || 'No response';
  }

  private async callAzureOpenAI(aiCfg: any, messages: any[]): Promise<string> {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT || aiCfg.endpoint;
    const apiKey = process.env.AZURE_OPENAI_API_KEY || aiCfg.apiKey;
    const deploymentUrl = `${endpoint}/openai/deployments/${aiCfg.model}/chat/completions?api-version=2023-05-15`;

    const response = await fetch(deploymentUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey
      },
      body: JSON.stringify({ messages, max_tokens: 500 })
    });

    const data = await response.json() as any;
    return data.choices?.[0]?.message?.content || 'No response';
  }

  private async callOllama(aiCfg: any, messages: any[]): Promise<string> {
    const endpoint = aiCfg.endpoint || 'http://localhost:11434/api/chat';

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: aiCfg.model || 'llama2',
        messages,
        stream: false
      })
    });

    const data = await response.json() as any;
    return data.message?.content || 'No response';
  }

  private checkAiEnv(provider: string): { ok: boolean; required: string[]; missing: string[] } {
    const requirements: Record<string, string[]> = {
      'openai': ['OPENAI_API_KEY'],
      'anthropic': ['ANTHROPIC_API_KEY'],
      'azure-openai': ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT'],
      'ollama': []
    };

    const required = requirements[provider.toLowerCase()] || [];
    const missing = required.filter(key => !process.env[key]);

    return {
      ok: missing.length === 0,
      required,
      missing
    };
  }
}

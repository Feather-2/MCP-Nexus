import { FastifyRequest, FastifyReply } from 'fastify';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';

/**
 * AI provider configuration, testing, and chat routes
 * Includes both streaming and non-streaming AI interactions
 */
export class AiRoutes extends BaseRouteHandler {
  constructor(ctx: RouteContext) {
    super(ctx);
  }

  setupRoutes(): void {
    const { server } = this.ctx;

    // Get current AI config (non-secret)
    server.get('/api/ai/config', async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const cfg = await this.ctx.configManager.get('ai');
        reply.send({ config: cfg || { provider: 'none' } });
      } catch (error) {
        reply.code(500).send({ error: (error as Error).message });
      }
    });

    // Update AI config (non-secret). Secrets must be provided via environment variables
    server.put('/api/ai/config', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = (request.body as any) || {};
        const allowed: any = {};
        if (typeof body.provider === 'string') allowed.provider = body.provider;
        if (typeof body.model === 'string') allowed.model = body.model;
        if (typeof body.endpoint === 'string') allowed.endpoint = body.endpoint;
        if (typeof body.timeoutMs === 'number') allowed.timeoutMs = body.timeoutMs;
        if (typeof body.streaming === 'boolean') allowed.streaming = body.streaming;

        const updated = await this.ctx.configManager.updateConfig({ ai: { ...(await this.ctx.configManager.get('ai')), ...allowed } as any });
        reply.send({ success: true, config: (updated as any).ai });
      } catch (error) {
        reply.code(500).send({ success: false, error: (error as Error).message });
      }
    });

    // Test AI connectivity/settings without persisting secrets
    server.post('/api/ai/test', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = (request.body as any) || {};
        const provider = String(body.provider || (await this.ctx.configManager.get<any>('ai'))?.provider || 'none');
        const endpoint = String(body.endpoint || (await this.ctx.configManager.get<any>('ai'))?.endpoint || '');
        const model = String(body.model || (await this.ctx.configManager.get<any>('ai'))?.model || '');
        const mode = (body.mode as string) || 'env-only';

        const envStatus = this.checkAiEnv(provider);

        // By default do not attempt outbound network calls; allow explicit opt-in via mode='ping'
        let pingResult: { ok: boolean; note?: string } | undefined;
        if (mode === 'ping') {
          try {
            // Minimal safe probe: only for local providers (ollama) or when endpoint is localhost
            const isLocal = endpoint.includes('127.0.0.1') || endpoint.includes('localhost') || provider === 'ollama';
            if (!isLocal) {
              pingResult = { ok: false, note: 'Skipping non-local endpoint probe in sandbox' };
            } else {
              const fetch = (await import('node-fetch')).default as any;
              const url = provider === 'ollama' ? (endpoint || 'http://127.0.0.1:11434') + '/api/tags' : endpoint;
              const res = await fetch(url, { method: 'GET' });
              pingResult = { ok: res.ok, note: `HTTP ${res.status}` };
            }
          } catch (e: any) {
            pingResult = { ok: false, note: e?.message || 'probe failed' };
          }
        }

        reply.send({
          success: envStatus.ok && (pingResult ? pingResult.ok : true),
          provider,
          model,
          endpoint,
          env: envStatus,
          ping: pingResult
        });
      } catch (error) {
        reply.code(500).send({ success: false, error: (error as Error).message });
      }
    });

    // Simple chat endpoint (non-streaming). If provider/env not configured, returns a heuristic assistant reply.
    server.post('/api/ai/chat', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = (request.body as any) || {};
        const messages: Array<{ role: string; content: string }> = Array.isArray(body.messages) ? body.messages : [];
        const ai = (await this.ctx.configManager.get<any>('ai')) || {};
        const provider = String(ai.provider || 'none');

        // If provider configured and env is present, attempt real call
        const envCheck = this.checkAiEnv(provider);
        if (provider !== 'none' && envCheck.ok) {
          const result = await this.nonStreamingAiCall(provider, ai, messages);
          reply.send({ success: true, message: { role: 'assistant', content: result }, provider });
          return;
        }

        // Fallback: heuristic plan builder
        const assistant = this.buildHeuristicPlan(messages);
        reply.send({ success: true, message: { role: 'assistant', content: assistant }, provider });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error).message || 'AI chat error', { code: 'AI_ERROR' });
      }
    });

    // Streaming chat (SSE): GET /api/ai/chat/stream?q=...
    server.get('/api/ai/chat/stream', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { q } = (request.query as any) || {};
        const user = String(q || '');
        const ai = (await this.ctx.configManager.get<any>('ai')) || {};
        const provider = String(ai.provider || 'none');

        // Prepare SSE response headers with strict CORS reflection (no wildcard)
        this.writeSseHeaders(reply, request);

        const send = (obj: any) => {
          try { reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
        };
        send({ event: 'start' });

        // If provider configured and env ok, attempt real streaming call
        const envCheck = this.checkAiEnv(provider);
        if (provider !== 'none' && envCheck.ok) {
          try {
            await this.streamingAiCall(provider, ai, user, (delta) => send({ event: 'delta', delta }), () => {
              send({ event: 'done' });
              try { reply.raw.end(); } catch {}
            });
            return;
          } catch (e: any) {
            send({ event: 'error', error: e?.message || 'stream failed' });
            try { reply.raw.end(); } catch {}
            return;
          }
        }

        // Fallback: heuristic stream
        const lines = this.buildHeuristicPlanLines(user);
        let idx = 0;
        const timer = setInterval(() => {
          if (idx < lines.length) {
            send({ event: 'delta', delta: (idx ? '\n' : '') + lines[idx] });
            idx++;
          } else {
            clearInterval(timer);
            send({ event: 'done' });
            try { reply.raw.end(); } catch {}
          }
        }, 120);
      } catch (error) {
        try {
          reply.raw.write(`data: ${JSON.stringify({ event: 'error', error: (error as Error).message })}\n\n`);
        } catch {}
        try { reply.raw.end(); } catch {}
      }
    });
  }

  private writeSseHeaders(reply: FastifyReply, request: FastifyRequest): void {
    const origin = request.headers['origin'] as string | undefined;
    const config = (this.ctx.configManager as any).config || {};
    const allowed = Array.isArray(config.corsOrigins) ? config.corsOrigins : [];
    const isAllowed = origin && allowed.includes(origin);
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...(isAllowed ? { 'Access-Control-Allow-Origin': origin!, 'Vary': 'Origin' } : {})
    });
  }

  private buildHeuristicPlan(messages: Array<{ role: string; content: string }>): string {
    const last = messages.length ? messages[messages.length - 1] : undefined;
    const userContent = last?.role === 'user' ? String(last.content || '') : '';
    const lines = this.buildHeuristicPlanLines(userContent);
    return lines.join('\n');
  }

  private buildHeuristicPlanLines(user: string): string[] {
    const urlMatch = user.match(/https?:\/\/[^\s)]+/i);
    const url = urlMatch ? urlMatch[0] : 'https://api.example.com/v1/echo';
    const method = /\b(post|put|patch|delete|get)\b/i.exec(user)?.[0]?.toUpperCase?.() || 'GET';
    const needApiKey = /api[-_ ]?key|token/i.test(user);
    return [
      `已理解你的需求。建议基于以下接口生成 MCP 模板：`,
      '',
      `# Service Plan`,
      `Base URL: ${new URL(url).origin}`,
      '',
      `Endpoint: ${method} ${new URL(url).pathname}`,
      needApiKey ? `Auth: API Key header: X-API-Key` : `Auth: none`,
      `Parameters:`,
      `- q: string (optional)`
    ];
  }

  private async nonStreamingAiCall(provider: string, aiCfg: any, messages: Array<{ role: string; content: string }>): Promise<string> {
    switch (provider) {
      case 'openai':
        return await this.callOpenAI(aiCfg, messages);
      case 'anthropic':
        return await this.callAnthropic(aiCfg, messages);
      case 'azure-openai':
        return await this.callAzureOpenAI(aiCfg, messages);
      case 'ollama':
        return await this.callOllama(aiCfg, messages);
      default:
        return this.buildHeuristicPlan(messages);
    }
  }

  private async streamingAiCall(provider: string, aiCfg: any, prompt: string, onDelta: (t: string) => void, onDone: () => void): Promise<void> {
    switch (provider) {
      case 'openai':
        await this.streamOpenAI(aiCfg, prompt, onDelta, onDone);
        return;
      case 'azure-openai':
        await this.streamAzureOpenAI(aiCfg, prompt, onDelta, onDone);
        return;
      case 'anthropic':
        await this.streamAnthropic(aiCfg, prompt, onDelta, onDone);
        return;
      case 'ollama':
        await this.streamOllama(aiCfg, prompt, onDelta, onDone);
        return;
      // Anthropic streaming can be added similarly; fallback to non-stream call
      default: {
        const text = await this.nonStreamingAiCall(provider, aiCfg, [{ role: 'user', content: prompt }]);
        onDelta(text);
        onDone();
      }
    }
  }

  // ===== Provider calls (best-effort; rely on env, network may be restricted) =====
  private async callOpenAI(aiCfg: any, messages: any[]): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY as string;
    const model = aiCfg.model || 'gpt-4o-mini';
    const endpoint = aiCfg.endpoint || 'https://api.openai.com/v1/chat/completions';
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model, messages, stream: false })
    });
    const json = await resp.json();
    return json?.choices?.[0]?.message?.content || '';
  }

  private async streamOpenAI(aiCfg: any, prompt: string, onDelta: (t: string) => void, onDone: () => void): Promise<void> {
    const apiKey = process.env.OPENAI_API_KEY as string;
    const model = aiCfg.model || 'gpt-4o-mini';
    const endpoint = aiCfg.endpoint || 'https://api.openai.com/v1/chat/completions';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: true })
    } as any);
    const reader = (res as any).body?.getReader?.();
    if (!reader) { onDone(); return; }
    const decoder = new TextDecoder();
    let done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      done = d;
      if (value) {
        const chunk = decoder.decode(value, { stream: true });
        // OpenAI SSE: lines starting with data:
        const lines = chunk.split(/\n/).map(s => s.trim()).filter(Boolean);
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const obj = JSON.parse(payload);
            const delta = obj?.choices?.[0]?.delta?.content;
            if (typeof delta === 'string') onDelta(delta);
          } catch {}
        }
      }
    }
    onDone();
  }

  private async callAnthropic(aiCfg: any, messages: any[]): Promise<string> {
    const apiKey = process.env.ANTHROPIC_API_KEY as string;
    const model = aiCfg.model || 'claude-3-haiku-20240307';
    const endpoint = aiCfg.endpoint || 'https://api.anthropic.com/v1/messages';
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model, max_tokens: 1024, messages })
    } as any);
    const json = await resp.json();
    // Extract text content blocks
    const parts = (json?.content || []).map((b: any) => b?.text).filter(Boolean);
    return parts.join('');
  }

  private async callAzureOpenAI(aiCfg: any, messages: any[]): Promise<string> {
    const apiKey = process.env.AZURE_OPENAI_API_KEY as string;
    const base = process.env.AZURE_OPENAI_ENDPOINT as string; // like https://res.openai.azure.com
    const deployment = aiCfg.model || 'gpt-4o-mini';
    const apiVersion = '2024-08-01-preview';
    const endpoint = `${base.replace(/\/$/, '')}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({ messages, stream: false })
    } as any);
    const json = await resp.json();
    return json?.choices?.[0]?.message?.content || '';
  }

  private async streamAzureOpenAI(aiCfg: any, prompt: string, onDelta: (t: string) => void, onDone: () => void): Promise<void> {
    const apiKey = process.env.AZURE_OPENAI_API_KEY as string;
    const base = process.env.AZURE_OPENAI_ENDPOINT as string;
    const deployment = aiCfg.model || 'gpt-4o-mini';
    const apiVersion = '2024-08-01-preview';
    const endpoint = `${base.replace(/\/$/, '')}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: prompt }] })
    } as any);
    const reader = (res as any).body?.getReader?.();
    if (!reader) { onDone(); return; }
    const decoder = new TextDecoder();
    let done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      done = d;
      if (value) {
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split(/\n/).map(s => s.trim()).filter(Boolean);
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const obj = JSON.parse(payload);
            const delta = obj?.choices?.[0]?.delta?.content;
            if (typeof delta === 'string') onDelta(delta);
          } catch {}
        }
      }
    }
    onDone();
  }

  private async streamAnthropic(aiCfg: any, prompt: string, onDelta: (t: string) => void, onDone: () => void): Promise<void> {
    const apiKey = process.env.ANTHROPIC_API_KEY as string;
    const model = aiCfg.model || 'claude-3-haiku-20240307';
    const endpoint = aiCfg.endpoint || 'https://api.anthropic.com/v1/messages';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model, max_tokens: 1024, stream: true, messages: [{ role: 'user', content: prompt }] })
    } as any);
    const reader = (res as any).body?.getReader?.();
    if (!reader) { onDone(); return; }
    const decoder = new TextDecoder();
    let done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      done = d;
      if (value) {
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split(/\n/).map(s => s.trim()).filter(Boolean);
        for (const line of lines) {
          if (!line.startsWith('event:') && !line.startsWith('data:')) continue;
          if (line.startsWith('data:')) {
            const payload = line.slice(5).trim();
            try {
              const obj = JSON.parse(payload);
              // Anthropic streaming delta
              if (obj?.type === 'content_block_delta' && obj?.delta?.type === 'text_delta') {
                const delta = obj.delta?.text;
                if (typeof delta === 'string') onDelta(delta);
              }
            } catch {}
          }
        }
      }
    }
    onDone();
  }

  private async callOllama(aiCfg: any, messages: any[]): Promise<string> {
    const model = aiCfg.model || 'llama3.1:8b';
    const base = aiCfg.endpoint || 'http://127.0.0.1:11434';
    const endpoint = `${base.replace(/\/$/, '')}/api/chat`;
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false })
    } as any);
    const json = await resp.json();
    return json?.message?.content || '';
  }

  private async streamOllama(aiCfg: any, prompt: string, onDelta: (t: string) => void, onDone: () => void): Promise<void> {
    const model = aiCfg.model || 'llama3.1:8b';
    const base = aiCfg.endpoint || 'http://127.0.0.1:11434';
    const endpoint = `${base.replace(/\/$/, '')}/api/chat`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: true })
    } as any);
    const reader = (res as any).body?.getReader?.();
    if (!reader) { onDone(); return; }
    const decoder = new TextDecoder();
    let done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      done = d;
      if (value) {
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split(/\n/).map(s => s.trim()).filter(Boolean);
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            const delta = obj?.message?.content;
            if (typeof delta === 'string') onDelta(delta);
          } catch {}
        }
      }
    }
    onDone();
  }

  private checkAiEnv(provider: string): { ok: boolean; required: string[]; missing: string[] } {
    const req: string[] = [];
    switch (provider) {
      case 'openai':
        req.push('OPENAI_API_KEY');
        break;
      case 'anthropic':
        req.push('ANTHROPIC_API_KEY');
        break;
      case 'azure-openai':
        req.push('AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT');
        break;
      case 'ollama':
        // local runtime; no key required
        break;
      default:
        break;
    }
    const missing = req.filter(k => !process.env[k]);
    return { ok: missing.length === 0, required: req, missing };
  }
}

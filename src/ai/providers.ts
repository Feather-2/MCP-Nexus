/**
 * AI Provider call implementations
 * Extracted from AiRoutes for better separation of concerns
 */

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiProviderConfig {
  model?: string;
  endpoint?: string;
}

export type StreamDeltaCallback = (delta: string) => void;
export type StreamDoneCallback = () => void;

/**
 * Check required environment variables for a provider
 */
export function checkAiEnv(provider: string): { ok: boolean; required: string[]; missing: string[] } {
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

// ===== OpenAI =====
export async function callOpenAI(cfg: AiProviderConfig, messages: AiMessage[]): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY as string;
  const model = cfg.model || 'gpt-4o-mini';
  const endpoint = cfg.endpoint || 'https://api.openai.com/v1/chat/completions';
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({ model, messages, stream: false })
  });
  const json = await resp.json() as any;
  return json?.choices?.[0]?.message?.content || '';
}

export async function streamOpenAI(
  cfg: AiProviderConfig,
  prompt: string,
  onDelta: StreamDeltaCallback,
  onDone: StreamDoneCallback
): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY as string;
  const model = cfg.model || 'gpt-4o-mini';
  const endpoint = cfg.endpoint || 'https://api.openai.com/v1/chat/completions';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: true })
  });
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
        } catch { /* ignored */ }
      }
    }
  }
  onDone();
}

// ===== Anthropic =====
export async function callAnthropic(cfg: AiProviderConfig, messages: AiMessage[]): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY as string;
  const model = cfg.model || 'claude-3-haiku-20240307';
  const endpoint = cfg.endpoint || 'https://api.anthropic.com/v1/messages';
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model, max_tokens: 1024, messages })
  });
  const json = await resp.json() as any;
  const parts = (json?.content || []).map((b: any) => b?.text).filter(Boolean);
  return parts.join('');
}

export async function streamAnthropic(
  cfg: AiProviderConfig,
  prompt: string,
  onDelta: StreamDeltaCallback,
  onDone: StreamDoneCallback
): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY as string;
  const model = cfg.model || 'claude-3-haiku-20240307';
  const endpoint = cfg.endpoint || 'https://api.anthropic.com/v1/messages';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model, max_tokens: 1024, stream: true, messages: [{ role: 'user', content: prompt }] })
  });
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
            if (obj?.type === 'content_block_delta' && obj?.delta?.type === 'text_delta') {
              const delta = obj.delta?.text;
              if (typeof delta === 'string') onDelta(delta);
            }
          } catch { /* ignored */ }
        }
      }
    }
  }
  onDone();
}

// ===== Azure OpenAI =====
export async function callAzureOpenAI(cfg: AiProviderConfig, messages: AiMessage[]): Promise<string> {
  const apiKey = process.env.AZURE_OPENAI_API_KEY as string;
  const base = process.env.AZURE_OPENAI_ENDPOINT as string;
  const deployment = cfg.model || 'gpt-4o-mini';
  const apiVersion = '2024-08-01-preview';
  const endpoint = `${base.replace(/\/$/, '')}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify({ messages, stream: false })
  });
  const json = await resp.json() as any;
  return json?.choices?.[0]?.message?.content || '';
}

export async function streamAzureOpenAI(
  cfg: AiProviderConfig,
  prompt: string,
  onDelta: StreamDeltaCallback,
  onDone: StreamDoneCallback
): Promise<void> {
  const apiKey = process.env.AZURE_OPENAI_API_KEY as string;
  const base = process.env.AZURE_OPENAI_ENDPOINT as string;
  const deployment = cfg.model || 'gpt-4o-mini';
  const apiVersion = '2024-08-01-preview';
  const endpoint = `${base.replace(/\/$/, '')}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: prompt }] })
  });
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
        } catch { /* ignored */ }
      }
    }
  }
  onDone();
}

// ===== Ollama =====
export async function callOllama(cfg: AiProviderConfig, messages: AiMessage[]): Promise<string> {
  const model = cfg.model || 'llama3.1:8b';
  const base = cfg.endpoint || 'http://127.0.0.1:11434';
  const endpoint = `${base.replace(/\/$/, '')}/api/chat`;
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false })
  });
  const json = await resp.json() as any;
  return json?.message?.content || '';
}

export async function streamOllama(
  cfg: AiProviderConfig,
  prompt: string,
  onDelta: StreamDeltaCallback,
  onDone: StreamDoneCallback
): Promise<void> {
  const model = cfg.model || 'llama3.1:8b';
  const base = cfg.endpoint || 'http://127.0.0.1:11434';
  const endpoint = `${base.replace(/\/$/, '')}/api/chat`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: true })
  });
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
        } catch { /* ignored */ }
      }
    }
  }
  onDone();
}

// ===== Unified caller =====
export async function callProvider(
  provider: string,
  cfg: AiProviderConfig,
  messages: AiMessage[]
): Promise<string> {
  switch (provider) {
    case 'openai':
      return callOpenAI(cfg, messages);
    case 'anthropic':
      return callAnthropic(cfg, messages);
    case 'azure-openai':
      return callAzureOpenAI(cfg, messages);
    case 'ollama':
      return callOllama(cfg, messages);
    default:
      return '';
  }
}

export async function streamProvider(
  provider: string,
  cfg: AiProviderConfig,
  prompt: string,
  onDelta: StreamDeltaCallback,
  onDone: StreamDoneCallback
): Promise<void> {
  switch (provider) {
    case 'openai':
      return streamOpenAI(cfg, prompt, onDelta, onDone);
    case 'anthropic':
      return streamAnthropic(cfg, prompt, onDelta, onDone);
    case 'azure-openai':
      return streamAzureOpenAI(cfg, prompt, onDelta, onDone);
    case 'ollama':
      return streamOllama(cfg, prompt, onDelta, onDone);
    default:
      onDone();
  }
}

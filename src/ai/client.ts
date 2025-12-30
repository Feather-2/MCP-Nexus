import { generateText, streamText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createMistral } from '@ai-sdk/mistral';
import { createGroq } from '@ai-sdk/groq';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOllama } from 'ollama-ai-provider';

import { ChannelManager } from './channel.js';
import { CostTracker } from './cost-tracker.js';
import { SlidingWindowRateLimiter } from './rate-limiter.js';
import { AiError, type AiMessage, type AiRequest, type AiResult, type AiToolCall, type AiUsage, type ChannelConfig, type ChannelLease } from './types.js';

import type { AssistantContent, ModelMessage, FinishReason, LanguageModel, LanguageModelUsage, ToolContent, UserContent } from 'ai';
import type { LanguageModelV2ToolResultOutput } from '@ai-sdk/provider';

export interface LoadBalancer {
  pickChannelId?(request: AiRequest, requestedChannelId?: string): string | undefined;
}

export interface AiStreamChunk {
  type: 'text' | 'tool_call' | 'finish' | 'error';
  text?: string;
  toolCall?: AiToolCall;
  finishReason?: string;
  usage?: AiUsage;
  error?: AiError;
}

type ClientOptions = Readonly<{
  rateLimiter?: SlidingWindowRateLimiter;
  costTracker?: CostTracker;
  loadBalancer?: LoadBalancer;
  retryAttempts?: number;
  retryDelayMs?: number;
}>;

type ChannelManagerView = {
  channels?: Map<string, { config: ChannelConfig }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined;
  if (!Number.isFinite(value)) return undefined;
  return value;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function ensureRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value) && !Array.isArray(value)) return value;
  return { value };
}

function mapFinishReason(reason: FinishReason): AiResult['finishReason'] {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool-calls':
      return 'tool_calls';
    case 'error':
      return 'error';
    default:
      return 'stop';
  }
}

function normalizeUsage(usage: LanguageModelUsage | undefined): AiUsage {
  const promptTokens = usage?.inputTokens ?? 0;
  const completionTokens = usage?.outputTokens ?? 0;
  const totalTokens = usage?.totalTokens ?? promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

function parseRetryAfterMsFromHeaders(headers: unknown): number | undefined {
  if (!isRecord(headers)) return undefined;
  const raw = asString(headers['retry-after']) ?? asString(headers['Retry-After']);
  if (!raw) return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.floor(seconds * 1000));

  const date = Date.parse(raw);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function extractStatusCode(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;

  const direct = asNumber(error.statusCode) ?? asNumber(error.status);
  if (direct !== undefined) return direct;

  const response = error.response;
  if (isRecord(response)) {
    const status = asNumber(response.status) ?? asNumber(response.statusCode);
    if (status !== undefined) return status;
  }

  return undefined;
}

function extractRetryAfterMs(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  const direct = asNumber(error.retryAfterMs);
  if (direct !== undefined) return direct;

  const headers = error.headers;
  const fromHeaders = parseRetryAfterMsFromHeaders(headers);
  if (fromHeaders !== undefined) return fromHeaders;

  const response = error.response;
  if (isRecord(response)) {
    return parseRetryAfterMsFromHeaders(response.headers);
  }

  return undefined;
}

function isTimeoutLike(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
    const msg = error.message.toLowerCase();
    if (msg.includes('timeout') || msg.includes('timed out')) return true;
  }

  if (isRecord(error)) {
    const code = asString(error.code);
    if (code === 'ETIMEDOUT') return true;
  }

  return false;
}

function isNetworkLike(error: unknown): boolean {
  if (error instanceof TypeError) {
    const msg = error.message.toLowerCase();
    if (msg.includes('fetch') || msg.includes('network')) return true;
  }

  if (isRecord(error)) {
    const code = asString(error.code);
    if (
      code === 'ENOTFOUND' ||
      code === 'ECONNRESET' ||
      code === 'ECONNREFUSED' ||
      code === 'EAI_AGAIN' ||
      code === 'ENETUNREACH'
    ) {
      return true;
    }
  }

  return false;
}

export class UnifiedAiClient {
  constructor(
    private channelManager: ChannelManager,
    private options?: ClientOptions
  ) {}

  async generate(request: AiRequest, channelId?: string): Promise<AiResult> {
    const retryAttempts = Math.max(0, this.options?.retryAttempts ?? 0);
    const retryDelayMs = Math.max(0, this.options?.retryDelayMs ?? 0);

    let lastError: AiError | undefined;
    for (let attempt = 1; attempt <= retryAttempts + 1; attempt += 1) {
      const effectiveChannelId = this.options?.loadBalancer?.pickChannelId?.(request, channelId) ?? channelId;
      const lease = this.channelManager.acquire(effectiveChannelId);

      const startedAt = Date.now();
      const abortController = new AbortController();
      const timeoutId = this.setupTimeout(abortController, lease);

      try {
        this.enforceRateLimitOrThrow(lease, request);

        const effectiveModelId = request.model ?? lease.model;
        const effectiveLease = effectiveModelId === lease.model ? lease : { ...lease, model: effectiveModelId };

        const model = this.getProviderModel(effectiveLease);
        const messages = this.convertMessages(request.messages);

        const result = await generateText({
          model,
          messages,
          temperature: request.temperature,
          maxOutputTokens: request.maxTokens,
          headers: lease.headers,
          abortSignal: abortController.signal,
        });

        const latencyMs = Math.max(0, Date.now() - startedAt);
        const usage = normalizeUsage(result.usage);

        this.channelManager.report(lease, { success: true, latencyMs, tokens: usage.totalTokens });
        this.options?.costTracker?.record(effectiveModelId, usage);

        const toolCalls = result.toolCalls?.map((tc) => ({
          id: tc.toolCallId,
          name: tc.toolName,
          arguments: ensureRecord(tc.input),
        }));

        return {
          text: result.text,
          toolCalls,
          usage,
          finishReason: mapFinishReason(result.finishReason),
          latencyMs,
          channelId: lease.channelId,
          keyIndex: lease.keyIndex,
        };
      } catch (error) {
        const classified = this.classifyError(error);
        lastError = classified;

        const latencyMs = Math.max(0, Date.now() - startedAt);
        this.channelManager.report(lease, { success: false, latencyMs, error: classified });

        if (classified.type === 'auth') {
          this.channelManager.disableKey(lease.channelId, lease.keyIndex, classified.message);
        }

        const shouldRetry = classified.retryable && attempt <= retryAttempts;
        if (!shouldRetry) throw classified;

        const waitMs = classified.retryAfterMs ?? retryDelayMs;
        if (waitMs > 0) await UnifiedAiClient.sleep(waitMs);
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    }

    throw lastError ?? new AiError('Unknown error', 'unknown');
  }

  stream(request: AiRequest, channelId?: string): AsyncIterable<AiStreamChunk> {
    return this.streamInternal(request, channelId);
  }

  private async *streamInternal(request: AiRequest, channelId?: string): AsyncIterable<AiStreamChunk> {
    const retryAttempts = Math.max(0, this.options?.retryAttempts ?? 0);
    const retryDelayMs = Math.max(0, this.options?.retryDelayMs ?? 0);

    let lastError: AiError | undefined;
    for (let attempt = 1; attempt <= retryAttempts + 1; attempt += 1) {
      const effectiveChannelId = this.options?.loadBalancer?.pickChannelId?.(request, channelId) ?? channelId;
      const lease = this.channelManager.acquire(effectiveChannelId);

      const startedAt = Date.now();
      const abortController = new AbortController();
      const timeoutId = this.setupTimeout(abortController, lease);

      let emittedAny = false;
      try {
        this.enforceRateLimitOrThrow(lease, request);

        const effectiveModelId = request.model ?? lease.model;
        const effectiveLease = effectiveModelId === lease.model ? lease : { ...lease, model: effectiveModelId };

        const model = this.getProviderModel(effectiveLease);
        const messages = this.convertMessages(request.messages);

        const result = streamText({
          model,
          messages,
          temperature: request.temperature,
          maxOutputTokens: request.maxTokens,
          headers: lease.headers,
          abortSignal: abortController.signal,
        });

        for await (const part of result.fullStream) {
          emittedAny = true;
          if (!isRecord(part) || typeof part.type !== 'string') continue;

          if (part.type === 'text-delta') {
            const text = asString(part.text) ?? '';
            if (text.length > 0) yield { type: 'text', text };
            continue;
          }

          if (part.type === 'tool-call') {
            const toolCallId = asString(part.toolCallId) ?? '';
            const toolName = asString(part.toolName) ?? '';
            yield {
              type: 'tool_call',
              toolCall: { id: toolCallId, name: toolName, arguments: ensureRecord(part.input) },
            };
            continue;
          }

          if (part.type === 'finish') {
            const usage = normalizeUsage(part.totalUsage as LanguageModelUsage | undefined);
            const finishReason = mapFinishReason(part.finishReason as FinishReason);

            const latencyMs = Math.max(0, Date.now() - startedAt);
            this.channelManager.report(lease, { success: true, latencyMs, tokens: usage.totalTokens });
            this.options?.costTracker?.record(effectiveModelId, usage);

            yield { type: 'finish', finishReason, usage };
            return;
          }
        }

        const usage = normalizeUsage(await result.totalUsage);
        const finishReason = mapFinishReason(await result.finishReason);

        const latencyMs = Math.max(0, Date.now() - startedAt);
        this.channelManager.report(lease, { success: true, latencyMs, tokens: usage.totalTokens });
        this.options?.costTracker?.record(effectiveModelId, usage);

        yield { type: 'finish', finishReason, usage };
        return;
      } catch (error) {
        const classified = this.classifyError(error);
        lastError = classified;

        const latencyMs = Math.max(0, Date.now() - startedAt);
        this.channelManager.report(lease, { success: false, latencyMs, error: classified });

        if (classified.type === 'auth') {
          this.channelManager.disableKey(lease.channelId, lease.keyIndex, classified.message);
        }

        const shouldRetry = classified.retryable && !emittedAny && attempt <= retryAttempts;
        if (!shouldRetry) {
          yield { type: 'error', error: classified };
          return;
        }

        const waitMs = classified.retryAfterMs ?? retryDelayMs;
        if (waitMs > 0) await UnifiedAiClient.sleep(waitMs);
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    }

    yield { type: 'error', error: lastError ?? new AiError('Unknown error', 'unknown') };
  }

  private getProviderModel(lease: ChannelLease): LanguageModel {
    const modelId = lease.model;

    switch (lease.provider) {
      case 'anthropic': {
        const provider = createAnthropic({ apiKey: lease.apiKey, headers: lease.headers, baseURL: lease.baseUrl });
        return provider(modelId);
      }
      case 'openai': {
        const provider = createOpenAI({ apiKey: lease.apiKey, headers: lease.headers, baseURL: lease.baseUrl });
        return provider(modelId);
      }
      case 'google': {
        const provider = createGoogleGenerativeAI({ apiKey: lease.apiKey, headers: lease.headers, baseURL: lease.baseUrl });
        return provider(modelId);
      }
      case 'mistral': {
        const provider = createMistral({ apiKey: lease.apiKey, headers: lease.headers, baseURL: lease.baseUrl });
        return provider(modelId);
      }
      case 'groq': {
        const provider = createGroq({ apiKey: lease.apiKey, headers: lease.headers, baseURL: lease.baseUrl });
        return provider(modelId);
      }
      case 'deepseek': {
        const provider = createDeepSeek({ apiKey: lease.apiKey, headers: lease.headers, baseURL: lease.baseUrl });
        return provider(modelId);
      }
      case 'ollama': {
        const provider = createOllama({ baseURL: lease.baseUrl, headers: lease.headers });
        return provider(modelId) as unknown as LanguageModel;
      }
      default: {
        // Providers like 'azure'/'bedrock' are not implemented yet.
        return createOpenAI({ apiKey: lease.apiKey, headers: lease.headers, baseURL: lease.baseUrl })(modelId);
      }
    }
  }

  private convertMessages(messages: AiMessage[]): ModelMessage[] {
    return messages.map((m) => {
      if (m.role === 'system') {
        return { role: 'system', content: typeof m.content === 'string' ? m.content : this.stringifyContent(m.content) };
      }

      if (m.role === 'user') {
        return { role: 'user', content: this.convertUserContent(m.content) };
      }

      if (m.role === 'assistant') {
        const content = this.convertAssistantContent(m);
        return { role: 'assistant', content };
      }

      // tool
      const toolCallId = m.toolCallId ?? 'tool-call';
      const toolResultText = typeof m.content === 'string' ? m.content : this.stringifyContent(m.content);
      const output: LanguageModelV2ToolResultOutput = { type: 'text', value: toolResultText };
      const toolContent: ToolContent = [{ type: 'tool-result', toolCallId, toolName: 'tool', output }];
      return {
        role: 'tool',
        content: toolContent,
      };
    });
  }

  private stringifyContent(content: AiMessage['content']): string {
    if (typeof content === 'string') return content;
    return content
      .map((p) => {
        if (p.type === 'text') return p.text ?? '';
        if (p.type === 'image') return '[image]';
        return '';
      })
      .join('');
  }

  private convertUserContent(content: AiMessage['content']): UserContent {
    if (typeof content === 'string') return content;

    return content.map((p) => {
      if (p.type === 'text') return { type: 'text', text: p.text ?? '' };
      return { type: 'image', image: p.image ?? '', mimeType: p.mimeType };
    });
  }

  private convertAssistantContent(message: AiMessage): AssistantContent {
    const baseContent = typeof message.content === 'string'
      ? message.content
      : message.content.map((p) =>
        p.type === 'text'
          ? ({ type: 'text' as const, text: p.text ?? '' })
          : ({ type: 'text' as const, text: '[image]' })
      );

    if (!message.toolCalls || message.toolCalls.length === 0) return baseContent;

    const toolCallParts = message.toolCalls.map((tc) => ({
      type: 'tool-call' as const,
      toolCallId: tc.id,
      toolName: tc.name,
      input: tc.arguments,
    }));

    if (typeof baseContent === 'string') {
      return [{ type: 'text', text: baseContent }, ...toolCallParts];
    }
    return [...baseContent, ...toolCallParts];
  }

  private classifyError(error: unknown): AiError {
    if (error instanceof AiError) return error;

    const statusCode = extractStatusCode(error);
    const retryAfterMs = extractRetryAfterMs(error);
    const message = error instanceof Error ? error.message : asString(isRecord(error) ? error.message : undefined) ?? 'Unknown error';

    if (statusCode === 429) return new AiError(message, 'rate_limit', statusCode, true, retryAfterMs);
    if (statusCode === 401 || statusCode === 403) return new AiError(message, 'auth', statusCode, false);
    if (statusCode === 400) return new AiError(message, 'invalid_request', statusCode, false);
    if (statusCode !== undefined && statusCode >= 500 && statusCode <= 599) {
      return new AiError(message, 'server_error', statusCode, true, retryAfterMs);
    }

    if (isTimeoutLike(error)) return new AiError(message, 'timeout', statusCode, true, retryAfterMs);
    if (isNetworkLike(error)) return new AiError(message, 'network', statusCode, true, retryAfterMs);

    return new AiError(message, 'unknown', statusCode, false, retryAfterMs);
  }

  private enforceRateLimitOrThrow(lease: ChannelLease, request: AiRequest): void {
    const limiter = this.options?.rateLimiter;
    if (!limiter) return;

    const channelConfig = this.getChannelConfig(lease.channelId);
    if (!channelConfig?.rateLimit) return;

    const subject = `ai:${lease.channelId}:${lease.keyIndex}`;

    const rpm = channelConfig.rateLimit.rpm;
    if (rpm !== undefined) {
      const ok = limiter.consume(`${subject}:rpm`, { limit: rpm, windowMs: 60_000 });
      if (!ok) {
        const retryAfterMs = limiter.resetIn(`${subject}:rpm`, { limit: rpm, windowMs: 60_000 });
        throw new AiError('Rate limit exceeded (rpm)', 'rate_limit', 429, true, retryAfterMs);
      }
    }

    const tpm = channelConfig.rateLimit.tpm;
    const estimatedTokens = request.maxTokens;
    if (tpm !== undefined && estimatedTokens !== undefined) {
      const ok = limiter.consume(`${subject}:tpm`, { limit: tpm, windowMs: 60_000 }, estimatedTokens);
      if (!ok) {
        const retryAfterMs = limiter.resetIn(`${subject}:tpm`, { limit: tpm, windowMs: 60_000 });
        throw new AiError('Rate limit exceeded (tpm)', 'rate_limit', 429, true, retryAfterMs);
      }
    }
  }

  private getChannelConfig(channelId: string): ChannelConfig | undefined {
    const view = this.channelManager as unknown as ChannelManagerView;
    return view.channels?.get(channelId)?.config;
  }

  private setupTimeout(abortController: AbortController, lease: ChannelLease): ReturnType<typeof setTimeout> | undefined {
    const channelConfig = this.getChannelConfig(lease.channelId);
    const timeoutMs = channelConfig?.timeout;
    if (timeoutMs === undefined) return undefined;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;

    return setTimeout(() => abortController.abort(), timeoutMs);
  }

  private static async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}

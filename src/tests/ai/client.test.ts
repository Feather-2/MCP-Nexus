import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChannelManager } from '../../ai/channel.js';
import { CostTracker } from '../../ai/cost-tracker.js';
import { SlidingWindowRateLimiter } from '../../ai/rate-limiter.js';
import { AiError, type AiClientConfig, type AiRequest } from '../../ai/types.js';

import { generateText, streamText } from 'ai';

vi.mock('ai', () => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => ((modelId: string) => ({ provider: 'anthropic', modelId }))),
}));
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => ((modelId: string) => ({ provider: 'openai', modelId }))),
}));
vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: vi.fn(() => ((modelId: string) => ({ provider: 'google', modelId }))),
}));
vi.mock('@ai-sdk/mistral', () => ({
  createMistral: vi.fn(() => ((modelId: string) => ({ provider: 'mistral', modelId }))),
}));
vi.mock('@ai-sdk/groq', () => ({
  createGroq: vi.fn(() => ((modelId: string) => ({ provider: 'groq', modelId }))),
}));
vi.mock('@ai-sdk/deepseek', () => ({
  createDeepSeek: vi.fn(() => ((modelId: string) => ({ provider: 'deepseek', modelId }))),
}));
vi.mock('ollama-ai-provider', () => ({
  createOllama: vi.fn(() => ((modelId: string) => ({ provider: 'ollama', modelId }))),
}));

function makeConfig(channels: AiClientConfig['channels']): AiClientConfig {
  return { channels };
}

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

function baseRequest(): AiRequest {
  return { messages: [{ role: 'user', content: 'hi' }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

describe('UnifiedAiClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('generate returns result on success', async () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt-4o',
          keySource: { type: 'literal', value: 'k1\nk2', format: 'newline' },
        },
      ])
    );

    vi.mocked(generateText).mockResolvedValueOnce({
      text: 'hello',
      toolCalls: [{ toolCallId: 'tc1', toolName: 'search', input: { q: 'x' } }],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      finishReason: 'stop',
    } as unknown as Awaited<ReturnType<typeof generateText>>);

    const { UnifiedAiClient } = await import('../../ai/client.js');
    const client = new UnifiedAiClient(mgr, { retryAttempts: 0 });

    const result = await client.generate(baseRequest(), 'c1');
    expect(result.text).toBe('hello');
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(result.finishReason).toBe('stop');
    expect(result.channelId).toBe('c1');
    expect(result.keyIndex).toBe(0);
    expect(result.toolCalls).toEqual([{ id: 'tc1', name: 'search', arguments: { q: 'x' } }]);
  });

  it('generate uses request.model override when selecting provider model', async () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt-4o',
          keySource: { type: 'literal', value: 'k1', format: 'single' },
        },
      ])
    );

    vi.mocked(generateText).mockResolvedValueOnce({
      text: 'hello',
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      finishReason: 'stop',
    } as unknown as Awaited<ReturnType<typeof generateText>>);

    const { UnifiedAiClient } = await import('../../ai/client.js');
    const client = new UnifiedAiClient(mgr, { retryAttempts: 0 });

    await client.generate({ ...baseRequest(), model: 'gpt-4o-mini' }, 'c1');

    const call0 = vi.mocked(generateText).mock.calls[0]?.[0];
    expect(isRecord(call0)).toBe(true);
    const model = isRecord(call0) ? (call0.model as unknown) : undefined;
    expect(isRecord(model) ? model.modelId : undefined).toBe('gpt-4o-mini');
  });

  it('generate works without options and normalizes missing usage to zeros', async () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt-4o',
          keySource: { type: 'literal', value: 'k1', format: 'single' },
        },
      ])
    );

    vi.mocked(generateText).mockResolvedValueOnce({
      text: 'ok',
      toolCalls: [],
      finishReason: 'stop',
    } as unknown as Awaited<ReturnType<typeof generateText>>);

    const { UnifiedAiClient } = await import('../../ai/client.js');
    const client = new UnifiedAiClient(mgr);

    const result = await client.generate(
      {
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hi' },
        ],
      },
      'c1'
    );

    expect(result.text).toBe('ok');
    expect(result.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  it('maps finishReason variants (length/error/default)', async () => {
    const { UnifiedAiClient } = await import('../../ai/client.js');

    const mk = async (finishReason: unknown) => {
      const mgr = new ChannelManager(
        makeConfig([
          {
            id: 'c1',
            provider: 'openai',
            model: 'gpt-4o',
            keySource: { type: 'literal', value: 'k1', format: 'single' },
          },
        ])
      );
      vi.mocked(generateText).mockResolvedValueOnce({
        text: 'ok',
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        finishReason,
      } as unknown as Awaited<ReturnType<typeof generateText>>);

      return new UnifiedAiClient(mgr, { retryAttempts: 0 }).generate(baseRequest(), 'c1');
    };

    expect((await mk('length')).finishReason).toBe('length');
    expect((await mk('error')).finishReason).toBe('error');
    expect((await mk('other')).finishReason).toBe('stop');
  });

  it('classifies non-object and message-only errors, and handles invalid retry-after headers', async () => {
    const { UnifiedAiClient } = await import('../../ai/client.js');

    {
      const mgr = new ChannelManager(
        makeConfig([
          {
            id: 'c1',
            provider: 'openai',
            model: 'gpt-4o',
            keySource: { type: 'literal', value: 'k1', format: 'single' },
          },
        ])
      );
      const client = new UnifiedAiClient(mgr, { retryAttempts: 0 });
      vi.mocked(generateText).mockRejectedValueOnce('boom');
      await expect(client.generate(baseRequest(), 'c1')).rejects.toMatchObject({ type: 'unknown', statusCode: undefined });
    }

    {
      const mgr = new ChannelManager(
        makeConfig([
          {
            id: 'c1',
            provider: 'openai',
            model: 'gpt-4o',
            keySource: { type: 'literal', value: 'k1', format: 'single' },
          },
        ])
      );
      const client = new UnifiedAiClient(mgr, { retryAttempts: 0 });
      vi.mocked(generateText).mockRejectedValueOnce({});
      await expect(client.generate(baseRequest(), 'c1')).rejects.toMatchObject({ type: 'unknown' });
    }

    {
      const mgr = new ChannelManager(
        makeConfig([
          {
            id: 'c1',
            provider: 'openai',
            model: 'gpt-4o',
            keySource: { type: 'literal', value: 'k1', format: 'single' },
          },
        ])
      );
      const client = new UnifiedAiClient(mgr, { retryAttempts: 0 });
      vi.mocked(generateText).mockRejectedValueOnce({ statusCode: 429, message: 'x', headers: {} });
      await expect(client.generate(baseRequest(), 'c1')).rejects.toMatchObject({ type: 'rate_limit', retryAfterMs: undefined });
    }

    {
      const mgr = new ChannelManager(
        makeConfig([
          {
            id: 'c1',
            provider: 'openai',
            model: 'gpt-4o',
            keySource: { type: 'literal', value: 'k1', format: 'single' },
          },
        ])
      );
      const client = new UnifiedAiClient(mgr, { retryAttempts: 0 });
      vi.mocked(generateText).mockRejectedValueOnce({ statusCode: 429, message: 'x', headers: { 'retry-after': 'notadate' } });
      await expect(client.generate(baseRequest(), 'c1')).rejects.toMatchObject({ type: 'rate_limit', retryAfterMs: undefined });
    }
  });

  it('extracts statusCode from response.statusCode and ignores non-finite status codes', async () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt-4o',
          keySource: { type: 'literal', value: 'k1', format: 'single' },
        },
      ])
    );

    const { UnifiedAiClient } = await import('../../ai/client.js');
    const client = new UnifiedAiClient(mgr, { retryAttempts: 0 });

    vi.mocked(generateText).mockRejectedValueOnce({ response: { statusCode: 503 }, message: 'x' });
    await expect(client.generate(baseRequest(), 'c1')).rejects.toMatchObject({ type: 'server_error', statusCode: 503 });

    vi.mocked(generateText).mockRejectedValueOnce({ statusCode: Number.POSITIVE_INFINITY, message: 'x' });
    await expect(client.generate(baseRequest(), 'c1')).rejects.toMatchObject({ type: 'unknown', statusCode: undefined });
  });

  it('maps finishReason tool-calls to tool_calls', async () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt-4o',
          keySource: { type: 'literal', value: 'k1', format: 'single' },
        },
      ])
    );

    vi.mocked(generateText).mockResolvedValueOnce({
      text: 'hello',
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      finishReason: 'tool-calls',
    } as unknown as Awaited<ReturnType<typeof generateText>>);

    const { UnifiedAiClient } = await import('../../ai/client.js');
    const client = new UnifiedAiClient(mgr, { retryAttempts: 0 });

    const result = await client.generate(baseRequest(), 'c1');
    expect(result.finishReason).toBe('tool_calls');
  });

  it('wraps non-object tool call input as { value }', async () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt-4o',
          keySource: { type: 'literal', value: 'k1', format: 'single' },
        },
      ])
    );

    vi.mocked(generateText).mockResolvedValueOnce({
      text: 'hello',
      toolCalls: [{ toolCallId: 'tc1', toolName: 't', input: 'raw' }],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      finishReason: 'stop',
    } as unknown as Awaited<ReturnType<typeof generateText>>);

    const { UnifiedAiClient } = await import('../../ai/client.js');
    const client = new UnifiedAiClient(mgr, { retryAttempts: 0 });

    const result = await client.generate(baseRequest(), 'c1');
    expect(result.toolCalls).toEqual([{ id: 'tc1', name: 't', arguments: { value: 'raw' } }]);
  });

  it('generate retries on retryable errors and rotates key', async () => {
    vi.useFakeTimers();

    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt-4o',
          keyRotation: 'polling',
          keySource: { type: 'literal', value: 'k1\nk2', format: 'newline' },
        },
      ])
    );

    vi.mocked(generateText)
      .mockRejectedValueOnce({ statusCode: 500, message: 'boom' })
      .mockResolvedValueOnce({
        text: 'ok',
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        finishReason: 'stop',
      } as unknown as Awaited<ReturnType<typeof generateText>>);

    const { UnifiedAiClient } = await import('../../ai/client.js');
    const client = new UnifiedAiClient(mgr, { retryAttempts: 1, retryDelayMs: 100 });

    const p = client.generate(baseRequest(), 'c1');
    await vi.runAllTimersAsync();
    const result = await p;

    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(2);
    expect(result.text).toBe('ok');
    expect(result.keyIndex).toBe(1);
  });

  it('generate throws after exhausting retries', async () => {
    vi.useFakeTimers();

    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt-4o',
          keyRotation: 'polling',
          keySource: { type: 'literal', value: 'k1\nk2', format: 'newline' },
        },
      ])
    );

    vi.mocked(generateText).mockRejectedValue({ statusCode: 503, message: 'down' });

    const { UnifiedAiClient } = await import('../../ai/client.js');
    const client = new UnifiedAiClient(mgr, { retryAttempts: 2, retryDelayMs: 50 });

    const p = client.generate(baseRequest(), 'c1');
    const assertion = expect(p).rejects.toMatchObject({
      name: 'AiError',
      type: 'server_error',
      retryable: true,
      statusCode: 503,
    });
    await vi.runAllTimersAsync();
    await assertion;
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(3);
  });

  it('stream yields expected chunks', async () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt-4o',
          keySource: { type: 'literal', value: 'k1', format: 'single' },
        },
      ])
    );

    vi.mocked(streamText).mockReturnValueOnce({
      fullStream: fromArray([
        { type: 'text-delta', id: 't1', text: 'he' },
        { type: 'text-delta', id: 't1', text: 'llo' },
        { type: 'tool-call', toolCallId: 'tc1', toolName: 'search', input: { q: 'x' } },
        { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
      ]),
      totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
      finishReason: Promise.resolve('stop'),
    } as unknown as ReturnType<typeof streamText>);

    const { UnifiedAiClient } = await import('../../ai/client.js');
    const client = new UnifiedAiClient(mgr, { retryAttempts: 0 });

    const chunks: unknown[] = [];
    for await (const chunk of client.stream(baseRequest(), 'c1')) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { type: 'text', text: 'he' },
      { type: 'text', text: 'llo' },
      { type: 'tool_call', toolCall: { id: 'tc1', name: 'search', arguments: { q: 'x' } } },
      { type: 'finish', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } },
    ]);
  });

  it('stream works without options', async () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt-4o',
          keySource: { type: 'literal', value: 'k1', format: 'single' },
        },
      ])
    );

    vi.mocked(streamText).mockReturnValueOnce({
      fullStream: fromArray([{ type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }]),
      totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      finishReason: Promise.resolve('stop'),
    } as unknown as ReturnType<typeof streamText>);

    const { UnifiedAiClient } = await import('../../ai/client.js');
    const client = new UnifiedAiClient(mgr);

    const chunks: unknown[] = [];
    for await (const chunk of client.stream(baseRequest(), 'c1')) chunks.push(chunk);
    expect(chunks).toEqual([{ type: 'finish', finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }]);
  });

  it('covers private conversion helpers and early-exit branches', async () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt-4o',
          timeout: 0,
          keySource: { type: 'literal', value: 'k1', format: 'single' },
        },
      ])
    );

    const { UnifiedAiClient } = await import('../../ai/client.js');
    const client = new UnifiedAiClient(mgr, { retryAttempts: 0, rateLimiter: new SlidingWindowRateLimiter({ cleanupIntervalMs: 0 }) });

    const view = client as unknown as {
      stringifyContent: (content: unknown) => string;
      convertUserContent: (content: unknown) => unknown;
      convertAssistantContent: (message: unknown) => unknown;
      convertMessages: (messages: unknown) => unknown;
      setupTimeout: (abortController: AbortController, lease: unknown) => unknown;
      enforceRateLimitOrThrow: (lease: unknown, request: unknown) => void;
    };

    expect(view.stringifyContent('s')).toBe('s');
    expect(view.stringifyContent([{ type: 'text' }, { type: 'image' }])).toBe('[image]');

    expect(view.convertUserContent([{ type: 'text' }, { type: 'image' }])).toEqual([
      { type: 'text', text: '' },
      { type: 'image', image: '', mimeType: undefined },
    ]);

    expect(
      view.convertAssistantContent({
        role: 'assistant',
        content: 'a',
        toolCalls: [{ id: 'tc1', name: 't', arguments: { x: 1 } }],
      })
    ).toEqual([
      { type: 'text', text: 'a' },
      { type: 'tool-call', toolCallId: 'tc1', toolName: 't', input: { x: 1 } },
    ]);

    expect(view.convertAssistantContent({ role: 'assistant', content: 'a' })).toBe('a');
    expect(view.convertAssistantContent({ role: 'assistant', content: [{ type: 'image' }] })).toEqual([{ type: 'text', text: '[image]' }]);

    expect(
      view.convertMessages([
        { role: 'system', content: 'sys' },
        { role: 'tool', content: [{ type: 'text', text: 'r' }], toolCalls: [], toolCallId: undefined },
      ])
    ).toMatchObject([
      { role: 'system', content: 'sys' },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tool-call', toolName: 'tool' }] },
    ]);

    const lease = mgr.acquire('c1');
    expect(view.setupTimeout(new AbortController(), lease)).toBeUndefined();
    expect(() => view.enforceRateLimitOrThrow(lease, baseRequest())).not.toThrow();
  });

  it('stream covers model override, invalid parts, costTracker, and timeout cleanup', async () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt-4o',
          timeout: 100,
          keySource: { type: 'literal', value: 'k1', format: 'single' },
        },
      ])
    );

    const tracker = new CostTracker();
    const recordSpy = vi.spyOn(tracker, 'record');

    vi.mocked(streamText).mockReturnValueOnce({
      fullStream: fromArray([
        null,
        { type: 1 },
        { type: 'text-delta', id: 't1', text: 123 },
        { type: 'tool-call', toolCallId: 1, toolName: null, input: 7 },
        { type: 'finish', finishReason: 'length', totalUsage: undefined },
      ]),
      totalUsage: Promise.resolve(undefined),
      finishReason: Promise.resolve('length'),
    } as unknown as ReturnType<typeof streamText>);

    const { UnifiedAiClient } = await import('../../ai/client.js');
    const client = new UnifiedAiClient(mgr, { retryAttempts: 0, costTracker: tracker });

    const chunks: unknown[] = [];
    for await (const chunk of client.stream({ ...baseRequest(), model: 'gpt-4o-mini' }, 'c1')) chunks.push(chunk);

    expect(chunks).toEqual([
      { type: 'tool_call', toolCall: { id: '', name: '', arguments: { value: 7 } } },
      { type: 'finish', finishReason: 'length', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
    ]);
    expect(recordSpy).toHaveBeenCalledWith('gpt-4o-mini', { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  it('stream disables key on 401 auth errors', async () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt-4o',
          keyRotation: 'polling',
          keySource: { type: 'literal', value: 'k1\nk2', format: 'newline' },
        },
      ])
    );

    vi.mocked(streamText).mockReturnValueOnce({
      fullStream: (async function* () {
        if (Date.now() < 0) yield { type: 'text-delta', id: 't0', text: '' };
        throw { statusCode: 401, message: 'nope' };
      })(),
      totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      finishReason: Promise.resolve('stop'),
    } as unknown as ReturnType<typeof streamText>);

    const { UnifiedAiClient } = await import('../../ai/client.js');
    const client = new UnifiedAiClient(mgr, { retryAttempts: 0 });

    const chunks: unknown[] = [];
    for await (const chunk of client.stream(baseRequest(), 'c1')) chunks.push(chunk);
    expect(chunks).toEqual([{ type: 'error', error: expect.objectContaining({ type: 'auth', statusCode: 401 }) }]);
    expect(mgr.getState('c1')?.keys[0]?.enabled).toBe(false);
  });

  it('stream retries with delay when a retryable error occurs before any chunks', async () => {
    vi.useFakeTimers();

    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt-4o',
          keySource: { type: 'literal', value: 'k1\nk2', format: 'newline' },
        },
      ])
    );

    vi.mocked(streamText)
      .mockReturnValueOnce({
        fullStream: (async function* () {
          if (Date.now() < 0) yield { type: 'text-delta', id: 't0', text: '' };
          throw { statusCode: 500, message: 'oops' };
        })(),
        totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
        finishReason: Promise.resolve('stop'),
      } as unknown as ReturnType<typeof streamText>)
      .mockReturnValueOnce({
        fullStream: fromArray([{ type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }]),
        totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
        finishReason: Promise.resolve('stop'),
      } as unknown as ReturnType<typeof streamText>);

    const { UnifiedAiClient } = await import('../../ai/client.js');
    const client = new UnifiedAiClient(mgr, { retryAttempts: 1, retryDelayMs: 10 });

    const p = (async () => {
      const chunks: unknown[] = [];
      for await (const chunk of client.stream(baseRequest(), 'c1')) chunks.push(chunk);
      return chunks;
    })();

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toEqual([{ type: 'finish', finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }]);
    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(2);
  });

  it('generate and stream skip loops when retryAttempts is NaN', async () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt-4o',
          keySource: { type: 'literal', value: 'k1', format: 'single' },
        },
      ])
    );

    const { UnifiedAiClient } = await import('../../ai/client.js');

    await expect(new UnifiedAiClient(mgr, { retryAttempts: Number.NaN }).generate(baseRequest(), 'c1')).rejects.toMatchObject({
      name: 'AiError',
      type: 'unknown',
    });

    const chunks: unknown[] = [];
    for await (const chunk of new UnifiedAiClient(mgr, { retryAttempts: Number.NaN }).stream(baseRequest(), 'c1')) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([{ type: 'error', error: expect.objectContaining({ type: 'unknown' }) }]);
  });

  it('stream retries when error occurs before first chunk', async () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt-4o',
          keySource: { type: 'literal', value: 'k1\nk2', format: 'newline' },
        },
      ])
    );

    vi.mocked(streamText)
      .mockReturnValueOnce({
        fullStream: (async function* () {
          if (Date.now() < 0) yield { type: 'text-delta', id: 't0', text: '' };
          throw { statusCode: 500, message: 'oops' };
        })(),
        totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
        finishReason: Promise.resolve('stop'),
      } as unknown as ReturnType<typeof streamText>)
      .mockReturnValueOnce({
        fullStream: fromArray([
          { type: 'text-delta', id: 't1', text: 'ok' },
          { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 } },
        ]),
        totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
        finishReason: Promise.resolve('stop'),
      } as unknown as ReturnType<typeof streamText>);

    const { UnifiedAiClient } = await import('../../ai/client.js');
    const client = new UnifiedAiClient(mgr, { retryAttempts: 1, retryDelayMs: 0 });

    const chunks: unknown[] = [];
    for await (const chunk of client.stream(baseRequest(), 'c1')) chunks.push(chunk);

    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(2);
    expect(chunks).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'finish', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 } },
    ]);
  });

  it('stream yields error chunk and stops when an error happens after emitting text', async () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt-4o',
          keySource: { type: 'literal', value: 'k1', format: 'single' },
        },
      ])
    );

    vi.mocked(streamText).mockReturnValueOnce({
      fullStream: (async function* () {
        yield { type: 'text-delta', id: 't1', text: 'partial' };
        throw { statusCode: 500, message: 'oops' };
      })(),
      totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      finishReason: Promise.resolve('stop'),
    } as unknown as ReturnType<typeof streamText>);

    const { UnifiedAiClient } = await import('../../ai/client.js');
    const client = new UnifiedAiClient(mgr, { retryAttempts: 10, retryDelayMs: 0 });

    const chunks: unknown[] = [];
    for await (const chunk of client.stream(baseRequest(), 'c1')) chunks.push(chunk);

    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(1);
    expect(chunks).toEqual([
      { type: 'text', text: 'partial' },
      { type: 'error', error: expect.objectContaining({ name: 'AiError', type: 'server_error', statusCode: 500 }) },
    ]);
  });

  it('stream uses totalUsage/finishReason when finish part is missing', async () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt-4o',
          keySource: { type: 'literal', value: 'k1', format: 'single' },
        },
      ])
    );

    vi.mocked(streamText).mockReturnValueOnce({
      fullStream: fromArray([{ type: 'text-delta', id: 't1', text: 'hi' }]),
      totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
      finishReason: Promise.resolve('tool-calls'),
    } as unknown as ReturnType<typeof streamText>);

    const { UnifiedAiClient } = await import('../../ai/client.js');
    const client = new UnifiedAiClient(mgr, { retryAttempts: 0 });

    const chunks: unknown[] = [];
    for await (const chunk of client.stream(baseRequest(), 'c1')) chunks.push(chunk);

    expect(chunks).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'finish', finishReason: 'tool_calls', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } },
    ]);
  });

  it('classifies errors correctly (429/401/400/5xx)', async () => {
    const cases: Array<{ statusCode: number; type: AiError['type']; retryable: boolean }> = [
      { statusCode: 429, type: 'rate_limit', retryable: true },
      { statusCode: 401, type: 'auth', retryable: false },
      { statusCode: 400, type: 'invalid_request', retryable: false },
      { statusCode: 503, type: 'server_error', retryable: true },
    ];

    for (const c of cases) {
      const mgr = new ChannelManager(
        makeConfig([
          {
            id: 'c1',
            provider: 'openai',
            model: 'gpt-4o',
            keySource: { type: 'literal', value: 'k1\nk2', format: 'newline' },
          },
        ])
      );

      const { UnifiedAiClient } = await import('../../ai/client.js');
      const client = new UnifiedAiClient(mgr, { retryAttempts: 0 });

      vi.mocked(generateText).mockRejectedValueOnce({ statusCode: c.statusCode, message: 'x' });
      await expect(client.generate(baseRequest(), 'c1')).rejects.toMatchObject({
        name: 'AiError',
        type: c.type,
        retryable: c.retryable,
        statusCode: c.statusCode,
      });
    }
  });

  it('classifies timeout and network errors', async () => {
    vi.useFakeTimers();

    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt-4o',
          timeout: 10,
          keySource: { type: 'literal', value: 'k1', format: 'single' },
        },
      ])
    );

    vi.mocked(generateText).mockImplementationOnce((options: unknown) => {
      if (!isRecord(options)) return Promise.reject(new Error('bad options'));
      const abortSignal = options.abortSignal;
      if (!(abortSignal instanceof AbortSignal)) return Promise.reject(new Error('missing abortSignal'));

      return new Promise((_, reject) => {
        abortSignal.addEventListener(
          'abort',
          () => {
            const err = new Error('aborted');
            (err as { name: string }).name = 'AbortError';
            reject(err);
          },
          { once: true }
        );
      });
    });

    const { UnifiedAiClient } = await import('../../ai/client.js');
    const client = new UnifiedAiClient(mgr, { retryAttempts: 0 });

    const p = client.generate(baseRequest(), 'c1');
    const assertion = expect(p).rejects.toMatchObject({ name: 'AiError', type: 'timeout', retryable: true });
    await vi.advanceTimersByTimeAsync(10);
    await assertion;

    vi.mocked(generateText).mockRejectedValueOnce(new Error('Request timed out'));
    await expect(client.generate(baseRequest(), 'c1')).rejects.toMatchObject({ name: 'AiError', type: 'timeout' });

    vi.mocked(generateText).mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(client.generate(baseRequest(), 'c1')).rejects.toMatchObject({ name: 'AiError', type: 'network', retryable: true });

    vi.mocked(generateText).mockRejectedValueOnce(new TypeError('network error'));
    await expect(client.generate(baseRequest(), 'c1')).rejects.toMatchObject({ name: 'AiError', type: 'network', retryable: true });
  });

  it('integrates rateLimiter and throws before calling SDK', async () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt-4o',
          rateLimit: { rpm: 0 },
          keySource: { type: 'literal', value: 'k1', format: 'single' },
        },
      ])
    );

    const limiter = new SlidingWindowRateLimiter({ cleanupIntervalMs: 0 });

    const { UnifiedAiClient } = await import('../../ai/client.js');
    const client = new UnifiedAiClient(mgr, { retryAttempts: 0, rateLimiter: limiter });

    await expect(client.generate(baseRequest(), 'c1')).rejects.toMatchObject({ name: 'AiError', type: 'rate_limit' });
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
  });

  it('enforces token-per-minute limits when maxTokens is provided', async () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt-4o',
          rateLimit: { tpm: 1 },
          keySource: { type: 'literal', value: 'k1', format: 'single' },
        },
      ])
    );

    const limiter = new SlidingWindowRateLimiter({ cleanupIntervalMs: 0 });

    const { UnifiedAiClient } = await import('../../ai/client.js');
    const client = new UnifiedAiClient(mgr, { retryAttempts: 0, rateLimiter: limiter });

    await expect(client.generate({ ...baseRequest(), maxTokens: 2 }, 'c1')).rejects.toMatchObject({
      name: 'AiError',
      type: 'rate_limit',
    });
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
  });

  it('respects retry-after header when retrying 429 errors', async () => {
    vi.useFakeTimers();

    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt-4o',
          keyRotation: 'polling',
          keySource: { type: 'literal', value: 'k1\nk2', format: 'newline' },
        },
      ])
    );

    vi.mocked(generateText)
      .mockRejectedValueOnce({ statusCode: 429, message: 'rl', headers: { 'retry-after': '2' } })
      .mockResolvedValueOnce({
        text: 'ok',
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        finishReason: 'stop',
      } as unknown as Awaited<ReturnType<typeof generateText>>);

    const { UnifiedAiClient } = await import('../../ai/client.js');
    const client = new UnifiedAiClient(mgr, { retryAttempts: 1, retryDelayMs: 0 });

    const p = client.generate(baseRequest(), 'c1');
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1999);
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toMatchObject({ text: 'ok' });
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(2);
  });

  it('integrates costTracker and records usage', async () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt-4o',
          keySource: { type: 'literal', value: 'k1', format: 'single' },
        },
      ])
    );

    const tracker = new CostTracker();
    const recordSpy = vi.spyOn(tracker, 'record');

    vi.mocked(generateText).mockResolvedValueOnce({
      text: 'hello',
      toolCalls: [],
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      finishReason: 'stop',
    } as unknown as Awaited<ReturnType<typeof generateText>>);

    const { UnifiedAiClient } = await import('../../ai/client.js');
    const client = new UnifiedAiClient(mgr, { retryAttempts: 0, costTracker: tracker });

    const req = baseRequest();
    const result = await client.generate(req, 'c1');
    expect(result.usage).toEqual({ promptTokens: 2, completionTokens: 3, totalTokens: 5 });

    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledWith('gpt-4o', { promptTokens: 2, completionTokens: 3, totalTokens: 5 });
  });

  it('initializes provider based on lease.provider and falls back for unknown providers', async () => {
    const { createAnthropic } = await import('@ai-sdk/anthropic');
    const { createOpenAI } = await import('@ai-sdk/openai');

    const anthropicMgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'anthropic',
          model: 'claude',
          baseUrl: 'https://proxy.example/v1',
          headers: { 'x-test': '1' },
          keySource: { type: 'literal', value: 'k1', format: 'single' },
        },
      ])
    );

    vi.mocked(generateText).mockResolvedValueOnce({
      text: 'ok',
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      finishReason: 'stop',
    } as unknown as Awaited<ReturnType<typeof generateText>>);

    const { UnifiedAiClient } = await import('../../ai/client.js');
    await new UnifiedAiClient(anthropicMgr, { retryAttempts: 0 }).generate(baseRequest(), 'c1');

    expect(vi.mocked(createAnthropic)).toHaveBeenCalledWith({
      apiKey: 'k1',
      headers: { 'x-test': '1' },
      baseURL: 'https://proxy.example/v1',
    });

    const azureMgr = new ChannelManager(
      makeConfig([
        {
          id: 'c2',
          provider: 'azure',
          model: 'gpt',
          keySource: { type: 'literal', value: 'k2', format: 'single' },
        },
      ])
    );

    vi.mocked(generateText).mockResolvedValueOnce({
      text: 'ok',
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      finishReason: 'stop',
    } as unknown as Awaited<ReturnType<typeof generateText>>);

    await new UnifiedAiClient(azureMgr, { retryAttempts: 0 }).generate(baseRequest(), 'c2');
    expect(vi.mocked(createOpenAI)).toHaveBeenCalled();
  });

  it('converts message formats for system/user/assistant/tool', async () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt-4o',
          keySource: { type: 'literal', value: 'k1', format: 'single' },
        },
      ])
    );

    vi.mocked(generateText).mockImplementationOnce((options: unknown) => {
      if (!isRecord(options)) throw new Error('bad options');
      const messages = options.messages;
      if (!Array.isArray(messages)) throw new Error('messages missing');

      expect(messages[0]).toMatchObject({ role: 'system', content: 'sys[image]' });
      expect(messages[1]).toMatchObject({
        role: 'user',
        content: [
          { type: 'text', text: 'hello ' },
          { type: 'image', mimeType: 'image/png' },
        ],
      });
      expect(messages[2]).toMatchObject({
        role: 'assistant',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: '[image]' },
          { type: 'tool-call', toolCallId: 'tc1', toolName: 'search', input: { q: 'x' } },
        ],
      });
      expect(messages[3]).toMatchObject({
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'tc1', toolName: 'tool' }],
      });

      return Promise.resolve({
        text: 'ok',
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        finishReason: 'stop',
      } as unknown as Awaited<ReturnType<typeof generateText>>);
    });

    const { UnifiedAiClient } = await import('../../ai/client.js');
    const client = new UnifiedAiClient(mgr, { retryAttempts: 0 });

    await client.generate(
      {
        messages: [
          {
            role: 'system',
            content: [
              { type: 'text', text: 'sys' },
              { type: 'image', image: 'x' },
              { type: 'unknown' } as unknown as { type: 'text' },
            ],
          },
          { role: 'user', content: [{ type: 'text', text: 'hello ' }, { type: 'image', image: 'data', mimeType: 'image/png' }] },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'a' }, { type: 'image', image: 'x' }],
            toolCalls: [{ id: 'tc1', name: 'search', arguments: { q: 'x' } }],
          },
          { role: 'tool', content: 'result', toolCallId: 'tc1' },
        ],
      },
      'c1'
    );
  });

  it('covers provider factory cases for all supported providers', async () => {
    const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
    const { createMistral } = await import('@ai-sdk/mistral');
    const { createGroq } = await import('@ai-sdk/groq');
    const { createDeepSeek } = await import('@ai-sdk/deepseek');
    const { createOllama } = await import('ollama-ai-provider');

    const { UnifiedAiClient } = await import('../../ai/client.js');

    const providers: Array<{ id: string; provider: AiClientConfig['channels'][number]['provider'] }> = [
      { id: 'google', provider: 'google' },
      { id: 'mistral', provider: 'mistral' },
      { id: 'groq', provider: 'groq' },
      { id: 'deepseek', provider: 'deepseek' },
      { id: 'ollama', provider: 'ollama' },
    ];

    for (const p of providers) {
      const mgr = new ChannelManager(
        makeConfig([
          {
            id: p.id,
            provider: p.provider,
            model: 'm',
            baseUrl: 'http://localhost',
            headers: { 'x-test': '1' },
            keySource: { type: 'literal', value: 'k1', format: 'single' },
          },
        ])
      );

      vi.mocked(generateText).mockResolvedValueOnce({
        text: 'ok',
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        finishReason: 'stop',
      } as unknown as Awaited<ReturnType<typeof generateText>>);

      await new UnifiedAiClient(mgr, { retryAttempts: 0 }).generate(baseRequest(), p.id);
    }

    expect(vi.mocked(createGoogleGenerativeAI)).toHaveBeenCalled();
    expect(vi.mocked(createMistral)).toHaveBeenCalled();
    expect(vi.mocked(createGroq)).toHaveBeenCalled();
    expect(vi.mocked(createDeepSeek)).toHaveBeenCalled();
    expect(vi.mocked(createOllama)).toHaveBeenCalled();
  });

  it('covers error classification edge cases and status/headers parsing', async () => {
    const { UnifiedAiClient } = await import('../../ai/client.js');

    const makeClient = () => {
      const mgr = new ChannelManager(
        makeConfig([
          {
            id: 'c1',
            provider: 'openai',
            model: 'gpt-4o',
            keyRotation: 'polling',
            keySource: { type: 'literal', value: 'k1\nk2', format: 'newline' },
          },
        ])
      );
      return new UnifiedAiClient(mgr, { retryAttempts: 0 });
    };

    {
      const client = makeClient();
      const passthrough = new AiError('bad', 'invalid_request', 400, false);
      vi.mocked(generateText).mockRejectedValueOnce(passthrough);
      await expect(client.generate(baseRequest(), 'c1')).rejects.toBe(passthrough);
    }

    {
      const client = makeClient();
      vi.mocked(generateText).mockRejectedValueOnce({ response: { status: 503 }, message: 'x' });
      await expect(client.generate(baseRequest(), 'c1')).rejects.toMatchObject({ type: 'server_error', statusCode: 503 });
    }

    {
      const client = makeClient();
      vi.mocked(generateText).mockRejectedValueOnce({ status: 429, message: 'x', retryAfterMs: 123 });
      await expect(client.generate(baseRequest(), 'c1')).rejects.toMatchObject({ type: 'rate_limit', retryAfterMs: 123 });
    }

    {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
      const client = makeClient();
      vi.mocked(generateText).mockRejectedValueOnce({
        statusCode: 429,
        message: 'x',
        response: { headers: { 'Retry-After': 'Wed, 01 Jan 2025 00:00:02 GMT' } },
      });
      await expect(client.generate(baseRequest(), 'c1')).rejects.toMatchObject({ type: 'rate_limit', retryAfterMs: 2000 });
      vi.useRealTimers();
    }

    {
      const client = makeClient();
      vi.mocked(generateText).mockRejectedValueOnce({ code: 'ETIMEDOUT', message: 'x' });
      await expect(client.generate(baseRequest(), 'c1')).rejects.toMatchObject({ type: 'timeout' });
    }

    {
      const client = makeClient();
      vi.mocked(generateText).mockRejectedValueOnce({ code: 'ENOTFOUND', message: 'x' });
      await expect(client.generate(baseRequest(), 'c1')).rejects.toMatchObject({ type: 'network' });
    }

    {
      const client = makeClient();
      vi.mocked(generateText).mockRejectedValueOnce({ message: 'weird' });
      await expect(client.generate(baseRequest(), 'c1')).rejects.toMatchObject({ type: 'unknown', retryable: false });
    }
  });

  it('uses loadBalancer to choose channelId', async () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt-4o',
          keySource: { type: 'literal', value: 'k1', format: 'single' },
        },
        {
          id: 'c2',
          provider: 'openai',
          model: 'gpt-4o',
          keySource: { type: 'literal', value: 'k2', format: 'single' },
        },
      ])
    );

    vi.mocked(generateText).mockResolvedValueOnce({
      text: 'ok',
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      finishReason: 'stop',
    } as unknown as Awaited<ReturnType<typeof generateText>>);

    const { UnifiedAiClient } = await import('../../ai/client.js');
    const client = new UnifiedAiClient(mgr, {
      retryAttempts: 0,
      loadBalancer: { pickChannelId: () => 'c2' },
    });

    const result = await client.generate(baseRequest(), 'c1');
    expect(result.channelId).toBe('c2');
  });

  it('disables key on 401 auth errors', async () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt-4o',
          keyRotation: 'polling',
          keySource: { type: 'literal', value: 'k1\nk2', format: 'newline' },
        },
      ])
    );

    vi.mocked(generateText).mockRejectedValueOnce({ statusCode: 401, message: 'nope' });

    const { UnifiedAiClient } = await import('../../ai/client.js');
    const client = new UnifiedAiClient(mgr, { retryAttempts: 10 });

    await expect(client.generate(baseRequest(), 'c1')).rejects.toBeInstanceOf(AiError);

    const state = mgr.getState('c1');
    expect(state?.keys[0]?.enabled).toBe(false);
    expect(mgr.acquire('c1').keyIndex).toBe(1);
  });
});

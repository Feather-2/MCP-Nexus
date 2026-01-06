import { MiddlewareChain, STAGES } from '../../middleware/index.js';
import type { Context, Middleware, State } from '../../middleware/index.js';

function createContext(): Context {
  return { requestId: 'req-1', startTime: Date.now(), metadata: {} };
}

function createState(): State {
  return { stage: 'beforeAgent', values: new Map<string, unknown>(), aborted: false };
}

describe('MiddlewareChain', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('executes middleware hooks sequentially for each stage', async () => {
    const calls: string[] = [];

    const mw1: Middleware = {
      name: 'mw1',
      beforeAgent: async (_ctx, state) => { calls.push(`mw1:${state.stage}`); },
      beforeModel: async (_ctx, state) => { calls.push(`mw1:${state.stage}`); },
      afterModel: async (_ctx, state) => { calls.push(`mw1:${state.stage}`); },
      beforeTool: async (_ctx, state) => { calls.push(`mw1:${state.stage}`); },
      afterTool: async (_ctx, state) => { calls.push(`mw1:${state.stage}`); },
      afterAgent: async (_ctx, state) => { calls.push(`mw1:${state.stage}`); }
    };

    const mw2: Middleware = {
      name: 'mw2',
      beforeAgent: async (_ctx, state) => { calls.push(`mw2:${state.stage}`); },
      beforeModel: async (_ctx, state) => { calls.push(`mw2:${state.stage}`); },
      afterModel: async (_ctx, state) => { calls.push(`mw2:${state.stage}`); },
      // intentionally omit `beforeTool` to cover skip behavior
      afterTool: async (_ctx, state) => { calls.push(`mw2:${state.stage}`); },
      afterAgent: async (_ctx, state) => { calls.push(`mw2:${state.stage}`); }
    };

    const chain = new MiddlewareChain([mw1]);
    chain.use(mw2);

    const ctx = createContext();
    const state = createState();

    for (const stage of STAGES) {
      await chain.execute(stage, ctx, state);
    }

    const expected: string[] = [];
    for (const stage of STAGES) {
      expected.push(`mw1:${stage}`);
      if (stage !== 'beforeTool') expected.push(`mw2:${stage}`);
    }

    expect(calls).toEqual(expected);
    expect(state.aborted).toBe(false);
    expect(state.error).toBeUndefined();
  });

  it('short-circuits when a middleware throws', async () => {
    const calls: string[] = [];

    const mw1: Middleware = {
      name: 'mw1',
      beforeModel: async (_ctx, state) => { calls.push(`mw1:${state.stage}`); }
    };

    const mw2: Middleware = {
      name: 'mw2',
      beforeModel: async (_ctx, state) => {
        calls.push(`mw2:${state.stage}`);
        throw new Error('boom');
      }
    };

    const mw3: Middleware = {
      name: 'mw3',
      beforeModel: async (_ctx, state) => { calls.push(`mw3:${state.stage}`); }
    };

    const chain = new MiddlewareChain([mw1, mw2, mw3]);
    const ctx = createContext();
    const state = createState();

    await expect(chain.execute('beforeModel', ctx, state)).rejects.toThrow(/boom/);
    expect(calls).toEqual(['mw1:beforeModel', 'mw2:beforeModel']);
    expect(state.stage).toBe('beforeModel');
    expect(state.aborted).toBe(true);
    expect(state.error).toBeInstanceOf(Error);
  });

  it('short-circuits when a middleware times out', async () => {
    vi.useFakeTimers();

    const calls: string[] = [];

    const mw1: Middleware = {
      name: 'slow',
      beforeAgent: async (_ctx, state) => {
        calls.push(`slow:${state.stage}`);
        await new Promise<void>(() => {});
      }
    };

    const mw2: Middleware = {
      name: 'mw2',
      beforeAgent: async (_ctx, state) => { calls.push(`mw2:${state.stage}`); }
    };

    const chain = new MiddlewareChain([mw1, mw2], { stageTimeoutMs: { beforeAgent: 10 } });
    const ctx = createContext();
    const state = createState();

    const p = chain.execute('beforeAgent', ctx, state);
    const assertion = expect(p).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(11);
    await assertion;
    expect(calls).toEqual(['slow:beforeAgent']);
    expect(state.aborted).toBe(true);

    const err = state.error;
    expect(err).toBeInstanceOf(Error);
    if (err instanceof Error) {
      const cause = (err as { cause?: unknown }).cause;
      expect(cause).toBeInstanceOf(Error);
      if (cause instanceof Error) {
        expect(cause.name).toBe('TimeoutError');
      }
    }
  });

  it('shares state.values across middleware', async () => {
    let firstMap: Map<string, unknown> | undefined;

    const mw1: Middleware = {
      name: 'mw1',
      beforeAgent: async (_ctx, state) => {
        firstMap = state.values;
        state.values.set('x', 1);
      }
    };

    const mw2: Middleware = {
      name: 'mw2',
      beforeAgent: async (_ctx, state) => {
        expect(state.values).toBe(firstMap);
        expect(state.values.get('x')).toBe(1);
        state.values.set('y', 2);
      }
    };

    const chain = new MiddlewareChain([mw1, mw2]);
    const ctx = createContext();
    const state = createState();

    await chain.execute('beforeAgent', ctx, state);

    expect(state.values.get('x')).toBe(1);
    expect(state.values.get('y')).toBe(2);
  });

  it('stops without error when state.aborted is set', async () => {
    const calls: string[] = [];

    const mw1: Middleware = {
      name: 'mw1',
      beforeTool: async (_ctx, state) => {
        calls.push('mw1');
        state.aborted = true;
      }
    };

    const mw2: Middleware = {
      name: 'mw2',
      beforeTool: async () => { calls.push('mw2'); }
    };

    const chain = new MiddlewareChain([mw1, mw2]);
    const ctx = createContext();
    const state = createState();

    await chain.execute('beforeTool', ctx, state);

    expect(calls).toEqual(['mw1']);
    expect(state.aborted).toBe(true);
    expect(state.error).toBeUndefined();
  });

  it('does nothing when state is already aborted', async () => {
    const calls: string[] = [];
    const chain = new MiddlewareChain([
      {
        name: 'mw',
        beforeAgent: async () => { calls.push('mw'); }
      }
    ]);

    const ctx = createContext();
    const state = createState();
    state.aborted = true;

    await chain.execute('beforeAgent', ctx, state);
    expect(calls).toEqual([]);
  });

  it('wraps non-Error throws as errors', async () => {
    const cases: Array<{
      label: string;
      name: string;
      thrown: unknown;
      expectedMessage: RegExp;
    }> = [
      { label: 'string', name: 'mw', thrown: 'string failure', expectedMessage: /string failure/ },
      { label: 'number', name: 'mw', thrown: 123, expectedMessage: /123/ },
      { label: 'object with message', name: 'mw', thrown: { message: 'object failure' }, expectedMessage: /object failure/ },
      { label: 'unknown object', name: 'mw', thrown: { ok: false }, expectedMessage: /Unknown error/ },
      { label: 'empty name', name: '   ', thrown: 'oops', expectedMessage: /middleware "<unnamed>"/ }
    ];

    for (const t of cases) {
      const chain = new MiddlewareChain([
        {
          name: t.name,
          beforeAgent: async () => {
            throw t.thrown;
          }
        }
      ]);

      const ctx = createContext();
      const state = createState();

      await expect(chain.execute('beforeAgent', ctx, state)).rejects.toThrow(t.expectedMessage);
      expect(state.aborted).toBe(true);
      expect(state.error).toBeInstanceOf(Error);
    }
  });

  it('short-circuits when an AbortSignal is triggered', async () => {
    const controller = new AbortController();
    const calls: string[] = [];

    const mw1: Middleware = {
      name: 'mw1',
      beforeAgent: async () => {
        calls.push('mw1');
        await new Promise<void>(() => {});
      }
    };

    const mw2: Middleware = {
      name: 'mw2',
      beforeAgent: async () => {
        calls.push('mw2');
      }
    };

    const chain = new MiddlewareChain([mw1, mw2]);
    const ctx = { ...createContext(), signal: controller.signal } as any;
    const state = createState();

    const p = chain.execute('beforeAgent', ctx, state);
    controller.abort('stop');

    await expect(p).rejects.toThrow(/aborted/i);
    expect(calls).toEqual(['mw1']);
    expect(state.aborted).toBe(true);

    const err = state.error;
    expect(err).toBeInstanceOf(Error);
    if (err instanceof Error) {
      const cause = (err as { cause?: unknown }).cause;
      expect(cause).toBeInstanceOf(Error);
      if (cause instanceof Error) {
        expect(cause.name).toBe('AbortError');
      }
    }
  });

  it('uses a total stage timeout budget across middleware', async () => {
    vi.useFakeTimers();

    const calls: string[] = [];
    const mw1: Middleware = {
      name: 'mw1',
      beforeAgent: async () => {
        calls.push('mw1');
        await new Promise<void>((resolve) => setTimeout(resolve, 6));
      }
    };

    const mw2: Middleware = {
      name: 'mw2',
      beforeAgent: async () => {
        calls.push('mw2');
        await new Promise<void>((resolve) => setTimeout(resolve, 6));
      }
    };

    const chain = new MiddlewareChain([mw1, mw2], { stageTimeoutMs: { beforeAgent: 10 } });
    const ctx = createContext();
    const state = createState();

    const run = chain.execute('beforeAgent', ctx, state);
    const assertion = expect(run).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(11);
    await assertion;
    expect(calls).toEqual(['mw1', 'mw2']);
  });
});

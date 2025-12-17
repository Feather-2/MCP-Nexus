import { HookExecutor } from '../../hooks/index.js';
import type { HookPayload, ShellHook } from '../../hooks/index.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

function buildCatHook(event: ShellHook['event'], selector?: ShellHook['selector']): ShellHook {
  return { event, command: 'cat', selector };
}

describe('HookExecutor', () => {
  it('registers and matches hooks by event', async () => {
    const executor = new HookExecutor();
    executor.register(
      { event: 'PreToolUse', command: 'echo pre-1' },
      { event: 'PostToolUse', command: 'echo post-1' },
      { event: 'PreToolUse', command: 'echo pre-2' }
    );

    const results = await executor.execute('PreToolUse', { tool_input: { name: 't', params: { x: 1 } } });

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.stdout.trim())).toEqual(['pre-1', 'pre-2']);
    expect(results.every((r) => r.decision === 'allow' && r.exitCode === 0)).toBe(true);
  });

  it('executes a shell command and passes JSON payload via stdin', async () => {
    const executor = new HookExecutor();
    executor.register(buildCatHook('UserPromptSubmit'));

    const results = await executor.execute('UserPromptSubmit', { session_id: 's1', user_prompt: 'hello' });
    expect(results).toHaveLength(1);

    const stdout = results[0]?.stdout ?? '';
    const parsed = JSON.parse(stdout) as HookPayload;
    expect(parsed).toEqual({ hook_event_name: 'UserPromptSubmit', session_id: 's1', user_prompt: 'hello' });
  });

  it.each([
    { command: 'exit 0', decision: 'allow', exitCode: 0 },
    { command: 'exit 1', decision: 'deny', exitCode: 1 },
    { command: 'exit 2', decision: 'ask', exitCode: 2 },
    { command: 'exit 7', decision: 'error', exitCode: 7 }
  ] as const)('maps exit code for $command', async ({ command, decision, exitCode }) => {
    const executor = new HookExecutor();
    executor.register({ event: 'SessionStart', command });

    const results = await executor.execute('SessionStart', {});
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ decision, exitCode });
  });

  it('handles timeout', async () => {
    const executor = new HookExecutor();
    executor.register({ event: 'SessionStart', command: 'sleep 1', timeout: 35 });

    const results = await executor.execute('SessionStart', {});
    expect(results).toHaveLength(1);
    expect(results[0]?.decision).toBe('error');
    expect(results[0]?.exitCode).toBe(-1);
    expect(results[0]?.stderr).toMatch(/timed out/i);
  });

  it('filters hooks using selector.toolName and selector.pattern', async () => {
    const executor = new HookExecutor();
    executor.register(
      { event: 'PreToolUse', command: 'echo foo', selector: { toolName: /foo/ } },
      { event: 'PreToolUse', command: 'echo bar', selector: { toolName: /bar/ } },
      { event: 'PreToolUse', command: 'echo pat', selector: { pattern: /"x":1/ } }
    );

    const results = await executor.execute('PreToolUse', { tool_input: { name: 'foo', params: { x: 1 } } });
    expect(results.map((r) => r.stdout.trim()).sort()).toEqual(['foo', 'pat'].sort());
  });

  it('returns no results when there are no hooks and no defaultCommand', async () => {
    const executor = new HookExecutor();
    await expect(executor.execute('SessionEnd', { session_id: 's' })).resolves.toEqual([]);
  });

  it('selector.toolName rejects payloads without a tool name', async () => {
    const executor = new HookExecutor();
    executor.register({ event: 'PreToolUse', command: 'echo should-not-run', selector: { toolName: /x/ } });

    const results = await executor.execute('PreToolUse', { session_id: 's' });
    expect(results).toEqual([]);
  });

  it('selector.pattern rejects non-matching payloads', async () => {
    const executor = new HookExecutor();
    executor.register({ event: 'UserPromptSubmit', command: 'echo should-not-run', selector: { pattern: /nope/ } });

    const results = await executor.execute('UserPromptSubmit', { user_prompt: 'hi' });
    expect(results).toEqual([]);
  });

  it('selector.pattern treats non-JSON payloads as non-matching', async () => {
    const executor = new HookExecutor();
    executor.register({ event: 'PreToolUse', command: 'echo should-not-run', selector: { pattern: /x/ } });

    const results = await executor.execute('PreToolUse', {
      tool_input: { name: 't', params: { big: BigInt(1) } }
    });
    expect(results).toEqual([]);
  });

  it('runs defaultCommand when no hook matches', async () => {
    const executor = new HookExecutor({ defaultCommand: 'echo fallback' });

    const results = await executor.execute('SessionEnd', { session_id: 's' });
    expect(results).toHaveLength(1);
    expect(results[0]?.decision).toBe('allow');
    expect(results[0]?.stdout.trim()).toBe('fallback');
  });

  it('uses defaultCommand when hook.command is empty', async () => {
    const executor = new HookExecutor({ defaultCommand: 'echo fallback' });
    executor.register({ event: 'SessionEnd', command: '' });

    const results = await executor.execute('SessionEnd', {});
    expect(results).toHaveLength(1);
    expect(results[0]?.decision).toBe('allow');
    expect(results[0]?.stdout.trim()).toBe('fallback');
  });

  it('invokes onError for failing hooks and still returns HookResult', async () => {
    const onError = vi.fn();
    const executor = new HookExecutor({ onError });
    executor.register({ event: 'SessionStart', command: 'exit 3' });

    const results = await executor.execute('SessionStart', {});
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ decision: 'error', exitCode: 3 });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe('SessionStart');
    expect(onError.mock.calls[0]?.[1]).toBeInstanceOf(Error);
  });

  it('captures stderr output', async () => {
    const executor = new HookExecutor();
    executor.register({ event: 'SessionStart', command: 'echo err 1>&2' });

    const results = await executor.execute('SessionStart', {});
    expect(results).toHaveLength(1);
    expect(results[0]?.decision).toBe('allow');
    expect(results[0]?.stderr.trim()).toBe('err');
  });

  it('timeout appends timeout message to existing stderr output', async () => {
    const executor = new HookExecutor();
    executor.register({ event: 'SessionStart', command: 'echo err 1>&2; sleep 1', timeout: 35 });

    const results = await executor.execute('SessionStart', {});
    expect(results).toHaveLength(1);
    expect(results[0]?.decision).toBe('error');
    expect(results[0]?.stderr).toMatch(/err/);
    expect(results[0]?.stderr).toMatch(/timed out/i);
  });

  it('selector.pattern matches the built payload envelope', async () => {
    const executor = new HookExecutor();
    executor.register(
      buildCatHook('UserPromptSubmit', { pattern: /"hook_event_name":"UserPromptSubmit"/ }),
      { event: 'UserPromptSubmit', command: 'echo no', selector: { pattern: /"hook_event_name":"SessionStart"/ } }
    );

    const results = await executor.execute('UserPromptSubmit', { user_prompt: 'hi' });
    expect(results).toHaveLength(1);

    const parsed = JSON.parse(results[0]?.stdout ?? '') as HookPayload;
    expect(parsed.hook_event_name).toBe('UserPromptSubmit');
    expect(parsed.user_prompt).toBe('hi');
  });

  it('selector.toolName can match tool_response.name', async () => {
    const executor = new HookExecutor();
    executor.register({ event: 'PostToolUse', command: 'echo ok', selector: { toolName: /resp/ } });

    const results = await executor.execute('PostToolUse', { tool_response: { name: 'respTool', result: { ok: true } } });
    expect(results).toHaveLength(1);
    expect(results[0]?.stdout.trim()).toBe('ok');
  });

  it('resets global regex lastIndex between matches', async () => {
    const executor = new HookExecutor();
    executor.register({ event: 'PreToolUse', command: 'echo ok', selector: { toolName: /foo/g } });

    const first = await executor.execute('PreToolUse', { tool_input: { name: 'foo', params: {} } });
    const second = await executor.execute('PreToolUse', { tool_input: { name: 'foo', params: {} } });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  it('throws when payload cannot be serialized for stdin', async () => {
    const onError = vi.fn();
    const executor = new HookExecutor({ onError });
    executor.register({ event: 'SessionStart', command: 'echo ok' });

    await expect(
      executor.execute('SessionStart', { tool_input: { name: 't', params: { big: BigInt(1) } } })
    ).rejects.toThrow(/BigInt/i);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('returns an error result when no command is available', async () => {
    const onError = vi.fn();
    const executor = new HookExecutor({ onError });
    executor.register({ event: 'SessionStart', command: '' });

    const results = await executor.execute('SessionStart', {});
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ decision: 'error', exitCode: -1 });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('falls back to default timeout when executor timeout is non-positive', async () => {
    const executor = new HookExecutor({ timeout: 0 });
    executor.register({ event: 'SessionStart', command: 'echo ok' });

    const results = await executor.execute('SessionStart', {});
    expect(results).toHaveLength(1);
    expect(results[0]?.decision).toBe('allow');
  });

  it('close kills running hooks and prevents new execution', async () => {
    const onError = vi.fn();
    const executor = new HookExecutor({ onError, timeout: 30_000 });
    executor.register({ event: 'SessionStart', command: 'sleep 1' });

    const run = executor.execute('SessionStart', {});
    await new Promise((r) => setTimeout(r, 25));
    executor.close();

    const results = await run;
    expect(results[0]?.decision).toBe('error');
    expect(onError).toHaveBeenCalled();

    await expect(executor.execute('SessionStart', {})).rejects.toThrow(/closed/i);
  });
});

describe('HookExecutor (spawn error paths)', () => {
  async function importWithSpawn(spawnImpl: unknown) {
    vi.resetModules();
    vi.doMock('node:child_process', () => ({ spawn: spawnImpl }));
    const mod = await import('../../hooks/executor.js');
    return mod.HookExecutor as typeof HookExecutor;
  }

  it('returns an error HookResult when spawn emits error', async () => {
    const spawnImpl = () => {
      const child = new EventEmitter() as any;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = vi.fn();

      queueMicrotask(() => child.emit('error', new Error('spawn failed')));
      return child;
    };

    const Executor = await importWithSpawn(spawnImpl);
    const executor = new Executor({ onError: vi.fn() });
    executor.register({ event: 'SessionStart', command: 'echo ok' });

    const results = await executor.execute('SessionStart', {});
    expect(results).toHaveLength(1);
    expect(results[0]?.decision).toBe('error');
    expect(results[0]?.stderr).toMatch(/spawn failed/i);
  });

  it('returns an error HookResult when stdin emits non-EPIPE error', async () => {
    const spawnImpl = () => {
      const child = new EventEmitter() as any;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = vi.fn();

      setTimeout(() => (child.stdin as any).emit('error', { code: 'X', message: 'stdin failed' }), 0);
      return child;
    };

    const Executor = await importWithSpawn(spawnImpl);
    const executor = new Executor({ onError: vi.fn() });
    executor.register({ event: 'SessionStart', command: 'echo ok' });

    const results = await executor.execute('SessionStart', {});
    expect(results).toHaveLength(1);
    expect(results[0]?.decision).toBe('error');
    expect(results[0]?.stderr).toMatch(/stdin failed/i);
  });

  it('ignores stdin EPIPE and resolves on close', async () => {
    const spawnImpl = () => {
      const child = new EventEmitter() as any;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = vi.fn();

      setTimeout(() => (child.stdin as any).emit('error', Object.assign(new Error('epipe'), { code: 'EPIPE' })), 0);
      setTimeout(() => child.emit('close', 0, null), 1);
      return child;
    };

    const Executor = await importWithSpawn(spawnImpl);
    const executor = new Executor({ onError: vi.fn() });
    executor.register({ event: 'SessionStart', command: 'echo ok' });

    const results = await executor.execute('SessionStart', {});
    expect(results).toHaveLength(1);
    expect(results[0]?.decision).toBe('allow');
  });

  it('handles kill throwing during timeout cleanup', async () => {
    const spawnImpl = () => {
      const child = new EventEmitter() as any;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = vi.fn(() => {
        throw new Error('kill failed');
      });
      return child;
    };

    const Executor = await importWithSpawn(spawnImpl);
    const executor = new Executor({ onError: vi.fn(), timeout: 10 });
    executor.register({ event: 'SessionStart', command: 'echo ok' });

    const results = await executor.execute('SessionStart', {});
    expect(results).toHaveLength(1);
    expect(results[0]?.decision).toBe('error');
    expect(results[0]?.stderr).toMatch(/timed out/i);
  });

  it('handles kill throwing during close cleanup', async () => {
    const spawnImpl = () => {
      const child = new EventEmitter() as any;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = vi.fn(() => {
        throw new Error('kill failed');
      });

      setTimeout(() => child.emit('close', 0, null), 5);
      return child;
    };

    const Executor = await importWithSpawn(spawnImpl);
    const executor = new Executor({ onError: vi.fn() });
    executor.register({ event: 'SessionStart', command: 'echo ok' });

    const run = executor.execute('SessionStart', {});
    executor.close();

    const results = await run;
    expect(results).toHaveLength(1);
    expect(results[0]?.decision).toBe('allow');
  });
});

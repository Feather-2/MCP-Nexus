import type { DelegateRequest, DelegateResponse } from '../../routing/types.js';
import type { MemoryStore, SubAgentExecutor } from '../../routing/delegate.js';
import { DelegateTool } from '../../routing/delegate.js';
import {
  DEFAULT_MEMORY_STORE_CONFIG,
  createRef,
  parseRef
} from '../../routing/memory/types.js';

describe('DelegateTool', () => {
  const makeExecutor = (result: { success: boolean; output: string; artifacts?: string[] }) => {
    const executor: SubAgentExecutor = {
      execute: vi.fn().mockResolvedValue(result)
    };
    return executor;
  };

  it('returns success when executor succeeds', async () => {
    const output = ['All done.', '', '- This is a sufficiently long finding line.'].join('\n');
    const executor = makeExecutor({ success: true, output, artifacts: ['file-a.txt'] });

    const tool = new DelegateTool({ executor });
    // Use 'step' mode to get findings and artifacts
    const response = await tool.delegate({ department: 'coding', task: 'do it', returnMode: 'step' });

    expect(executor.execute).toHaveBeenCalledWith('coding', 'do it', undefined);
    expect(response.status).toBe('success');
    expect(response.summary).toBe('All done.');
    expect(response.artifacts).toEqual(['file-a.txt']);
    expect(response.findings).toEqual(['This is a sufficiently long finding line.']);
    expect(response.duration).toEqual(expect.any(Number));
  });

  it('returns only summary in simple mode (default)', async () => {
    const output = ['All done.', '', '- This is a sufficiently long finding line.'].join('\n');
    const executor = makeExecutor({ success: true, output, artifacts: ['file-a.txt'] });

    const tool = new DelegateTool({ executor });
    const response = await tool.delegate({ department: 'coding', task: 'do it' });

    expect(response.status).toBe('success');
    expect(response.summary).toBe('All done.');
    // simple mode: no findings, artifacts, or memoryRef
    expect(response.findings).toBeUndefined();
    expect(response.artifacts).toBeUndefined();
  });

  it('returns partial when executor reports success:false', async () => {
    const executor = makeExecutor({ success: false, output: 'Completed some work.' });
    const tool = new DelegateTool({ executor });

    const response = await tool.delegate({ department: 'coding', task: 'try it' });

    expect(response.status).toBe('partial');
    expect(response.summary).toBe('Completed some work.');
  });

  it('returns failed when executor throws', async () => {
    const executor: SubAgentExecutor = {
      execute: vi.fn().mockRejectedValue(new Error('boom'))
    };
    const tool = new DelegateTool({ executor });

    const response = await tool.delegate({ department: 'coding', task: 'explode' });

    expect(response.status).toBe('failed');
    expect(response.summary).toContain('Delegation failed: boom');
  });

  it('times out execution and returns failed (vi.useFakeTimers)', async () => {
    vi.useFakeTimers();

    const executor: SubAgentExecutor = {
      execute: vi.fn().mockImplementation(() => new Promise(() => {}))
    };
    const tool = new DelegateTool({ executor, defaultTimeout: 10 });

    const pending = tool.delegate({ department: 'research', task: 'never resolves', timeout: 10 });
    await vi.advanceTimersByTimeAsync(11);
    const response = await pending;

    expect(response.status).toBe('failed');
    expect(response.summary).toContain('timed out after 10ms');

    vi.useRealTimers();
  });

  it('invokes onDelegate and onComplete callbacks', async () => {
    const calls: string[] = [];
    const onDelegate = vi.fn(() => calls.push('delegate'));
    const onComplete = vi.fn(() => calls.push('complete'));

    const executor = makeExecutor({ success: true, output: 'Done.' });
    const tool = new DelegateTool({ executor, onDelegate, onComplete });

    const request: DelegateRequest = { department: 'testing', task: 'run tests' };
    const response = await tool.delegate(request);

    expect(onDelegate).toHaveBeenCalledWith(request);
    expect(onComplete).toHaveBeenCalledWith(request, response);
    expect(calls).toEqual(['delegate', 'complete']);
  });

  it('summarize: uses first paragraph when available', async () => {
    const executor = makeExecutor({ success: true, output: 'First paragraph.\n\nSecond paragraph.' });
    const tool = new DelegateTool({ executor });

    const response = await tool.delegate({ department: 'docs', task: 'summarize' });

    expect(response.summary).toBe('First paragraph.');
  });

  it('summarize: truncates at sentence boundary when possible', async () => {
    // simple mode max length is 300, need to adjust test
    const output = `${'A'.repeat(200)}. ${'B'.repeat(400)}`;
    const executor = makeExecutor({ success: true, output });
    const tool = new DelegateTool({ executor });

    const response = await tool.delegate({ department: 'docs', task: 'summarize' });

    expect(response.summary.endsWith('.')).toBe(true);
    expect(response.summary.endsWith('...')).toBe(false);
    expect(response.summary).toBe(`${'A'.repeat(200)}.`);
  });

  it('summarize: appends ellipsis when no good breakpoint', async () => {
    const output = 'a'.repeat(600);
    const executor = makeExecutor({ success: true, output });
    const tool = new DelegateTool({ executor });

    const response = await tool.delegate({ department: 'docs', task: 'summarize' });

    expect(response.summary).toMatch(/\.\.\.$/);
    // simple mode max is 300
    expect(response.summary.length).toBe(303);
  });

  it('extractFindings: extracts bullets, then fills with numbered items, with length filters', async () => {
    const output = [
      '- short',
      '- This is a sufficiently long bullet finding line.',
      '1) This is a sufficiently long numbered finding line.',
      '2) Another valid numbered finding line that should be included.',
      `3) ${'x'.repeat(250)}`
    ].join('\n');

    const executor = makeExecutor({ success: true, output });
    const tool = new DelegateTool({ executor });

    // Use 'step' mode to get findings
    const response = await tool.delegate({ department: 'research', task: 'findings', returnMode: 'step' });

    expect(response.findings).toEqual([
      'This is a sufficiently long bullet finding line.',
      'This is a sufficiently long numbered finding line.',
      'Another valid numbered finding line that should be included.'
    ]);
  });

  it('stores detailed results in memory when memoryStore is provided (non-simple mode)', async () => {
    const executor = makeExecutor({ success: true, output: 'Done.' });
    const memoryStore: MemoryStore = {
      store: vi.fn().mockResolvedValue('memref-123'),
      retrieve: vi.fn()
    };

    const tool = new DelegateTool({ executor, memoryStore });
    // Use 'overview' mode to trigger memory storage
    const request: DelegateRequest = { department: 'coding', task: 'do it', memoryTier: 'L2', returnMode: 'overview' };

    const response = await tool.delegate(request);

    expect(memoryStore.store).toHaveBeenCalledOnce();
    const [key, value, tier] = (memoryStore.store as any).mock.calls[0] as [
      string,
      unknown,
      unknown
    ];
    expect(key).toMatch(/^delegate:coding:\d+$/);
    expect(tier).toBe('L2');
    expect(value).toEqual(
      expect.objectContaining({
        request,
        result: expect.objectContaining({ success: true, output: 'Done.' }),
        timestamp: expect.any(String)
      })
    );

    expect(response.memoryRef).toBe('memref-123');
  });

  it('does not store in memory when returnMode is simple', async () => {
    const executor = makeExecutor({ success: true, output: 'Done.' });
    const memoryStore: MemoryStore = {
      store: vi.fn().mockResolvedValue('memref-123'),
      retrieve: vi.fn()
    };

    const tool = new DelegateTool({ executor, memoryStore });
    const request: DelegateRequest = { department: 'coding', task: 'do it' };

    const response = await tool.delegate(request);

    expect(memoryStore.store).not.toHaveBeenCalled();
    expect(response.memoryRef).toBeUndefined();
  });

  it('getToolDefinition returns a valid schema with returnMode', () => {
    const schema = DelegateTool.getToolDefinition(['research', 'coding']);

    expect(schema).toEqual(
      expect.objectContaining({
        name: 'delegate',
        input_schema: expect.objectContaining({
          type: 'object',
          required: ['department', 'task'],
          properties: expect.objectContaining({
            department: expect.objectContaining({ enum: ['research', 'coding'] }),
            task: expect.objectContaining({ type: 'string' }),
            context: expect.objectContaining({ type: 'object' }),
            returnMode: expect.objectContaining({
              type: 'string',
              enum: ['simple', 'step', 'overview', 'details'],
              default: 'simple'
            })
          })
        })
      })
    );
  });

  it('onComplete receives a failed response on timeout', async () => {
    vi.useFakeTimers();

    const executor: SubAgentExecutor = {
      execute: vi.fn().mockImplementation(() => new Promise(() => {}))
    };
    const onCompleteSpy = vi.fn<[DelegateRequest, DelegateResponse], void>();
    const onComplete = (request: DelegateRequest, response: DelegateResponse) => {
      onCompleteSpy(request, response);
    };
    const tool = new DelegateTool({ executor, defaultTimeout: 10, onComplete });

    const pending = tool.delegate({ department: 'research', task: 'timeout', timeout: 10 });
    await vi.advanceTimersByTimeAsync(11);
    const response = await pending;

    expect(response.status).toBe('failed');
    expect(onCompleteSpy).toHaveBeenCalledWith(
      { department: 'research', task: 'timeout', timeout: 10 },
      expect.objectContaining({ status: 'failed' })
    );

    vi.useRealTimers();
  });

  it('routing/memory/types exports DEFAULT_MEMORY_STORE_CONFIG', () => {
    expect(DEFAULT_MEMORY_STORE_CONFIG).toEqual({
      l0Capacity: 100,
      l0TtlMs: 5 * 60 * 1000,
      l1Capacity: 1000,
      l2DbPath: ':memory:'
    });
  });

  it('createRef and parseRef round-trip for valid refs', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    const ref = createRef('L1', id);
    expect(ref).toBe(`mem:v1:L1:${id}`);

    expect(parseRef(ref)).toEqual({ version: 'v1', tier: 'L1', id });
  });

  it('parseRef rejects invalid formats', () => {
    expect(parseRef('mem:v1:L1')).toBeNull(); // wrong arity
    expect(parseRef('nope:v1:L1:550e8400-e29b-41d4-a716-446655440000')).toBeNull(); // scheme
    expect(parseRef('mem::L1:550e8400-e29b-41d4-a716-446655440000')).toBeNull(); // version
    expect(parseRef('mem:v1:L3:550e8400-e29b-41d4-a716-446655440000')).toBeNull(); // tier
    expect(parseRef('mem:v1:L1:not-a-uuid')).toBeNull(); // uuid
  });
});

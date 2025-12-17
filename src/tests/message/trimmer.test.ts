import {
  MessageTrimmer,
  NaiveCounter,
  type Message,
  type TokenCounter
} from '../../message/index.js';

describe('MessageTrimmer', () => {
  it('should handle empty history', () => {
    const trimmer = new MessageTrimmer(100);
    expect(trimmer.trim([])).toEqual([]);
  });

  it('should return empty when maxTokens <= 0', () => {
    const history: Message[] = [{ role: 'user', content: 'hi' }];
    expect(new MessageTrimmer(0).trim(history)).toEqual([]);
    expect(new MessageTrimmer(-1).trim(history)).toEqual([]);
  });

  it('should not trim when under budget', () => {
    const history: Message[] = [
      { role: 'system', content: 'You are helpful.' },
      {
        role: 'user',
        content: 'Hello',
        toolCalls: [{ name: 'search', arguments: { q: 'cats' } }]
      },
      { role: 'assistant', content: 'Hi!' }
    ];

    const trimmer = new MessageTrimmer(10_000);
    const trimmed = trimmer.trim(history);

    expect(trimmed).toEqual(history);
    expect(trimmed).not.toBe(history);
    expect(trimmed[0]).not.toBe(history[0]);

    // Returned history is cloned (does not alias toolCalls/arguments)
    (trimmed[1].toolCalls?.[0].arguments as any).q = 'dogs';
    expect(history[1].toolCalls?.[0].arguments.q).toBe('cats');
  });

  it('should trim oldest messages when over budget', () => {
    const counter = new NaiveCounter();
    const history: Message[] = [
      { role: 'user', content: 'old'.repeat(40) },
      { role: 'assistant', content: 'mid'.repeat(40) },
      { role: 'user', content: 'new'.repeat(40) }
    ];

    const costs = history.map((m) => counter.count(m));
    const maxTokens = costs[1] + costs[2];
    const trimmer = new MessageTrimmer(maxTokens, counter);

    expect(trimmer.trim(history)).toEqual([history[1], history[2]]);
  });

  it('should keep the newest messages', () => {
    const counter = new NaiveCounter();
    const history: Message[] = [
      { role: 'user', content: 'a'.repeat(200) },
      { role: 'assistant', content: 'b'.repeat(200) },
      { role: 'user', content: 'c'.repeat(200) }
    ];

    const newestCost = counter.count(history[2]);
    const trimmer = new MessageTrimmer(newestCost, counter);
    expect(trimmer.trim(history)).toEqual([history[2]]);
  });

  it('should use a custom TokenCounter', () => {
    const history: Message[] = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' }
    ];

    const counter: TokenCounter = {
      count: vi.fn(() => 5)
    };

    const trimmer = new MessageTrimmer(10, counter);
    const trimmed = trimmer.trim(history);

    expect(trimmed).toEqual([history[1], history[2]]);
    expect(vi.mocked(counter.count).mock.calls.length).toBeGreaterThan(0);
  });

  it('should account for toolCalls in NaiveCounter token estimate', () => {
    const counter = new NaiveCounter();

    const base: Message = { role: 'user', content: 'hi' };
    const withToolCalls: Message = {
      role: 'user',
      content: 'hi',
      toolCalls: [
        { name: 'toolA', arguments: { q: 'abcd', n: 123, ok: true } }
      ]
    };

    expect(counter.count(withToolCalls)).toBeGreaterThan(counter.count(base));
    expect(counter.count({ role: 'user', content: '' })).toBeGreaterThanOrEqual(
      1
    );
  });
});


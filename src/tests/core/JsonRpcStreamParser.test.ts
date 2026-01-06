import { JsonRpcStreamParser } from '../../core/JsonRpcStreamParser.js';

describe('JsonRpcStreamParser', () => {
  it('returns an empty list for empty chunks', () => {
    const parser = new JsonRpcStreamParser<any>();
    expect(parser.push('')).toEqual([]);
    expect(parser.push(Buffer.alloc(0))).toEqual([]);
  });

  it('frames chunk-split and concatenated messages', () => {
    const parser = new JsonRpcStreamParser<any>();

    const msg1 = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'a', params: { x: 1 } });
    const msg2 = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'b', params: { y: 2 } });

    expect(parser.push(msg1.slice(0, 10))).toEqual([]);

    const out = parser.push(msg1.slice(10) + msg2);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'a', params: { x: 1 } });
    expect(out[1]).toMatchObject({ jsonrpc: '2.0', id: 2, method: 'b', params: { y: 2 } });
  });

  it('ignores leading whitespace and unrelated output until JSON begins', () => {
    const parser = new JsonRpcStreamParser<any>();
    const msg = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ok' });
    const out = parser.push('\n  log: started\n' + msg);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 1, method: 'ok' });
  });

  it('does not split when a string contains `}{` (and handles escapes)', () => {
    const parser = new JsonRpcStreamParser<any>();

    const msg1 = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { text: 'hello}{world', escaped: '\\"}{\\\\' }
    });
    const msg2 = JSON.stringify({ jsonrpc: '2.0', id: 2, result: { ok: true } });

    const out = parser.push(msg1 + msg2);
    expect(out).toHaveLength(2);
    expect(out[0].result.text).toBe('hello}{world');
    expect(out[1].id).toBe(2);
  });

  it('frames large payloads (>64KB) across many chunks', () => {
    const parser = new JsonRpcStreamParser<any>();

    const big = 'x'.repeat(70 * 1024);
    const msg1 = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { big } });
    const msg2 = JSON.stringify({ jsonrpc: '2.0', id: 2, result: { ok: true } });
    const glued = msg1 + msg2;

    const out: any[] = [];
    const chunkSize = 1024;
    for (let i = 0; i < glued.length; i += chunkSize) {
      out.push(...parser.push(glued.slice(i, i + chunkSize)));
    }

    expect(out).toHaveLength(2);
    expect(out[0].result.big).toHaveLength(big.length);
    expect(out[1]).toMatchObject({ id: 2, result: { ok: true } });
  });

  it('drops malformed frames and continues in lenient mode', () => {
    const onError = vi.fn();
    const parser = new JsonRpcStreamParser<any>({ onError });

    const msg = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ok' });
    const out = parser.push('{ invalid json }' + msg);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'ok' });
  });

  it('throws on malformed frames in strict mode', () => {
    const parser = new JsonRpcStreamParser<any>({ throwOnParseError: true });
    expect(() => parser.push('{ invalid json }')).toThrow();
  });

  it('wraps non-Error parse throws and reports them via onError', () => {
    const originalParse = JSON.parse;
    const onError = vi.fn();
    try {
      (JSON as unknown as { parse: (text: string) => unknown }).parse = () => {
        throw 'boom';
      };
      const parser = new JsonRpcStreamParser<any>({ onError });
      const msg = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ok' });
      expect(parser.push(msg)).toEqual([]);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
    } finally {
      JSON.parse = originalParse;
    }
  });

  it('resets when maxBufferSize is exceeded', () => {
    const onError = vi.fn();
    const parser = new JsonRpcStreamParser<any>({ maxBufferSize: 16, onError });

    // Start a JSON frame but never close it; should trip maxBufferSize and reset.
    parser.push('{' + 'a'.repeat(32));

    expect(onError).toHaveBeenCalledTimes(1);

    const msg = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ok' });
    expect(parser.push(msg)).toHaveLength(1);
  });

  it('throws when maxBufferSize is exceeded in strict mode', () => {
    const parser = new JsonRpcStreamParser<any>({ maxBufferSize: 16, throwOnParseError: true });
    expect(() => parser.push('{' + 'a'.repeat(64))).toThrow();
  });
});

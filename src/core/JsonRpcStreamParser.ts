export type JsonRpcStreamParserOptions = {
  /**
   * When true, throw on JSON.parse errors for framed payloads.
   * Default: false (errors are reported via onError and the frame is dropped).
   */
  throwOnParseError?: boolean;
  /**
   * Upper bound for buffered (unframed) payload size, in characters.
   * Default: 8MB.
   */
  maxBufferSize?: number;
  /**
   * Called when a framed payload cannot be JSON.parse'd or when the buffer limit is exceeded.
   */
  onError?: (error: Error, context: { raw?: string }) => void;
};

/**
 * Incremental JSON-RPC stream parser (framing + JSON.parse).
 *
 * It frames JSON values by tracking nesting depth, while correctly handling
 * string/escape state so that sequences like `}{` inside strings do not split.
 */
export class JsonRpcStreamParser<T = unknown> {
  private depth = 0;
  private inString = false;
  private escaped = false;
  private collecting = false;
  private bufferedSize = 0;
  private parts: string[] = [];

  private readonly throwOnParseError: boolean;
  private readonly maxBufferSize: number;
  private readonly onError?: JsonRpcStreamParserOptions['onError'];

  constructor(options: JsonRpcStreamParserOptions = {}) {
    this.throwOnParseError = Boolean(options.throwOnParseError);
    this.maxBufferSize = options.maxBufferSize ?? 8 * 1024 * 1024; // chars ~ bytes for ASCII-heavy JSON
    this.onError = options.onError;
  }

  reset(): void {
    this.depth = 0;
    this.inString = false;
    this.escaped = false;
    this.collecting = false;
    this.bufferedSize = 0;
    this.parts.length = 0;
  }

  push(chunk: Buffer | string): T[] {
    const input = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (!input) return [];

    const messages: T[] = [];
    let segmentStart = 0;

    for (let i = 0; i < input.length; i++) {
      const c = input.charCodeAt(i);

      if (!this.collecting) {
        // Skip whitespace and unrelated output until a JSON value begins.
        // JSON-RPC messages are objects, but we also support arrays for robustness.
        if (c <= 0x20) continue;

        if (c === 0x7b /* { */ || c === 0x5b /* [ */) {
          this.collecting = true;
          this.depth = 1;
          this.inString = false;
          this.escaped = false;
          this.bufferedSize = 0;
          this.parts.length = 0;
          segmentStart = i;
        }
        continue;
      }

      if (this.inString) {
        if (this.escaped) {
          this.escaped = false;
          continue;
        }
        if (c === 0x5c /* \\ */) {
          this.escaped = true;
          continue;
        }
        if (c === 0x22 /* " */) {
          this.inString = false;
        }
        continue;
      }

      // Not in string
      if (c === 0x22 /* " */) {
        this.inString = true;
        continue;
      }

      if (c === 0x7b /* { */ || c === 0x5b /* [ */) {
        this.depth++;
        continue;
      }

      if (c === 0x7d /* } */ || c === 0x5d /* ] */) {
        this.depth--;
        if (this.depth !== 0) continue;

        // Completed a full JSON value.
        const part = input.slice(segmentStart, i + 1);
        this.parts.push(part);
        this.bufferedSize += part.length;
        const raw = this.parts.length === 1 ? this.parts[0] : this.parts.join('');

        this.collecting = false;
        this.bufferedSize = 0;
        this.parts.length = 0;
        segmentStart = i + 1;

        try {
          messages.push(JSON.parse(raw) as T);
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          this.onError?.(err, { raw });
          if (this.throwOnParseError) throw err;
        }
      }
    }

    if (this.collecting) {
      const part = input.slice(segmentStart);
      this.parts.push(part);
      this.bufferedSize += part.length;
      if (this.bufferedSize > this.maxBufferSize) {
        const err = new Error(`JSON-RPC frame exceeded maxBufferSize (${this.maxBufferSize} chars)`);
        this.onError?.(err, {});
        if (this.throwOnParseError) throw err;
        this.reset();
      }
    }

    return messages;
  }
}

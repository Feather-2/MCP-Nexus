import { EntropyAnalyzer, analyzeContent, shannonEntropy } from '../../../security/analyzers/EntropyAnalyzer.js';

describe('EntropyAnalyzer', () => {
  it('shannonEntropy() returns expected values', () => {
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('aaaaaa')).toBe(0);
    expect(shannonEntropy('ab')).toBeCloseTo(1, 8);
  });

  it('treats typical source code as low entropy', () => {
    const code = `
      export function add(a: number, b: number) {
        return a + b;
      }
    `;

    const result = analyzeContent(code);

    expect(result.suspicious).toBe(false);
    expect(result.highEntropyBlocks).toEqual([]);
    expect(result.averageEntropy).toBeLessThan(4.5);
  });

  it('detects high-entropy base64 payloads', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const payload = Buffer.from(bytes).toString('base64');

    const result = analyzeContent(`const payload = "${payload}";`);

    expect(result.suspicious).toBe(true);
    expect(result.averageEntropy).toBeGreaterThanOrEqual(4.5);
    const block = result.highEntropyBlocks.find((b) => b.encoding === 'base64');
    expect(block).toBeDefined();
    expect(block?.entropy).toBeGreaterThanOrEqual(4.5);
  });

  it('detects high-entropy hex payloads (including 0x prefix)', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const hex = Buffer.from(bytes).toString('hex');

    const result = analyzeContent(`const blob = "0x${hex}";`);

    expect(result.suspicious).toBe(true);
    expect(result.highEntropyBlocks.some((b) => b.encoding === 'hex')).toBe(true);
  });

  it('marks obfuscated code as suspicious', () => {
    const bytes = Uint8Array.from({ length: 128 }, (_, i) => (i * 73) % 256);
    const payload = Buffer.from(bytes).toString('base64');

    const result = analyzeContent(`eval(Buffer.from("${payload}", "base64").toString("utf8"));`);

    expect(result.suspicious).toBe(true);
    expect(result.highEntropyBlocks.some((b) => b.encoding === 'base64')).toBe(true);
  });

  it('supports unpadded base64url blocks', () => {
    const bytes = Uint8Array.from({ length: 25 }, (_, i) => i);
    const base64 = Buffer.from(bytes).toString('base64');
    const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

    const analyzer = new EntropyAnalyzer();
    const result = analyzer.analyzeContent(`const p = "${base64url}";`);

    expect(result.suspicious).toBe(true);
    expect(result.highEntropyBlocks.some((b) => b.encoding === 'base64')).toBe(true);
  });

  it('respects configurable entropy thresholds', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const payload = Buffer.from(bytes).toString('base64');

    const result = analyzeContent(`const payload = "${payload}";`, { entropyThreshold: 8.1 });

    expect(result.suspicious).toBe(false);
    expect(result.highEntropyBlocks).toEqual([]);
    expect(result.averageEntropy).toBeGreaterThan(0);
  });
});

export type EntropyEncoding = 'text' | 'base64' | 'hex';

export interface HighEntropyBlock {
  value: string;
  entropy: number;
  encoding: EntropyEncoding;
  start: number;
  end: number;
}

export interface EntropyResult {
  highEntropyBlocks: HighEntropyBlock[];
  averageEntropy: number;
  suspicious: boolean;
}

export interface EntropyAnalyzerOptions {
  entropyThreshold?: number;
  minBlockLength?: number;
  minBase64Length?: number;
  minHexLength?: number;
  maxBlocks?: number;
}

const DEFAULT_ENTROPY_THRESHOLD = 4.5;
const DEFAULT_MIN_BLOCK_LENGTH = 20;
const DEFAULT_MIN_BASE64_LENGTH = 24;
const DEFAULT_MIN_HEX_LENGTH = 32;
const DEFAULT_MAX_BLOCKS = 200;

export function shannonEntropy(str: string): number {
  if (!str) return 0;
  const counts = new Map<string, number>();
  for (const ch of str) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }

  const len = str.length;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function shannonEntropyBytes(bytes: Uint8Array): number {
  if (!bytes.length) return 0;
  const counts = new Map<number, number>();
  for (const b of bytes) {
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }

  const len = bytes.length;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function normalizeBase64(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) return null;

  const padStart = trimmed.indexOf('=');
  if (padStart !== -1) {
    const pad = trimmed.slice(padStart);
    if (!/^={1,2}$/.test(pad)) return null;
    if (trimmed.length % 4 !== 0) return null;
  }

  let normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/');
  const mod = normalized.length % 4;
  if (mod === 1) return null;
  if (mod === 2) normalized += '==';
  if (mod === 3) normalized += '=';

  return normalized;
}

function normalizeHex(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const raw = trimmed.startsWith('0x') || trimmed.startsWith('0X') ? trimmed.slice(2) : trimmed;
  if (!raw) return null;
  if (raw.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(raw)) return null;
  return raw;
}

function candidateRegex(minBlockLength: number): RegExp {
  const safeMin = Math.max(1, Math.floor(minBlockLength));
  return new RegExp(`[A-Za-z0-9+/=_-]{${safeMin},}`, 'g');
}

export class EntropyAnalyzer {
  private readonly entropyThreshold: number;
  private readonly minBlockLength: number;
  private readonly minBase64Length: number;
  private readonly minHexLength: number;
  private readonly maxBlocks: number;

  constructor(options: EntropyAnalyzerOptions = {}) {
    this.entropyThreshold = options.entropyThreshold ?? DEFAULT_ENTROPY_THRESHOLD;
    this.minBlockLength = options.minBlockLength ?? DEFAULT_MIN_BLOCK_LENGTH;
    this.minBase64Length = options.minBase64Length ?? DEFAULT_MIN_BASE64_LENGTH;
    this.minHexLength = options.minHexLength ?? DEFAULT_MIN_HEX_LENGTH;
    this.maxBlocks = options.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  }

  analyzeContent(content: string): EntropyResult {
    if (!content) {
      return { highEntropyBlocks: [], averageEntropy: 0, suspicious: false };
    }

    const highEntropyBlocks: HighEntropyBlock[] = [];
    const entropies: number[] = [];
    const re = candidateRegex(this.minBlockLength);

    for (let match = re.exec(content); match; match = re.exec(content)) {
      if (entropies.length >= this.maxBlocks) break;

      const value = match[0];
      const start = match.index;
      const end = start + value.length;

      const normalizedHex = value.length >= this.minHexLength ? normalizeHex(value) : null;
      if (normalizedHex) {
        const bytes = Buffer.from(normalizedHex, 'hex');
        const entropy = shannonEntropyBytes(bytes);
        entropies.push(entropy);
        if (entropy >= this.entropyThreshold) {
          highEntropyBlocks.push({ value, entropy, encoding: 'hex', start, end });
        }
        continue;
      }

      const normalizedBase64 = value.length >= this.minBase64Length ? normalizeBase64(value) : null;
      if (normalizedBase64) {
        const bytes = Buffer.from(normalizedBase64, 'base64');
        const entropy = shannonEntropyBytes(bytes);
        entropies.push(entropy);
        if (entropy >= this.entropyThreshold) {
          highEntropyBlocks.push({ value, entropy, encoding: 'base64', start, end });
        }
        continue;
      }

      const entropy = shannonEntropy(value);
      entropies.push(entropy);
      if (entropy >= this.entropyThreshold) {
        highEntropyBlocks.push({ value, entropy, encoding: 'text', start, end });
      }
    }

    const averageEntropy = entropies.length ? entropies.reduce((a, b) => a + b, 0) / entropies.length : 0;
    return { highEntropyBlocks, averageEntropy, suspicious: highEntropyBlocks.length > 0 };
  }
}

export function analyzeContent(content: string, options: EntropyAnalyzerOptions = {}): EntropyResult {
  return new EntropyAnalyzer(options).analyzeContent(content);
}

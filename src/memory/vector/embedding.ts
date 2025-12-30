function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // hash *= 16777619 (with 32-bit overflow)
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

function tokenize(text: string): string[] {
  const cleaned = String(text || '').toLowerCase();
  const parts = cleaned.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return parts.length ? parts : [];
}

export function embedText(text: string, dim = 128): number[] {
  const d = Math.max(8, Math.floor(dim));
  const vec = new Array<number>(d).fill(0);

  for (const tok of tokenize(text)) {
    const h = fnv1a32(tok);
    const idx = h % d;
    const sign = (h & 0x80000000) ? -1 : 1;
    vec[idx] += sign * 1;
  }

  // L2 normalize
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / norm;
  }

  return vec;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += (a[i] || 0) * (b[i] || 0);
  return dot;
}


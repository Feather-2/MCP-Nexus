export function isObject(item: unknown): item is Record<string, unknown> {
  return Boolean(item) && typeof item === 'object' && !Array.isArray(item);
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = cloneValue(v);
    }
    return out;
  }
  return value;
}

function mergeRecords(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, sourceValue] of Object.entries(source)) {
    if (sourceValue === undefined) {
      continue;
    }

    const targetValue = target[key];

    if (Array.isArray(sourceValue)) {
      target[key] = cloneValue(sourceValue);
      continue;
    }

    if (isObject(sourceValue) && isObject(targetValue)) {
      mergeRecords(targetValue, sourceValue);
      continue;
    }

    if (isObject(sourceValue)) {
      target[key] = cloneValue(sourceValue);
      continue;
    }

    target[key] = sourceValue;
  }
}

export function deepMerge<T extends object>(target: T, ...sources: Partial<T>[]): T {
  const targetRecord = target as unknown as Record<string, unknown>;

  for (const source of sources) {
    if (!source) {
      continue;
    }
    mergeRecords(targetRecord, source as unknown as Record<string, unknown>);
  }

  return target;
}

import { deepMerge, isObject } from '../../config/merge.js';

describe('merge', () => {
  it('detects plain objects', () => {
    expect(isObject({})).toBe(true);
    expect(isObject([])).toBe(false);
    expect(isObject(null)).toBe(false);
    expect(isObject('x')).toBe(false);
  });

  it('deep merges nested objects and overrides arrays', () => {
    type Obj = { a: { b?: number; c?: number }; arr: number[]; keep: boolean };
    const out = deepMerge<Obj>(
      { a: { b: 1 }, arr: [1, 2], keep: true },
      { a: { c: 2 }, arr: [3] }
    );

    expect(out).toEqual({ a: { b: 1, c: 2 }, arr: [3], keep: true });
  });

  it('ignores undefined values in sources', () => {
    type Obj = { a?: number; nested: { x?: number } };
    const out = deepMerge<Obj>({ a: 1, nested: { x: 1 } }, { a: undefined, nested: { x: undefined } });

    expect(out).toEqual({ a: 1, nested: { x: 1 } });
  });
});

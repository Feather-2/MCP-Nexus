import { CircularBuffer } from '../../utils/CircularBuffer.js';

describe('CircularBuffer', () => {
  describe('constructor', () => {
    it('throws on capacity < 1', () => {
      expect(() => new CircularBuffer(0)).toThrow(RangeError);
      expect(() => new CircularBuffer(-1)).toThrow(RangeError);
    });

    it('starts empty', () => {
      const buf = new CircularBuffer<number>(5);
      expect(buf.length).toBe(0);
      expect(buf.toArray()).toEqual([]);
    });
  });

  describe('push / toArray', () => {
    it('appends items in order', () => {
      const buf = new CircularBuffer<number>(5);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      expect(buf.toArray()).toEqual([1, 2, 3]);
      expect(buf.length).toBe(3);
    });

    it('overwrites oldest when full', () => {
      const buf = new CircularBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      buf.push(4); // evicts 1
      expect(buf.toArray()).toEqual([2, 3, 4]);
      expect(buf.length).toBe(3);
    });

    it('handles wrap-around multiple times', () => {
      const buf = new CircularBuffer<number>(2);
      for (let i = 1; i <= 7; i++) buf.push(i);
      expect(buf.toArray()).toEqual([6, 7]);
    });
  });

  describe('clear', () => {
    it('resets to empty', () => {
      const buf = new CircularBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.clear();
      expect(buf.length).toBe(0);
      expect(buf.toArray()).toEqual([]);
    });

    it('works correctly after clear and re-push', () => {
      const buf = new CircularBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.clear();
      buf.push(10);
      buf.push(20);
      expect(buf.toArray()).toEqual([10, 20]);
    });
  });

  describe('filter', () => {
    it('returns matching items in order', () => {
      const buf = new CircularBuffer<number>(5);
      for (let i = 1; i <= 5; i++) buf.push(i);
      expect(buf.filter(n => n % 2 === 0)).toEqual([2, 4]);
    });

    it('returns empty array when nothing matches', () => {
      const buf = new CircularBuffer<number>(3);
      buf.push(1);
      expect(buf.filter(n => n > 10)).toEqual([]);
    });
  });

  describe('reduce', () => {
    it('accumulates over all items', () => {
      const buf = new CircularBuffer<number>(5);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      expect(buf.reduce((sum, n) => sum + n, 0)).toBe(6);
    });

    it('returns initial value for empty buffer', () => {
      const buf = new CircularBuffer<number>(3);
      expect(buf.reduce((sum, n) => sum + n, 42)).toBe(42);
    });
  });

  describe('findLast', () => {
    it('finds from newest to oldest', () => {
      const buf = new CircularBuffer<{ id: number; done: boolean }>(5);
      buf.push({ id: 1, done: true });
      buf.push({ id: 2, done: false });
      buf.push({ id: 3, done: false });
      // findLast should return id:3 (newest match)
      const found = buf.findLast(item => !item.done);
      expect(found?.id).toBe(3);
    });

    it('returns undefined when no match', () => {
      const buf = new CircularBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      expect(buf.findLast(n => n > 10)).toBeUndefined();
    });

    it('returns undefined for empty buffer', () => {
      const buf = new CircularBuffer<number>(3);
      expect(buf.findLast(() => true)).toBeUndefined();
    });

    it('works after wrap-around', () => {
      const buf = new CircularBuffer<number>(3);
      buf.push(10);
      buf.push(20);
      buf.push(30);
      buf.push(40); // evicts 10
      // buffer is [20, 30, 40], findLast even → 40
      expect(buf.findLast(n => n % 2 === 0)).toBe(40);
    });
  });

  describe('iterator', () => {
    it('iterates in insertion order', () => {
      const buf = new CircularBuffer<string>(3);
      buf.push('a');
      buf.push('b');
      buf.push('c');
      expect([...buf]).toEqual(['a', 'b', 'c']);
    });

    it('iterates correctly after wrap-around', () => {
      const buf = new CircularBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      buf.push(4);
      buf.push(5);
      expect([...buf]).toEqual([3, 4, 5]);
    });

    it('yields nothing for empty buffer', () => {
      const buf = new CircularBuffer<number>(3);
      expect([...buf]).toEqual([]);
    });

    it('supports for-of loop', () => {
      const buf = new CircularBuffer<number>(4);
      buf.push(10);
      buf.push(20);
      const result: number[] = [];
      for (const item of buf) result.push(item);
      expect(result).toEqual([10, 20]);
    });
  });

  describe('capacity = 1', () => {
    it('always holds only the latest item', () => {
      const buf = new CircularBuffer<string>(1);
      buf.push('a');
      expect(buf.toArray()).toEqual(['a']);
      buf.push('b');
      expect(buf.toArray()).toEqual(['b']);
      expect(buf.length).toBe(1);
    });
  });
});

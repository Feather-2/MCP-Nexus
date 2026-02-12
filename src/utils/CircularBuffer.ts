/**
 * Fixed-size circular buffer that overwrites oldest entries when full.
 * Drop-in replacement for Array in bounded-history scenarios.
 */
export class CircularBuffer<T> {
  private buffer: (T | undefined)[];
  private head = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
    if (capacity < 1) throw new RangeError('CircularBuffer capacity must be >= 1');
    this.buffer = new Array(capacity);
  }

  get length(): number {
    return this.count;
  }

  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  clear(): void {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.count = 0;
  }

  /** Return items in insertion order (oldest first). */
  toArray(): T[] {
    if (this.count === 0) return [];
    const start = this.count < this.capacity ? 0 : this.head;
    const result: T[] = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      result[i] = this.buffer[(start + i) % this.capacity] as T;
    }
    return result;
  }

  filter(predicate: (item: T) => boolean): T[] {
    const result: T[] = [];
    for (const item of this) {
      if (predicate(item)) result.push(item);
    }
    return result;
  }

  reduce<U>(fn: (acc: U, item: T) => U, initial: U): U {
    let acc = initial;
    for (const item of this) acc = fn(acc, item);
    return acc;
  }

  /** Find from newest to oldest (reverse scan). */
  findLast(predicate: (item: T) => boolean): T | undefined {
    if (this.count === 0) return undefined;
    const start = (this.head - 1 + this.capacity) % this.capacity;
    for (let i = 0; i < this.count; i++) {
      const idx = (start - i + this.capacity) % this.capacity;
      const item = this.buffer[idx] as T;
      if (predicate(item)) return item;
    }
    return undefined;
  }

  *[Symbol.iterator](): Iterator<T> {
    if (this.count === 0) return;
    const start = this.count < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.count; i++) {
      yield this.buffer[(start + i) % this.capacity] as T;
    }
  }
}

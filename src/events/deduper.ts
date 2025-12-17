export class LRUDeduper {
  private readonly limit: number;
  private readonly order: Map<string, null>;

  constructor(limit: number) {
    this.limit = Math.max(1, limit);
    this.order = new Map<string, null>();
  }

  allow(id: string): boolean {
    if (!id) return true;
    if (this.order.has(id)) return false;

    this.order.set(id, null);

    if (this.order.size > this.limit) {
      const oldest = this.order.keys().next().value as string | undefined;
      if (oldest !== undefined) this.order.delete(oldest);
    }

    return true;
  }
}


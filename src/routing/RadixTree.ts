type Child<T> = {
  edge: string;
  node: RadixNode<T>;
};

class RadixNode<T> {
  // Keyed by the first character of `edge`.
  children = new Map<string, Child<T>>();
  exactValues: T[] = [];
  wildcardValues: T[] = [];
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

function normalizePattern(pattern: string): { key: string; wildcard: boolean } {
  if (pattern === '*') return { key: '', wildcard: true };
  if (pattern.endsWith('*')) return { key: pattern.slice(0, -1), wildcard: true };
  return { key: pattern, wildcard: false };
}

export class RadixTree<T> {
  private root = new RadixNode<T>();

  insert(pattern: string, value: T): void {
    const { key, wildcard } = normalizePattern(pattern);
    let node = this.root;

    if (key.length === 0) {
      (wildcard ? node.wildcardValues : node.exactValues).push(value);
      return;
    }

    let remaining = key;

    while (remaining.length > 0) {
      const firstChar = remaining[0];
      const child = node.children.get(firstChar);

      if (!child) {
        const newNode = new RadixNode<T>();
        node.children.set(firstChar, { edge: remaining, node: newNode });
        node = newNode;
        remaining = '';
        break;
      }

      const edge = child.edge;
      const shared = commonPrefixLength(edge, remaining);

      // Full edge match: keep walking down.
      if (shared === edge.length) {
        node = child.node;
        remaining = remaining.slice(shared);
        continue;
      }

      // Split the edge to create an intermediate node.
      const common = edge.slice(0, shared);
      const edgeRemainder = edge.slice(shared);
      const remainingRemainder = remaining.slice(shared);

      const intermediate = new RadixNode<T>();

      // Replace existing child with `common -> intermediate`.
      node.children.set(firstChar, { edge: common, node: intermediate });
      intermediate.children.set(edgeRemainder[0], { edge: edgeRemainder, node: child.node });

      if (remainingRemainder.length === 0) {
        node = intermediate;
        remaining = '';
        break;
      }

      const newLeaf = new RadixNode<T>();
      intermediate.children.set(remainingRemainder[0], { edge: remainingRemainder, node: newLeaf });
      node = newLeaf;
      remaining = '';
      break;
    }

    (wildcard ? node.wildcardValues : node.exactValues).push(value);
  }

  match(key: string): T[] {
    let node = this.root;
    let remaining = key;

    const results: T[] = [];
    if (node.wildcardValues.length) results.push(...node.wildcardValues);

    while (remaining.length > 0) {
      const child = node.children.get(remaining[0]);
      if (!child) break;
      if (!remaining.startsWith(child.edge)) break;

      remaining = remaining.slice(child.edge.length);
      node = child.node;
      if (node.wildcardValues.length) results.push(...node.wildcardValues);
    }

    if (remaining.length === 0 && node.exactValues.length) results.push(...node.exactValues);
    return results;
  }

  findLongestPrefix(key: string): T[] {
    let node = this.root;
    let remaining = key;
    let consumed = 0;

    let bestValues: T[] | null = node.wildcardValues.length ? node.wildcardValues : null;
    let bestDepth = bestValues ? 0 : -1;

    if (remaining.length === 0 && node.exactValues.length) {
      bestValues = node.exactValues;
      bestDepth = 0;
    }

    while (remaining.length > 0) {
      const child = node.children.get(remaining[0]);
      if (!child) break;
      if (!remaining.startsWith(child.edge)) break;

      remaining = remaining.slice(child.edge.length);
      consumed += child.edge.length;
      node = child.node;

      if (node.wildcardValues.length) {
        bestValues = node.wildcardValues;
        bestDepth = consumed;
      }
    }

    if (remaining.length === 0 && node.exactValues.length) {
      bestValues = node.exactValues;
      bestDepth = key.length;
    }

    return bestDepth >= 0 && bestValues ? [...bestValues] : [];
  }
}


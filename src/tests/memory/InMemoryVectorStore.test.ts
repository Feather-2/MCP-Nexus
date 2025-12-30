import { InMemoryVectorStore } from '../../memory/vector/index.js';

describe('InMemoryVectorStore', () => {
  it('ranks semantically similar text higher (hash embedding)', async () => {
    const store = new InMemoryVectorStore({ dim: 64 });
    const idA = await store.upsert({ text: 'hello world', metadata: { tag: 'a' } });
    const idB = await store.upsert({ text: 'goodbye world', metadata: { tag: 'b' } });

    const resHello = await store.query('hello', { topK: 2 });
    expect(resHello).toHaveLength(2);
    expect(resHello[0]?.id).toBe(idA);

    const resBye = await store.query('goodbye', { topK: 2 });
    expect(resBye).toHaveLength(2);
    expect(resBye[0]?.id).toBe(idB);
  });
});


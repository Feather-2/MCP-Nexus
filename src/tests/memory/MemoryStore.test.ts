import { InMemoryVectorStore, MemoryStore } from '../../memory/index.js';

describe('MemoryStore', () => {
  it('remembers and recalls records with metadata', async () => {
    const store = new MemoryStore(new InMemoryVectorStore({ dim: 64 }));
    const a = await store.remember({ text: 'hello world', metadata: { tag: 'a' } });
    const b = await store.remember({ text: 'goodbye world', metadata: { tag: 'b' } });

    const resHello = await store.recall('hello', { topK: 1 });
    expect(resHello).toHaveLength(1);
    expect(resHello[0]?.record.id).toBe(a.id);
    expect(resHello[0]?.record.metadata).toEqual({ tag: 'a' });

    expect(store.get(b.id)?.text).toBe('goodbye world');
    await store.forget(b.id);
    expect(store.get(b.id)).toBeUndefined();
  });
});


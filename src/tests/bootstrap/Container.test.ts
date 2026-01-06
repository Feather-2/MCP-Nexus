import { Container } from '../../bootstrap/Container.js';

describe('Container', () => {
  it('register resolves a value', () => {
    const container = new Container();
    const TOKEN = Symbol('value');
    container.register(TOKEN, 123);
    expect(container.resolve(TOKEN)).toBe(123);
  });

  it('register resolves a factory each time', () => {
    const container = new Container();
    const TOKEN = Symbol('factory');

    container.register(TOKEN, () => ({ id: Math.random() }));

    const a = container.resolve<{ id: number }>(TOKEN);
    const b = container.resolve<{ id: number }>(TOKEN);
    expect(a).not.toBe(b);
  });

  it('singleton resolves the same instance', () => {
    const container = new Container();
    const TOKEN = Symbol('singleton');
    const factory = vi.fn(() => ({ ok: true }));

    container.singleton(TOKEN, factory);

    const a = container.resolve<{ ok: boolean }>(TOKEN);
    const b = container.resolve<{ ok: boolean }>(TOKEN);
    expect(a).toBe(b);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('overriding a singleton resets cached instance', () => {
    const container = new Container();
    const TOKEN = Symbol('override');

    container.singleton(TOKEN, () => ({ v: 1 }));
    const a = container.resolve<{ v: number }>(TOKEN);
    expect(a.v).toBe(1);

    container.singleton(TOKEN, () => ({ v: 2 }));
    const b = container.resolve<{ v: number }>(TOKEN);
    expect(b.v).toBe(2);
    expect(b).not.toBe(a);
  });

  it('throws when resolving an unknown token', () => {
    const container = new Container();
    expect(() => container.resolve(Symbol('missing'))).toThrow(/no provider registered/i);
  });
});


import { isDisposable } from '../types/disposable.js';

export type Token<_T> = string | symbol;

type Factory<T> = (container: Container) => T;

type Provider<T> =
  | { kind: 'value'; value: T }
  | { kind: 'factory'; factory: Factory<T>; singleton: boolean };

export class Container {
  private readonly providers = new Map<Token<unknown>, Provider<unknown>>();
  private readonly singletonCache = new Map<Token<unknown>, unknown>();
  private readonly registrationOrder: Token<unknown>[] = [];
  private readonly resolving = new Set<Token<unknown>>();

  has<T>(token: Token<T>): boolean {
    return this.providers.has(token);
  }

  private trackOrder(token: Token<unknown>): void {
    const idx = this.registrationOrder.indexOf(token);
    if (idx !== -1) this.registrationOrder.splice(idx, 1);
    this.registrationOrder.push(token);
  }

  register<T>(token: Token<T>, valueOrFactory: T | Factory<T>): void {
    const provider: Provider<T> =
      typeof valueOrFactory === 'function'
        ? { kind: 'factory', factory: valueOrFactory as Factory<T>, singleton: false }
        : { kind: 'value', value: valueOrFactory };

    this.providers.set(token, provider);
    this.singletonCache.delete(token);
    this.trackOrder(token);
  }

  singleton<T>(token: Token<T>, valueOrFactory: T | Factory<T>): void {
    const provider: Provider<T> =
      typeof valueOrFactory === 'function'
        ? { kind: 'factory', factory: valueOrFactory as Factory<T>, singleton: true }
        : { kind: 'value', value: valueOrFactory };

    this.providers.set(token, provider);
    this.singletonCache.delete(token);
    this.trackOrder(token);
  }

  registerValue<T>(token: Token<T>, value: T): void {
    this.providers.set(token, { kind: 'value', value });
    this.singletonCache.delete(token);
    this.trackOrder(token);
  }

  registerFactory<T>(token: Token<T>, factory: Factory<T>, singleton = false): void {
    this.providers.set(token, { kind: 'factory', factory, singleton });
    this.singletonCache.delete(token);
    this.trackOrder(token);
  }

  resolve<T>(token: Token<T>): T {
    const provider = this.providers.get(token) as Provider<T> | undefined;
    if (!provider) {
      throw new Error(`Container: no provider registered for token ${String(token)}`);
    }

    if (provider.kind === 'value') {
      return provider.value;
    }

    if (provider.singleton) {
      if (this.singletonCache.has(token)) {
        return this.singletonCache.get(token) as T;
      }
      if (this.resolving.has(token)) {
        const chain = [...this.resolving].map(t => String(t)).join(' -> ');
        throw new Error(`Container: circular dependency detected: ${chain} -> ${String(token)}`);
      }
      this.resolving.add(token);
      try {
        const instance = provider.factory(this);
        this.singletonCache.set(token, instance);
        return instance;
      } finally {
        this.resolving.delete(token);
      }
    }

    return provider.factory(this);
  }

  async destroyAll(): Promise<void> {
    const tokens = [...this.registrationOrder].reverse();
    for (const token of tokens) {
      const instance = this.singletonCache.get(token) ?? this.getValueInstance(token);
      if (instance && isDisposable(instance)) {
        try {
          await instance.dispose();
        } catch { /* best-effort: shutdown must not throw */ }
      }
    }
    this.singletonCache.clear();
    this.providers.clear();
    this.registrationOrder.length = 0;
  }

  private getValueInstance(token: Token<unknown>): unknown {
    const provider = this.providers.get(token);
    return provider?.kind === 'value' ? provider.value : undefined;
  }
}

export type Token<T> = string | symbol;

type Factory<T> = (container: Container) => T;

type Provider<T> =
  | { kind: 'value'; value: T }
  | { kind: 'factory'; factory: Factory<T>; singleton: boolean };

export class Container {
  private readonly providers = new Map<Token<any>, Provider<any>>();
  private readonly singletonCache = new Map<Token<any>, any>();

  has<T>(token: Token<T>): boolean {
    return this.providers.has(token);
  }

  register<T>(token: Token<T>, valueOrFactory: T | Factory<T>): void {
    const provider: Provider<T> =
      typeof valueOrFactory === 'function'
        ? { kind: 'factory', factory: valueOrFactory as Factory<T>, singleton: false }
        : { kind: 'value', value: valueOrFactory };

    this.providers.set(token, provider);
    this.singletonCache.delete(token);
  }

  singleton<T>(token: Token<T>, valueOrFactory: T | Factory<T>): void {
    const provider: Provider<T> =
      typeof valueOrFactory === 'function'
        ? { kind: 'factory', factory: valueOrFactory as Factory<T>, singleton: true }
        : { kind: 'value', value: valueOrFactory };

    this.providers.set(token, provider);
    this.singletonCache.delete(token);
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
      const instance = provider.factory(this);
      this.singletonCache.set(token, instance);
      return instance;
    }

    return provider.factory(this);
  }
}


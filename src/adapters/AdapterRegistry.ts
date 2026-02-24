import type { TransportAdapter, McpServiceConfig, TransportType, Logger } from '../types/index.js';
import type { applyGatewaySandboxPolicy } from '../security/SandboxPolicy.js';

export interface AdapterFactoryContext {
  config: McpServiceConfig;
  logger: Logger;
  enforced: ReturnType<typeof applyGatewaySandboxPolicy>;
}

export type AdapterFactory = (context: AdapterFactoryContext) => TransportAdapter | Promise<TransportAdapter>;

export class AdapterRegistry {
  private readonly factories = new Map<TransportType, AdapterFactory>();

  register(type: TransportType, factory: AdapterFactory): void {
    if (this.factories.has(type)) {
      throw new Error(`Adapter factory already registered for transport: ${type}`);
    }
    this.factories.set(type, factory);
  }

  async create(type: TransportType, context: AdapterFactoryContext): Promise<TransportAdapter> {
    const factory = this.factories.get(type);
    if (!factory) {
      throw new Error(`Unsupported transport type: ${type}`);
    }
    return factory(context);
  }
}


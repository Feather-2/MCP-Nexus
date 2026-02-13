import { McpServiceConfig, Logger } from '../types/index.js';
import { ServiceTemplateManager } from './ServiceTemplateManager.js';
import { ServiceObservationStore } from './service-state.js';

export class TemplateRegistry {
  private templateManager: ServiceTemplateManager;

  constructor(
    private logger: Logger,
    private store: ServiceObservationStore
  ) {
    this.templateManager = new ServiceTemplateManager(logger);
    this.initializeDefaults();
  }

  private initializeDefaults(): void {
    try {
      const maybePromise = (this.templateManager as unknown as { initializeDefaults?: () => Promise<void> }).initializeDefaults?.();
      if (maybePromise && typeof maybePromise.then === 'function') {
        void maybePromise.catch((err: unknown) => this.logger.warn('Failed to initialize default templates:', err));
      }
    } catch (err) {
      this.logger.warn('Failed to initialize default templates:', err);
    }
  }

  async register(template: McpServiceConfig): Promise<void> {
    await this.templateManager.register(template);
    const stored = await this.templateManager.get(template.name).catch(() => null);
    this.store.setTemplate(stored ?? template);
    this.logger.info(`Template registered: ${template.name}`);
  }

  async get(name: string): Promise<McpServiceConfig | null> {
    const template = await this.templateManager.get(name);
    if (template) {
      this.store.setTemplate(template);
    } else {
      this.store.removeTemplate(name);
    }
    return this.store.getTemplate(name) ?? null;
  }

  async list(): Promise<McpServiceConfig[]> {
    const templates = await this.templateManager.list();
    const nextNames = new Set(templates.map((t) => t.name));
    const prevNames = new Set(this.store.listTemplates().map((t) => t.name));

    this.store.atomicUpdate((tx) => {
      for (const tpl of templates) tx.setTemplate(tpl);
      for (const name of prevNames) {
        if (!nextNames.has(name)) tx.removeTemplate(name);
      }
    });

    return this.store.listTemplates();
  }

  async remove(templateName: string): Promise<void> {
    await this.templateManager.remove(templateName);
    this.store.removeTemplate(templateName);
  }

  getManager(): ServiceTemplateManager {
    return this.templateManager;
  }
}

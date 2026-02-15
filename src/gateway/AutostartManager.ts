import type { Logger } from 'pino';
import type { InstancePersistence } from './InstancePersistence.js';

export interface AutostartDeps {
  logger: Logger;
  persistence: InstancePersistence;
  createInstance: (templateName: string, overrides?: Record<string, unknown>) => Promise<{ id: string }>;
  getTemplate: (name: string) => Promise<unknown | null>;
}

export interface AutostartResult {
  started: string[];
  failed: Array<{ templateName: string; error: string }>;
  skipped: string[];
}

export class AutostartManager {
  constructor(private readonly deps: AutostartDeps) {}

  async restoreAll(): Promise<AutostartResult> {
    const { logger, persistence, createInstance, getTemplate } = this.deps;
    const entries = persistence.getAutostartEntries();
    const result: AutostartResult = { started: [], failed: [], skipped: [] };

    if (entries.length === 0) {
      logger.info('no autostart instances to restore');
      return result;
    }

    logger.info({ count: entries.length }, 'restoring autostart instances');

    for (const entry of entries) {
      try {
        const template = await getTemplate(entry.templateName);
        if (!template) {
          logger.warn({ templateName: entry.templateName }, 'template not found, skipping autostart');
          result.skipped.push(entry.templateName);
          continue;
        }

        const instance = await createInstance(
          entry.templateName,
          entry.overrides as Record<string, unknown> | undefined,
        );
        persistence.markStarted(instance.id);
        result.started.push(instance.id);
        logger.info({ templateName: entry.templateName, serviceId: instance.id }, 'autostart instance restored');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.failed.push({ templateName: entry.templateName, error: msg });
        logger.error({ templateName: entry.templateName, err }, 'failed to restore autostart instance');
      }
    }

    logger.info(
      { started: result.started.length, failed: result.failed.length, skipped: result.skipped.length },
      'autostart restore complete',
    );
    return result;
  }
}

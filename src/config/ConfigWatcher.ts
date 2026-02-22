import { Logger } from '../types/index.js';
import { watch as watchAsync, stat } from 'fs/promises';
import { join } from 'path';
import { EventEmitter } from 'events';

type FsPromiseWatcher = AsyncIterable<{ eventType: string; filename: string | null }> & { close?: () => void };

/**
 * File system watcher for configuration and template files
 */
export class ConfigWatcher extends EventEmitter {
  private logger: Logger;
  private configWatcher?: FsPromiseWatcher;
  private templatesWatcher?: FsPromiseWatcher;
  private watchEnabled = false;

  constructor(logger: Logger) {
    super();
    this.logger = logger;
  }

  /**
   * Start watching configuration file
   */
  async watchConfigFile(configPath: string, onChange: () => void | Promise<void>): Promise<void> {
    try {
      const watcher = watchAsync(configPath, { persistent: false }) as FsPromiseWatcher;
      this.configWatcher = watcher;
      this.watchEnabled = true;
      this.logger.debug('Started watching configuration file', { path: configPath });

      (async () => {
        try {
          let debounceTimer: ReturnType<typeof setTimeout> | undefined;
          for await (const event of watcher) {
            if (!this.watchEnabled) break;
            if (event.eventType === 'change') {
              if (debounceTimer) clearTimeout(debounceTimer);
              debounceTimer = setTimeout(() => {
                debounceTimer = undefined;
                Promise.resolve(onChange()).catch((e) => {
                  this.logger.warn('Failed to handle config file change:', e);
                });
              }, 300);
            }
          }
          if (debounceTimer) clearTimeout(debounceTimer);
        } catch (e) {
          if (this.watchEnabled) {
            this.logger.warn('Failed to watch configuration file:', e);
          }
        }
      })();
    } catch (e) {
      this.logger.warn('Failed to watch configuration file:', e);
    }
  }

  /**
   * Start watching templates directory
   */
  async watchTemplatesDirectory(
    templatesPath: string,
    onTemplateChange: (filePath: string, eventType: string) => Promise<void>,
    onTemplateDelete: (name: string) => void
  ): Promise<void> {
    try {
      const watcher = watchAsync(templatesPath, { persistent: false }) as FsPromiseWatcher;
      this.templatesWatcher = watcher;
      this.logger.debug('Started watching templates directory', { path: templatesPath });

      (async () => {
        try {
          for await (const event of watcher) {
            if (!this.watchEnabled) break;
            const filename = typeof event.filename === 'string' ? event.filename : undefined;
            const eventType = event.eventType;

            if (!filename || !filename.endsWith('.json')) {
              continue;
            }

            const fullPath = join(templatesPath, filename);

            try {
              const st = await stat(fullPath).catch(() => null);
              if (st && st.isFile()) {
                await onTemplateChange(fullPath, eventType);
              } else {
                // File deleted
                const name = filename.replace(/\.json$/i, '');
                onTemplateDelete(name);
              }
            } catch (e) {
              this.logger.warn('Templates watcher processing failed', { filename, error: e });
            }
          }
        } catch (e) {
          if (this.watchEnabled) {
            this.logger.warn('Failed to watch templates directory:', e);
          }
        }
      })();
    } catch (e) {
      this.logger.warn('Unable to start templates directory watcher', e);
    }
  }

  /**
   * Stop all watchers
   */
  stopWatching(): void {
    if (!this.watchEnabled) {
      return;
    }

    this.watchEnabled = false;

    try {
      this.configWatcher?.close?.();
    } catch (e) {
      this.logger.warn('Failed to close config watcher', { error: (e as Error)?.message || String(e) });
    }
    this.configWatcher = undefined;

    try {
      this.templatesWatcher?.close?.();
    } catch (e) {
      this.logger.warn('Failed to close templates watcher', { error: (e as Error)?.message || String(e) });
    }
    this.templatesWatcher = undefined;

    this.logger.debug('Stopped watching configuration files');
    this.removeAllListeners();
  }

  /**
   * Check if watching is enabled
   */
  isWatching(): boolean {
    return this.watchEnabled;
  }
}

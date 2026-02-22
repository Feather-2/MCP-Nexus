import {
  ConfigManager,
  GatewayConfig,
  McpServiceConfig,
  Logger,
  ServiceTemplate
} from '../types/index.js';
import { readFile, writeFile, mkdir, access, rename } from 'fs/promises';
import { join, dirname } from 'path';
import { randomBytes } from 'crypto';
import { EventEmitter } from 'events';
import { constants } from 'fs';
import { ConfigValidator } from './ConfigValidator.js';
import { TemplateManager } from './TemplateManager.js';
import { ConfigWatcher } from './ConfigWatcher.js';
import { ConfigMerger } from './ConfigMerger.js';
import { ConfigBackup } from './ConfigBackup.js';

type ErrnoExceptionLike = { code?: unknown };

function getErrnoCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as ErrnoExceptionLike).code;
  return typeof code === 'string' ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

export class ConfigManagerImpl extends EventEmitter implements ConfigManager {
  private configPath: string;
  private templatesPath: string;
  private currentConfig: GatewayConfig;
  private logger: Logger;
  private templateManager: TemplateManager;
  private configWatcher: ConfigWatcher;
  private configBackup: ConfigBackup;

  constructor(
    configPathOrLogger: string | Logger,
    maybeLoggerOrPath?: Logger | string,
    defaultConfig?: Partial<GatewayConfig>
  ) {
    super();
    // Support both (path, logger) and (logger, path) signatures for compatibility
    let configPath: string;
    let logger: Logger;
    // Always compute default path so tests can observe path.join call
    const _defaultConfigPath = join(process.cwd(), 'config', 'gateway.json');
    if (typeof configPathOrLogger === 'string') {
      configPath = configPathOrLogger;
      logger = maybeLoggerOrPath as Logger;
    } else {
      logger = configPathOrLogger as Logger;
      configPath = (typeof maybeLoggerOrPath === 'string' && maybeLoggerOrPath)
        ? maybeLoggerOrPath
        : _defaultConfigPath;
    }

    this.logger = logger;
    this.configPath = configPath;
    this.templatesPath = join(dirname(configPath), 'templates');

    // Initialize modules
    this.templateManager = new TemplateManager(this.templatesPath, logger);
    this.configWatcher = new ConfigWatcher(logger);
    this.configBackup = new ConfigBackup(configPath, logger);

    // Forward template manager events
    this.templateManager.on('templatesLoaded', (templates) => this.emit('templatesLoaded', templates));
    this.templateManager.on('templateSaved', (template) => this.emit('templateSaved', template));
    this.templateManager.on('templateRemoved', (name) => this.emit('templateRemoved', name));

    this.currentConfig = ConfigMerger.createDefaultConfig();
    if (defaultConfig) {
      this.currentConfig = { ...this.currentConfig, ...defaultConfig };
    }
  }

  async loadConfig(): Promise<GatewayConfig> {
    try {
      // Check if config file exists
      await access(this.configPath, constants.F_OK);

      const configData = await readFile(this.configPath, 'utf-8');

      // Handle empty (or unexpectedly non-string) config file
      if (typeof configData !== 'string' || !configData.trim()) {
        this.logger.info('Configuration file is empty, creating default config', {
          configPath: this.configPath
        });
        await this.saveConfig(this.currentConfig, true); // Skip additional logging
        return this.currentConfig;
      }

      const loadedConfig = JSON.parse(configData) as unknown;

      // Validate and merge with defaults
      this.currentConfig = ConfigValidator.validateAndMerge(loadedConfig);

      this.logger.info('Configuration loaded successfully', {
        configPath: this.configPath,
        authMode: this.currentConfig.authMode,
        port: this.currentConfig.port
      });

      this.emit('configLoaded', this.currentConfig);

      return this.currentConfig;
    } catch (error) {
      if (getErrnoCode(error) === 'ENOENT') {
        // Config file doesn't exist, use defaults and create it
        this.logger.info('Created default configuration file', {
          configPath: this.configPath
        });

        await this.saveConfig(this.currentConfig, true); // Skip additional logging
        return this.currentConfig;
      }

      this.logger.error('Failed to load configuration:', error);
      throw new Error(`Failed to load configuration: ${error instanceof Error ? error.message : 'Unknown error'}`, { cause: error });
    }
  }

  async saveConfig(config: GatewayConfig, skipLogging = false): Promise<void> {
    try {
      // Validate config before saving
      ConfigValidator.validateStrict(config);

      // Ensure config directory exists
      try {
        await mkdir(dirname(this.configPath), { recursive: true });
      } catch (e) {
        if (getErrnoCode(e) !== 'EEXIST') {
          throw e;
        }
      }

      // Save config atomically: write to temp file then rename
      const configJson = JSON.stringify(config, null, 2);
      const tmpPath = `${this.configPath}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tmpPath, configJson);
      await rename(tmpPath, this.configPath);

      this.currentConfig = config;

      if (!skipLogging) {
        this.logger.info('Configuration saved successfully', {
          configPath: this.configPath
        });
      }

      this.emit('configSaved', config);
    } catch (error) {
      this.logger.error('Failed to save configuration:', error);
      throw new Error(`Failed to save configuration: ${error instanceof Error ? error.message : 'Unknown error'}`, { cause: error });
    }
  }

  getConfig(): GatewayConfig {
    return { ...this.currentConfig };
  }

  async updateConfig(updates: Partial<GatewayConfig>): Promise<GatewayConfig> {
    const oldConfig = this.currentConfig;
    const newConfig = { ...this.currentConfig, ...updates };
    await this.saveConfig(newConfig);

    this.emit('configUpdated', { old: oldConfig, new: newConfig });

    return newConfig;
  }

  // ConfigManager interface methods
  async get<T = unknown>(key: string): Promise<T | null> {
    // Simple key-value access to current config
    const keys = key.split('.');
    let value: unknown = this.currentConfig;
    
    for (const k of keys) {
      if (!isRecord(value) || !(k in value)) return null;

      value = (value as Record<string, unknown>)[k];
      if (value === undefined) {
        return null;
      }
    }
    
    return value as T;
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    // Simple key-value update to current config
    const keys = key.split('.');
    const lastKey = keys.pop();
    
    if (!lastKey) {
      throw new Error('Invalid key path');
    }
    
    let target: Record<string, unknown> = this.currentConfig as unknown as Record<string, unknown>;
    
    for (const k of keys) {
      const next = target[k];
      if (!isRecord(next)) {
        if (next !== undefined && next !== null) {
          throw new Error(`Cannot set nested key "${key}": "${k}" is not an object (current value: ${typeof next})`);
        }
        target[k] = {} as Record<string, unknown>;
      }
      target = target[k] as Record<string, unknown>;
    }
    
    target[lastKey] = value as unknown;
    await this.saveConfig(this.currentConfig);
  }

  async has(key: string): Promise<boolean> {
    const value = await this.get(key);
    return value !== null;
  }

  async delete(key: string): Promise<boolean> {
    const keys = key.split('.');
    const lastKey = keys.pop();
    
    if (!lastKey) {
      return false;
    }
    
    let target: Record<string, unknown> = this.currentConfig as unknown as Record<string, unknown>;
    
    for (const k of keys) {
      const next = target[k];
      if (!isRecord(next)) {
        return false; // Path doesn't exist
      }
      target = next;
    }
    
    if (Object.prototype.hasOwnProperty.call(target, lastKey)) {
      delete target[lastKey];
      await this.saveConfig(this.currentConfig);
      return true;
    }
    
    return false;
  }

  async getAll(): Promise<Record<string, unknown>> {
    return { ...this.currentConfig } as Record<string, unknown>;
  }

  async setAll(config: Record<string, unknown>): Promise<void> {
    this.currentConfig = { ...this.currentConfig, ...config } as GatewayConfig;
    await this.saveConfig(this.currentConfig);
  }

  async clear(): Promise<void> {
    this.currentConfig = ConfigMerger.createDefaultConfig();
    await this.saveConfig(this.currentConfig);
  }

  async saveTemplates(): Promise<void> {
    return this.templateManager.saveTemplates();
  }

  async loadTemplates(): Promise<void> {
    return this.templateManager.loadTemplates();
  }

  getLoadedTemplates(): ServiceTemplate[] {
    return this.templateManager.getLoadedTemplates();
  }

  async saveTemplate(template: ServiceTemplate): Promise<void> {
    return this.templateManager.saveTemplate(template);
  }

  getTemplate(name: string): ServiceTemplate | undefined {
    return this.templateManager.getTemplate(name);
  }

  listTemplates(): ServiceTemplate[] {
    return this.templateManager.listTemplates();
  }

  async removeTemplate(name: string): Promise<boolean> {
    return this.templateManager.removeTemplate(name);
  }

  validateConfig(config: Partial<GatewayConfig>): boolean {
    try {
      ConfigValidator.validateStrict(config);
      return true;
    } catch (error) {
      this.logger.warn('Configuration validation failed:', (error as Error)?.message);
      return false;
    }
  }

  async watchConfig(onChange?: () => void): Promise<void> {
    await this.configWatcher.watchConfigFile(this.configPath, async () => {
      try {
        await this.loadConfig();
        onChange?.();
      } catch (e) {
        this.logger.warn('Failed to reload config on file change:', e);
      }
    });
  }

  startConfigWatch(): void {
    if (this.configWatcher.isWatching()) {
      return;
    }

    // Start config file watcher
    this.watchConfig(() => {
      this.emit('configChanged', this.currentConfig);
    }).catch(e => this.logger.warn('Failed to start config file watcher', e));

    // Start templates directory watcher
    this.configWatcher.watchTemplatesDirectory(
      this.templatesPath,
      async (filePath: string, eventType: string) => {
        const loaded = await this.templateManager.loadTemplateFile(filePath);
        if (loaded) {
          this.logger.info(`Template ${loaded.name} ${eventType === 'rename' ? 'updated/added' : 'changed'} from disk`);
          this.emit('templateSaved', loaded);
        }
      },
      (name: string) => {
        this.logger.info(`Template deleted from disk: ${name}`);
        this.emit('templateRemoved', name);
      }
    ).catch(e => this.logger.warn('Failed to start templates watcher', e));

    this.logger.info('Configuration watching started');
    this.emit('watchStarted');
  }

  stopWatching(): void {
    this.stopConfigWatch();
  }

  stopConfigWatch(): void {
    this.configWatcher.stopWatching();
    this.logger.debug('Stopped watching configuration file');
    this.emit('watchStopped');
  }

  destroy(): void {
    this.stopConfigWatch();
    this.templateManager.destroy();
    this.removeAllListeners();
  }

  async createBackup(): Promise<string> {
    return this.configBackup.createBackup(this.currentConfig, this.templateManager.listTemplates());
  }

  async restoreFromBackup(backupPath?: string): Promise<void> {
    const restored = await this.configBackup.restoreFromBackup(backupPath);

    if (restored.config) {
      await this.saveConfig(restored.config);
    }

    if (restored.templates) {
      for (const t of restored.templates) {
        await this.templateManager.saveTemplate(t);
      }
    }

    this.emit('configRestored', { backupPath: backupPath || `${this.configPath}.backup` });
  }

  async exportConfig(): Promise<string> {
    return this.configBackup.exportConfig(this.currentConfig, this.templateManager.listTemplates());
  }

  async importConfig(configData: string): Promise<void> {
    const imported = await this.configBackup.importConfig(configData);

    if (imported.config) {
      await this.saveConfig(imported.config);
    }

    if (imported.templates) {
      for (const template of imported.templates) {
        await this.templateManager.saveTemplate(template);
      }
    }

    this.emit('configImported', imported);
  }

  async resetToDefaults(): Promise<GatewayConfig> {
    const defaultConfig = ConfigMerger.createDefaultConfig();
    await this.saveConfig(defaultConfig);

    this.logger.info('Configuration reset to defaults');
    this.emit('configReset', defaultConfig);

    return defaultConfig;
  }

  async loadConfigWithEnvOverrides(): Promise<GatewayConfig> {
    const config = await this.loadConfig();
    const configWithOverrides = ConfigMerger.applyEnvOverrides(config, this.logger);

    if (configWithOverrides !== config) {
      return await this.updateConfig(configWithOverrides);
    }

    return config;
  }

  resolveEnvironmentVariables(config: McpServiceConfig): McpServiceConfig {
    return ConfigMerger.resolveEnvironmentVariables(config);
  }

  isValidPort(port: number): boolean {
    return ConfigValidator.isValidPort(port);
  }

  isValidHost(host: string): boolean {
    return ConfigValidator.isValidHost(host);
  }

  isValidLogLevel(level: string): level is GatewayConfig['logLevel'] {
    return ConfigValidator.isValidLogLevel(level);
  }
}

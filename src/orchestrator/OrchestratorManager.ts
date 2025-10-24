import { promises as fs } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import { Logger, OrchestratorConfig, OrchestratorConfigSchema } from '../types/index.js';

const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = OrchestratorConfigSchema.parse({});

type OrchestratorStatus = {
  enabled: boolean;
  mode: OrchestratorConfig['mode'];
  subagentsDir: string;
  reason?: string;
};

export class OrchestratorManager {
  private readonly configPath: string;
  private readonly logger: Logger;
  private currentConfig: OrchestratorConfig = DEFAULT_ORCHESTRATOR_CONFIG;

  constructor(baseConfigPath: string, logger: Logger) {
    this.logger = logger;
    this.configPath = join(dirname(baseConfigPath), 'orchestrator.json');
  }

  async loadConfig(): Promise<OrchestratorConfig> {
    try {
      const raw = await fs.readFile(this.configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      this.currentConfig = OrchestratorConfigSchema.parse(parsed);
      this.logger.info('Orchestrator configuration loaded', {
        enabled: this.currentConfig.enabled,
        mode: this.currentConfig.mode,
        subagentsDir: this.resolveSubagentsDir()
      });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        this.logger.info('Orchestrator configuration not found, fallback to defaults', {
          configPath: this.configPath
        });
        this.currentConfig = this.cloneDefault();
        await this.saveConfig(this.currentConfig, true);
      } else if (err instanceof SyntaxError) {
        this.logger.warn('Failed to parse orchestrator configuration, using defaults', {
          error: err.message
        });
        this.currentConfig = this.cloneDefault();
      } else {
        this.logger.warn('Failed to load orchestrator configuration, using defaults', {
          error: err?.message ?? 'unknown'
        });
        this.currentConfig = this.cloneDefault();
      }
    }

    return this.currentConfig;
  }

  getConfig(): OrchestratorConfig {
    return JSON.parse(JSON.stringify(this.currentConfig)) as OrchestratorConfig;
  }

  getStatus(): OrchestratorStatus {
    if (!this.currentConfig.enabled) {
      return {
        enabled: false,
        mode: this.currentConfig.mode,
        subagentsDir: this.resolveSubagentsDir(),
        reason: 'orchestrator disabled via configuration'
      };
    }

    return {
      enabled: true,
      mode: this.currentConfig.mode,
      subagentsDir: this.resolveSubagentsDir()
    };
  }

  isEnabled(): boolean {
    return Boolean(this.currentConfig.enabled);
  }

  async updateConfig(partial: Partial<OrchestratorConfig>): Promise<OrchestratorConfig> {
    const merged = this.deepMerge(this.currentConfig, partial);
    const validated = OrchestratorConfigSchema.parse(merged);
    await this.saveConfig(validated);
    this.currentConfig = validated;
    return this.getConfig();
  }

  private async saveConfig(config: OrchestratorConfig, skipLog = false): Promise<void> {
    try {
      await fs.mkdir(dirname(this.configPath), { recursive: true });
    } catch (error) {
      // ignore directory exists or mock without promise
    }
    await fs.writeFile(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
    if (!skipLog) {
      this.logger.info('Orchestrator configuration saved', {
        enabled: config.enabled,
        mode: config.mode
      });
    }
  }

  private deepMerge<T>(target: T, source: Partial<T>): T {
    if (!source) return target;
    const output: any = Array.isArray(target) ? [...(target as any)] : { ...(target as any) };
    for (const key of Object.keys(source) as Array<keyof T>) {
      const srcVal = (source as any)[key];
      if (srcVal === undefined) continue;
      const tgtVal = (output as any)[key];
      if (srcVal && typeof srcVal === 'object' && !Array.isArray(srcVal)) {
        output[key] = this.deepMerge(tgtVal ?? {}, srcVal);
      } else {
        output[key] = srcVal;
      }
    }
    return output;
  }

  private resolveSubagentsDir(): string {
    const configured = this.currentConfig.subagentsDir || DEFAULT_ORCHESTRATOR_CONFIG.subagentsDir;
    if (isAbsolute(configured)) {
      return configured;
    }
    return join(dirname(this.configPath), configured);
  }

  private cloneDefault(): OrchestratorConfig {
    return JSON.parse(JSON.stringify(DEFAULT_ORCHESTRATOR_CONFIG)) as OrchestratorConfig;
  }
}

export type { OrchestratorStatus };

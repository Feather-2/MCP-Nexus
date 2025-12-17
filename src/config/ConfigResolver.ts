import { readFile } from 'fs/promises';
import { GatewayConfig, GatewayConfigSchema } from '../types/index.js';
import { deepMerge, isObject } from './merge.js';

export interface ConfigLayer {
  name: string;
  priority: number;
  config: Partial<GatewayConfig>;
}

type InternalLayer = ConfigLayer & { index: number };

export class ConfigResolver {
  private layers: InternalLayer[] = [];
  private nextIndex = 0;

  addLayer(layer: ConfigLayer): void {
    this.layers.push({ ...layer, index: this.nextIndex });
    this.nextIndex += 1;
  }

  resolve(): GatewayConfig {
    const ordered = [...this.layers].sort((a, b) => {
      const byPriority = a.priority - b.priority;
      return byPriority !== 0 ? byPriority : a.index - b.index;
    });

    const merged = deepMerge(
      {} as Partial<GatewayConfig>,
      ...ordered.map((l) => l.config)
    );

    return GatewayConfigSchema.parse(merged);
  }

  static loadDefault(): Partial<GatewayConfig> {
    return GatewayConfigSchema.parse({});
  }

  static async loadFromFile(path: string): Promise<Partial<GatewayConfig> | null> {
    try {
      const data = await readFile(path, 'utf-8');
      if (!data.trim()) {
        return null;
      }

      const parsed: unknown = JSON.parse(data);
      if (!isObject(parsed)) {
        throw new Error(`Invalid config JSON at ${path}: expected an object`);
      }

      return parsed as Partial<GatewayConfig>;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  static loadFromEnv(): Partial<GatewayConfig> {
    const out: Partial<GatewayConfig> = {};

    const envHost = process.env.PBMCP_HOST || process.env.PB_GATEWAY_HOST;
    if (envHost) {
      out.host = envHost;
    }

    const envPort = process.env.PBMCP_PORT || process.env.PB_GATEWAY_PORT;
    if (envPort) {
      const port = Number.parseInt(envPort, 10);
      if (Number.isInteger(port) && port >= 1 && port <= 65535) {
        out.port = port;
      }
    }

    const envAuth = process.env.PBMCP_AUTH_MODE || process.env.PB_GATEWAY_AUTH_MODE;
    if (envAuth === 'local-trusted' || envAuth === 'external-secure' || envAuth === 'dual') {
      out.authMode = envAuth;
    }

    const envLevel = process.env.PBMCP_LOG_LEVEL || process.env.PB_GATEWAY_LOG_LEVEL;
    if (
      envLevel === 'trace' ||
      envLevel === 'debug' ||
      envLevel === 'info' ||
      envLevel === 'warn' ||
      envLevel === 'error'
    ) {
      out.logLevel = envLevel;
    }

    return out;
  }
}


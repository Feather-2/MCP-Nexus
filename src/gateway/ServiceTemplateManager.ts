import { McpServiceConfig, Logger } from '../types/index.js';
import { McpServiceConfigSchema } from '../types/index.js';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';

export class ServiceTemplateManager {
  private templates = new Map<string, McpServiceConfig>();
  private templatesDir: string;
  private removedTemplates = new Set<string>();

  constructor(private logger: Logger) {
    // Prefer explicit env override for unifying directories with ConfigManager
    const envDir = process.env.PB_TEMPLATES_DIR;
    if (envDir && envDir.trim()) {
      this.templatesDir = path.isAbsolute(envDir) ? envDir : path.resolve(process.cwd(), envDir);
    } else {
      this.templatesDir = path.join(process.cwd(), 'templates');
      // If config/templates exists, prefer it to reduce duplication
      try {
        const cfgDir = path.join(process.cwd(), 'config', 'templates');
        if (fsSync.existsSync(cfgDir)) {
          this.templatesDir = cfgDir;
        }
      } catch {}
    }
    this.initializeTemplatesDir();
  }

  private async initializeTemplatesDir(): Promise<void> {
    try {
      await fs.mkdir(this.templatesDir, { recursive: true });
    } catch (error) {
      this.logger.error('Failed to create templates directory:', error);
    }
  }

  async register(template: McpServiceConfig): Promise<void> {
    // Validate template
    const validatedTemplate = McpServiceConfigSchema.parse(template);

    // Store in memory
    // 修复占位符路径（filesystem）
    if (validatedTemplate.name === 'filesystem' && validatedTemplate.transport === 'stdio' && Array.isArray(validatedTemplate.args)) {
      const defaultDir = process.platform === 'win32' ? 'C:/Users/Public' : '/tmp';
      const args = [...validatedTemplate.args];
      const pkgIndex = args.findIndex(a => typeof a === 'string' && a.includes('@modelcontextprotocol/server-filesystem'));
      if (pkgIndex >= 0) {
        const nextIdx = pkgIndex + 1;
        if (args[nextIdx] == null) {
          args.push(defaultDir);
        } else if (typeof args[nextIdx] === 'string' && (args[nextIdx] as string).includes('${ALLOWED_DIRECTORY}')) {
          args[nextIdx] = defaultDir;
        }
      }
      for (let i = 0; i < args.length; i++) {
        if (typeof args[i] === 'string' && (args[i] as string).includes('${ALLOWED_DIRECTORY}')) {
          args[i] = (args[i] as string).replace('${ALLOWED_DIRECTORY}', defaultDir);
        }
      }
      validatedTemplate.args = args as string[];
    }
    this.templates.set(validatedTemplate.name, validatedTemplate);
    this.removedTemplates.delete(validatedTemplate.name);

    // Persist to disk
    const templatePath = path.join(this.templatesDir, `${validatedTemplate.name}.json`);
    await fs.writeFile(templatePath, JSON.stringify(validatedTemplate, null, 2));

    this.logger.debug(`Template registered: ${validatedTemplate.name}`);
  }

  async get(name: string): Promise<McpServiceConfig | null> {
    // Try memory first
    if (this.removedTemplates.has(name)) return null;
    let template = this.templates.get(name);

    if (!template) {
      // Try loading from disk
      const diskTemplate = await this.loadFromDisk(name);
      if (diskTemplate) {
        this.templates.set(name, diskTemplate);
        template = diskTemplate;
        this.logger.debug(`Template loaded from disk: ${name}`);
      }
    }

    return template || null;
  }

  async list(): Promise<McpServiceConfig[]> {
    // Load all templates from disk to ensure we have the latest
    await this.loadAllFromDisk();

    // Deduplicate: memory templates take precedence over disk ones
    const uniqueTemplates = new Map<string, McpServiceConfig>();

    // First add all templates from memory/disk (loadAllFromDisk already merged them)
    for (const [name, template] of this.templates) {
      uniqueTemplates.set(name, template);
    }

    return Array.from(uniqueTemplates.values());
  }

  async remove(name: string): Promise<void> {
    // Remove from memory
    this.templates.delete(name);
    this.removedTemplates.add(name);

    // Remove from disk
    const templatePath = path.join(this.templatesDir, `${name}.json`);
    try {
      await fs.unlink(templatePath);
    } catch (error) {
      // File might not exist, which is fine
      this.logger.warn(`Failed to delete template file for ${name}:`, error);
    }

    this.logger.debug(`Template removed: ${name}`);
  }

  async update(name: string, updates: Partial<McpServiceConfig>): Promise<void> {
    const existing = await this.get(name);
    if (!existing) {
      throw new Error(`Template ${name} not found`);
    }

    const updated = { ...existing, ...updates };
    await this.register(updated);
  }

  private async loadFromDisk(name: string): Promise<McpServiceConfig | null> {
    const templatePath = path.join(this.templatesDir, `${name}.json`);

    try {
      const content = await fs.readFile(templatePath, 'utf-8');
      const template = JSON.parse(content);
      return McpServiceConfigSchema.parse(template);
    } catch (error) {
      if (error instanceof SyntaxError) {
        this.logger.warn(`Failed to parse template ${name}:`, error);
      } else {
        this.logger.debug(`Failed to load template ${name} from disk:`, error);
      }
      return null;
    }
  }

  private async loadAllFromDisk(): Promise<void> {
    try {
      const files = await fs.readdir(this.templatesDir);

      for (const file of files) {
        const name = file.endsWith('.json') ? file.replace(/\.json$/,'') : file;
        // Skip non-JSON files
        if (!file.endsWith('.json')) {
          this.logger.debug(`Skipping non-JSON file: ${file}`);
          continue;
        }
        const template = await this.loadFromDisk(name);
        if (template) {
          // Memory templates take precedence
          if (!this.templates.has(name)) {
            this.templates.set(name, template);
          }
        }
      }
    } catch (error) {
      this.logger.warn('Failed to read templates directory:', error);
    }
  }

  // Predefined templates for common MCP services (only keep local, runnable defaults)
  async initializeDefaults(): Promise<void> {
    // If any templates already exist on disk, skip initialization (per tests)
    try {
      const files = await fs.readdir(this.templatesDir);
      const jsonFiles = (files || []).filter(f => f.endsWith('.json'));
      if (jsonFiles && jsonFiles.length > 0) {
        this.logger.info('Default templates already exist, skipping initialization');
        return;
      }
    } catch {}

    const defaultTemplates: McpServiceConfig[] = [
      {
        name: 'filesystem',
        version: '2024-11-26',
        transport: 'stdio',
        command: 'npm',
        args: process.platform === 'win32'
          ? ['exec', '-y', '@modelcontextprotocol/server-filesystem', 'C:/Users/Public']
          : ['exec', '@modelcontextprotocol/server-filesystem', '/tmp'],
        env: { SANDBOX: 'portable' },
        timeout: 30000,
        retries: 3
      },
      {
        name: 'brave-search',
        version: '2024-11-26',
        transport: 'stdio',
        command: 'npm',
        args: process.platform === 'win32' ? ['exec', '-y', '@modelcontextprotocol/server-brave-search'] : ['exec', '@modelcontextprotocol/server-brave-search'],
        env: { SANDBOX: 'portable' },
        timeout: 30000,
        retries: 3
      },
      {
        name: 'github',
        version: '2024-11-26',
        transport: 'stdio',
        command: 'npm',
        args: process.platform === 'win32' ? ['exec', '-y', '@modelcontextprotocol/server-github'] : ['exec', '@modelcontextprotocol/server-github'],
        env: { SANDBOX: 'portable' },
        timeout: 30000,
        retries: 3
      }
      ,
      // 一个可交互且常驻的容器模板，便于控制台/健康检查
      {
        name: 'node-stdio-container',
        version: '2024-11-26',
        transport: 'stdio',
        command: 'node',
        args: ['-e', "console.log(JSON.stringify({jsonrpc:'2.0',id:'init',result:{tools:[]}})) && setInterval(()=>{}, 1<<30)"],
        env: { SANDBOX: 'container' },
        // 由容器适配器接管命令，把以下镜像/只读根等转为 docker run ...
        // 注意：这只是默认模板，运行需本机有 docker/podman
        // @ts-ignore
        container: { image: 'node:20-alpine', readonlyRootfs: true },
        timeout: 30000,
        retries: 3
      }
    ];

    for (const template of defaultTemplates) {
      try {
        await this.register(template);
      } catch (error) {
        this.logger.warn(`Failed to register default template ${template.name}:`, error);
      }
    }
    this.logger.info('Default templates initialized');
  }

  async validateTemplate(template: McpServiceConfig): Promise<{ valid: boolean; errors: string[] }> {
    try {
      McpServiceConfigSchema.parse(template);

      // Additional validation
      const errors: string[] = [];

      if (template.transport === 'stdio' && !template.command) {
        errors.push('Command is required for stdio transport');
      }

      if (template.timeout && template.timeout < 1000) {
        errors.push('Timeout should be at least 1000ms');
      }

      return { valid: errors.length === 0, errors };
    } catch (error) {
      return {
        valid: false,
        errors: error instanceof Error ? [error.message] : ['Invalid template']
      };
    }
  }
}

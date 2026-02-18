import { ServiceTemplate, Logger } from '../types/index.js';
import { readFile, writeFile, mkdir, readdir, unlink } from 'fs/promises';
import { join } from 'path';
import { EventEmitter } from 'events';

type ErrnoExceptionLike = { code?: unknown };

function getErrnoCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as ErrnoExceptionLike).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Template management for MCP service templates
 */
export class TemplateManager extends EventEmitter {
  private templates: Map<string, ServiceTemplate> = new Map();
  private templatesPath: string;
  private logger: Logger;

  constructor(templatesPath: string, logger: Logger) {
    super();
    this.templatesPath = templatesPath;
    this.logger = logger;
  }

  /**
   * Load all templates (built-in + custom from disk)
   */
  async loadTemplates(): Promise<void> {
    try {
      await mkdir(this.templatesPath, { recursive: true });

      this.loadBuiltInTemplates();

      const count = await this.loadTemplatesFromDirectory(this.templatesPath);

      const templates = Array.from(this.templates.values());

      this.logger.info(`Loaded ${templates.length} service templates (${count} from disk, ${templates.length - count} built-in or previously loaded)`);
      this.emit('templatesLoaded', templates);
    } catch (error) {
      this.logger.error('Failed to load templates:', error);
      throw new Error(`Failed to load templates: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Save all templates to individual files
   */
  async saveTemplates(): Promise<void> {
    await mkdir(this.templatesPath, { recursive: true });

    for (const [name, template] of this.templates.entries()) {
      const safeName = this.sanitizeFilename(name);
      const templatePath = join(this.templatesPath, `${safeName}.json`);
      const templateJson = JSON.stringify(template, null, 2);
      await writeFile(templatePath, templateJson);
    }

    this.logger.info(`Saved ${this.templates.size} templates to filesystem`);
  }

  /**
   * Save a single template
   */
  async saveTemplate(template: ServiceTemplate): Promise<void> {
    try {
      this.validateTemplate(template);

      this.templates.set(template.name, template);

      const safeName = this.sanitizeFilename(template.name);
      const templatePath = join(this.templatesPath, `${safeName}.json`);
      const templateJson = JSON.stringify(template, null, 2);
      await writeFile(templatePath, templateJson);

      this.logger.info(`Template saved: ${template.name}`, { templatePath });

      this.emit('templateSaved', template);
    } catch (error) {
      this.logger.error('Failed to save template:', error);
      throw new Error(`Failed to save template: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get a template by name
   */
  getTemplate(name: string): ServiceTemplate | undefined {
    return this.templates.get(name);
  }

  /**
   * List all templates
   */
  listTemplates(): ServiceTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * Get loaded templates (alias for listTemplates)
   */
  getLoadedTemplates(): ServiceTemplate[] {
    return this.listTemplates();
  }

  /**
   * Remove a template
   */
  async removeTemplate(name: string): Promise<boolean> {
    if (!this.templates.has(name)) {
      return false;
    }

    this.templates.delete(name);

    try {
      const safeName = this.sanitizeFilename(name);
      const templatePath = join(this.templatesPath, `${safeName}.json`);
      await unlink(templatePath);
      this.logger.debug(`Template file removed: ${templatePath}`);
    } catch (e) {
      if (getErrnoCode(e) !== 'ENOENT') {
        this.logger.warn('Failed to remove template file from filesystem', { name, error: e });
      }
    }

    this.logger.info(`Template removed: ${name}`);
    this.emit('templateRemoved', name);

    return true;
  }

  /**
   * Load a single template file
   */
  async loadTemplateFile(filePath: string): Promise<ServiceTemplate | null> {
    try {
      const data = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(data) as ServiceTemplate;
      this.validateTemplate(parsed);
      const exists = this.templates.has(parsed.name);
      this.templates.set(parsed.name, parsed);
      this.logger.debug(`${exists ? 'Updated' : 'Loaded'} template from file`, { name: parsed.name, filePath });
      return parsed;
    } catch (e) {
      this.logger.warn('Failed to load template file', { filePath, error: e });
      return null;
    }
  }

  /**
   * Validate template structure
   */
  private validateTemplate(template: ServiceTemplate): void {
    const errors: string[] = [];

    if (!template.name || typeof template.name !== 'string') {
      errors.push('Template name is required and must be a string');
    }

    if (!template.version || typeof template.version !== 'string') {
      errors.push('Template version is required and must be a string');
    }

    if (!template.transport) {
      errors.push('Template transport is required');
    }

    if (template.transport === 'stdio' && !template.command) {
      errors.push('Command is required for stdio transport');
    }

    if (errors.length > 0) {
      throw new Error(`Template validation failed: ${errors.join(', ')}`);
    }
  }

  /**
   * Sanitize filename for safe filesystem operations
   */
  private sanitizeFilename(name: string): string {
    const sanitized = String(name)
      .replace(/[^a-zA-Z0-9._-]/g, '')
      .replace(/\.+/g, '.')
      .replace(/\.\.+/g, '.')
      .slice(0, 200);
    if (!sanitized) {
      const { createHash } = require('crypto');
      return (createHash('sha256') as import('crypto').Hash).update(name).digest('hex').slice(0, 32);
    }
    return sanitized;
  }

  /**
   * Load built-in service templates
   */
  private loadBuiltInTemplates(): void {
    const builtInTemplates: ServiceTemplate[] = [
      {
        name: 'filesystem',
        version: '2024-11-26',
        transport: 'stdio',
        command: 'npx',
        args: ['@modelcontextprotocol/server-filesystem', '${ALLOWED_DIRECTORY}'],
        env: {
          ALLOWED_DIRECTORY: '/tmp'
        },
        timeout: 30000,
        retries: 3,
        description: 'File system access MCP server',
        capabilities: ['read_files', 'write_files', 'list_directories'],
        tags: ['filesystem', 'files', 'local']
      },
      {
        name: 'brave-search',
        version: '2024-11-26',
        transport: 'stdio',
        command: 'npx',
        args: ['@modelcontextprotocol/server-brave-search'],
        env: {
          BRAVE_API_KEY: '${BRAVE_API_KEY}'
        },
        timeout: 45000,
        retries: 2,
        description: 'Brave Search API integration',
        capabilities: ['web_search', 'search_results'],
        tags: ['search', 'web', 'api']
      },
      {
        name: 'github',
        version: '2024-11-26',
        transport: 'stdio',
        command: 'npx',
        args: ['@modelcontextprotocol/server-github'],
        env: {
          GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}'
        },
        timeout: 60000,
        retries: 3,
        description: 'GitHub API integration',
        capabilities: ['repository_access', 'issue_management', 'code_search'],
        tags: ['github', 'git', 'api', 'repository']
      },
      {
        name: 'sqlite',
        version: '2024-11-26',
        transport: 'stdio',
        command: 'npx',
        args: ['@modelcontextprotocol/server-sqlite', '${DATABASE_PATH}'],
        env: {
          DATABASE_PATH: 'database.db'
        },
        timeout: 30000,
        retries: 3,
        description: 'SQLite database access',
        capabilities: ['database_query', 'database_write', 'schema_access'],
        tags: ['database', 'sqlite', 'sql']
      },
      {
        name: 'memory',
        version: '2024-11-26',
        transport: 'stdio',
        command: 'npx',
        args: ['@modelcontextprotocol/server-memory'],
        timeout: 15000,
        retries: 2,
        description: 'In-memory storage for conversations',
        capabilities: ['memory_storage', 'context_retention'],
        tags: ['memory', 'storage', 'context']
      }
    ];

    for (const template of builtInTemplates) {
      this.templates.set(template.name, template);
    }

    this.logger.debug(`Loaded ${builtInTemplates.length} built-in templates`);
  }

  /**
   * Load templates from a directory
   */
  private async loadTemplatesFromDirectory(dir: string): Promise<number> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      let loaded = 0;
      for (const ent of entries) {
        if (ent.isFile() && ent.name.endsWith('.json')) {
          const filePath = join(dir, ent.name);
          const t = await this.loadTemplateFile(filePath);
          if (t) loaded++;
        }
      }
      return loaded;
    } catch (e) {
      this.logger.warn('Failed to scan templates directory', { dir, error: e });
      return 0;
    }
  }
}

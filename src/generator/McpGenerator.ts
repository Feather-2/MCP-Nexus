import type {
  Logger,
  GenerateRequest,
  GenerateResponse,
  ExportRequest,
  ExportResponse,
  ImportRequest,
  ImportResponse,
  ParseResult,
  McpServiceConfig,
  McpToolSchema,
  ValidationResult,
  GeneratorSourceType
} from '../types/index.js';
import { ServiceTemplateManager } from '../gateway/ServiceTemplateManager.js';
import { ServiceRegistryImpl } from '../gateway/ServiceRegistryImpl.js';
import { MarkdownParser } from './parsers/MarkdownParser.js';
import { BaseParser } from './parsers/BaseParser.js';
import { TextParser } from './parsers/TextParser.js';
import { OpenApiParser } from './parsers/OpenApiParser.js';
import { AdapterGenerator } from './AdapterGenerator.js';
import { promises as fs } from 'fs';
import { join } from 'path';

/**
 * MCP Generator
 * Main orchestrator for generating MCP services from various sources
 */
export class McpGenerator {
  private logger: Logger;
  private templateManager: ServiceTemplateManager;
  private registry: ServiceRegistryImpl;
  private parsers: Map<GeneratorSourceType, BaseParser>;
  private adapterGenerator: AdapterGenerator;
  private exportDir: string;

  constructor(opts: {
    logger: Logger;
    templateManager: ServiceTemplateManager;
    registry: ServiceRegistryImpl;
    exportDir?: string;
  }) {
    this.logger = opts.logger;
    this.templateManager = opts.templateManager;
    this.registry = opts.registry;
    this.exportDir = opts.exportDir || join(process.cwd(), 'generated');
    this.adapterGenerator = new AdapterGenerator(this.logger);

    // Initialize parsers
    this.parsers = new Map();
    this.parsers.set('markdown', new MarkdownParser(this.logger));
    this.parsers.set('openapi', new OpenApiParser(this.logger));
    this.parsers.set('text', new TextParser(this.logger));
    // TODO: Add more parsers (Curl, JavaScript, Python, etc.)

    this.ensureExportDir();
  }

  private async ensureExportDir(): Promise<void> {
    try {
      await fs.mkdir(this.exportDir, { recursive: true });
    } catch (error) {
      this.logger.warn('Failed to create export directory', { error });
    }
  }

  /**
   * Generate MCP service from input
   */
  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    try {
      this.logger.info('Generating MCP service', {
        sourceType: request.source.type,
        name: request.options?.name
      });

      // 1. Get content
      const content = await this.getContent(request.source);

      // 2. Select parser
      const parser = this.selectParser(request.source.type, content);
      if (!parser) {
        return {
          success: false,
          error: `No parser available for source type: ${request.source.type}`
        };
      }

      // 3. Parse content
      const parseResult = await parser.parse(content);

      // 4. Generate adapter
      const { config, tools } = await this.adapterGenerator.generate(parseResult, {
        name: request.options?.name,
        transport: request.options?.transport || 'auto'
      });

      // 5. Validate
      const validation = await this.validate(config, tools);

      // 6. Dry-run if requested
      let dryRun: GenerateResponse['dryRun'];
      if (request.options?.testMode) {
        dryRun = await this.performDryRun(config, parseResult, request.auth);
      }

      // 7. Register if requested
      let registered = false;
      let serviceId: string | undefined;

      if (request.options?.autoRegister && validation.valid) {
        try {
          await this.templateManager.register(config);
          registered = true;
          this.logger.info(`Template registered: ${config.name}`);
        } catch (error: any) {
          this.logger.warn(`Failed to register template: ${error.message}`);
        }
      }

      return {
        success: true,
        template: {
          name: config.name,
          config,
          tools
        },
        validation,
        dryRun,
        registered,
        serviceId
      };

    } catch (error: any) {
      this.logger.error('Failed to generate MCP service', { error: error.message });
      return {
        success: false,
        error: error.message || 'Unknown error'
      };
    }
  }

  /**
   * Export template in various formats
   */
  async export(request: ExportRequest): Promise<ExportResponse> {
    try {
      const template = await this.templateManager.get(request.templateName);
      if (!template) {
        return {
          success: false,
          format: request.format,
          error: `Template not found: ${request.templateName}`
        };
      }

      const metadata = request.options?.metadata || {};
      let data: any;
      let downloadUrl: string | undefined;

      switch (request.format) {
        case 'json':
          data = this.exportAsJson(template, metadata);
          downloadUrl = await this.saveExport(request.templateName, 'json', JSON.stringify(data, null, 2));
          break;

        case 'npm':
          data = await this.exportAsNpm(template, metadata);
          downloadUrl = await this.saveExport(request.templateName, 'npm.tgz', 'binary');
          this.logger.warn('NPM export not fully implemented yet');
          break;

        case 'gist':
          // TODO: Implement GitHub Gist upload
          data = this.exportAsJson(template, metadata);
          this.logger.warn('Gist export not implemented yet');
          break;

        case 'typescript':
          data = await this.exportAsTypeScript(template);
          downloadUrl = await this.saveExport(request.templateName, 'ts', data);
          break;
      }

      return {
        success: true,
        format: request.format,
        data,
        downloadUrl
      };

    } catch (error: any) {
      this.logger.error('Failed to export template', { error: error.message });
      return {
        success: false,
        format: request.format,
        error: error.message
      };
    }
  }

  /**
   * Import template from external source
   */
  async import(request: ImportRequest): Promise<ImportResponse> {
    try {
      let templateData: any;

      // Get template data based on source type
      switch (request.source.type) {
        case 'json':
          templateData = request.source.content;
          break;

        case 'url':
          if (!request.source.url) {
            throw new Error('URL is required for url source type');
          }
          const response = await fetch(request.source.url);
          templateData = await response.json();
          break;

        case 'gist':
          // TODO: Implement GitHub Gist fetch
          throw new Error('Gist import not implemented yet');
      }

      // Extract template config
      const config: McpServiceConfig = templateData.template?.config || templateData;
      const name = config.name;

      // Check for conflicts
      const conflicts: string[] = [];
      const existing = await this.templateManager.get(name);

      if (existing && !request.options?.overwrite) {
        conflicts.push(`Template ${name} already exists`);
        return {
          success: false,
          conflicts,
          error: 'Template already exists. Use overwrite option to replace.'
        };
      }

      // Register template
      let registered = false;
      if (request.options?.autoRegister) {
        await this.templateManager.register(config);
        registered = true;
      }

      return {
        success: true,
        template: { name, config },
        registered,
        conflicts
      };

    } catch (error: any) {
      this.logger.error('Failed to import template', { error: error.message });
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get content from source
   */
  private async getContent(source: GenerateRequest['source']): Promise<string> {
    if (source.content) {
      return source.content;
    }

    if (source.url) {
      const response = await fetch(source.url);
      return await response.text();
    }

    throw new Error('Either content or url must be provided');
  }

  /**
   * Select appropriate parser
   */
  private selectParser(type: GeneratorSourceType, content: string): BaseParser | null {
    const parser = this.parsers.get(type);
    if (parser && parser.supports(content)) {
      return parser;
    }

    // Try to auto-detect
    for (const [, p] of this.parsers) {
      if (p.supports(content)) {
        return p;
      }
    }

    return null;
  }

  /**
   * Validate generated configuration
   */
  private async validate(
    config: McpServiceConfig,
    tools: McpToolSchema[]
  ): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Basic validation
    const templateValidation = await this.templateManager.validateTemplate(config);
    errors.push(...templateValidation.errors);

    // Check for environment variables
    if (config.env) {
      for (const [key, value] of Object.entries(config.env)) {
        if (typeof value === 'string' && value.includes('${') && value.includes('}')) {
          warnings.push(`Environment variable ${key} requires configuration: ${value}`);
        }
      }
    }

    // Validate tools
    if (tools.length === 0) {
      warnings.push('No tools defined in the service');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Perform dry-run test
   */
  private async performDryRun(
    config: McpServiceConfig,
    parseResult: ParseResult,
    auth?: Record<string, string>
  ): Promise<GenerateResponse['dryRun']> {
    try {
      const startTime = Date.now();

      // For HTTP endpoints, try a real request
      if (config.transport === 'http' && parseResult.endpoint.url) {
        const url = new URL(parseResult.endpoint.url);
        const headers: Record<string, string> = {
          'Content-Type': 'application/json'
        };

        // Add auth if provided
        if (auth && parseResult.auth) {
          const authKey = parseResult.auth.key || 'Authorization';
          headers[authKey] = auth.apiKey || auth.token || '';
        }

        const response = await fetch(url.toString(), {
          method: parseResult.endpoint.method,
          headers,
          signal: AbortSignal.timeout(5000)
        });

        const latency = Date.now() - startTime;

        if (!response.ok) {
          return {
            success: false,
            latency,
            error: `HTTP ${response.status}: ${response.statusText}`
          };
        }

        return {
          success: true,
          latency
        };
      }

      // For other transports, just return success
      return {
        success: true,
        latency: 0
      };

    } catch (error: any) {
      return {
        success: false,
        latency: 0,
        error: error.message
      };
    }
  }

  /**
   * Export as JSON format
   */
  private exportAsJson(template: McpServiceConfig, metadata: any): any {
    return {
      type: 'pb-mcp-template',
      version: '1.0.0',
      template,
      metadata: {
        ...metadata,
        exportedAt: new Date().toISOString()
      }
    };
  }

  /**
   * Export as NPM package (placeholder)
   */
  private async exportAsNpm(template: McpServiceConfig, metadata: any): Promise<any> {
    // TODO: Implement full NPM package generation
    return {
      packageJson: this.adapterGenerator.generatePackageJson(template.name),
      template: this.exportAsJson(template, metadata)
    };
  }

  /**
   * Export as TypeScript definitions
   */
  private async exportAsTypeScript(template: McpServiceConfig): Promise<string> {
    return `// Auto-generated TypeScript definitions for ${template.name}
export interface ${this.toPascalCase(template.name)}Config {
  name: '${template.name}';
  version: '${template.version}';
  transport: '${template.transport}';
  ${template.command ? `command: '${template.command}';` : ''}
  ${template.args ? `args: ${JSON.stringify(template.args)};` : ''}
  env?: Record<string, string>;
}

export const ${this.toCamelCase(template.name)}Config: ${this.toPascalCase(template.name)}Config = ${JSON.stringify(template, null, 2)};
`;
  }

  /**
   * Save export to file
   */
  private async saveExport(name: string, ext: string, content: string): Promise<string> {
    const filename = `${name}-export-${Date.now()}.${ext}`;
    const filepath = join(this.exportDir, filename);

    try {
      await fs.writeFile(filepath, content, 'utf-8');
      return `/api/generator/download/${filename}`;
    } catch (error) {
      this.logger.warn('Failed to save export file', { error });
      return '';
    }
  }

  private toPascalCase(str: string): string {
    return str
      .split(/[-_]/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join('');
  }

  private toCamelCase(str: string): string {
    const pascal = this.toPascalCase(str);
    return pascal.charAt(0).toLowerCase() + pascal.slice(1);
  }
}

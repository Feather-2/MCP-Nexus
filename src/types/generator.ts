import { z } from 'zod';
import { McpServiceConfigSchema } from './gateway.js';

// Source types for MCP generation
export const GENERATOR_SOURCE_TYPES = ['markdown', 'openapi', 'text', 'curl', 'javascript', 'python'] as const;
export type GeneratorSourceType = typeof GENERATOR_SOURCE_TYPES[number];

export const GENERATOR_EXPORT_FORMATS = ['json', 'npm', 'gist', 'typescript'] as const;
export type GeneratorExportFormat = typeof GENERATOR_EXPORT_FORMATS[number];

// Parse result from input sources
export const ParseResultSchema = z.object({
  intent: z.string(),
  endpoint: z.object({
    url: z.string(),
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']),
    baseUrl: z.string().optional()
  }),
  auth: z.object({
    type: z.enum(['apikey', 'bearer', 'basic', 'oauth2', 'none']),
    location: z.enum(['header', 'query', 'body']).optional(),
    key: z.string().optional(),
    value: z.string().optional()
  }).optional(),
  parameters: z.array(z.object({
    name: z.string(),
    type: z.enum(['string', 'number', 'boolean', 'object', 'array']),
    required: z.boolean(),
    description: z.string().optional(),
    default: z.any().optional(),
    enum: z.array(z.any()).optional()
  })),
  response: z.object({
    schema: z.record(z.any()).optional(),
    examples: z.array(z.any()).optional()
  }).optional(),
  hasStatefulLogic: z.boolean().optional(),
  hasLocalProcessing: z.boolean().optional(),
  supportsStreaming: z.boolean().optional()
});

export type ParseResult = z.infer<typeof ParseResultSchema>;

// MCP Tool Schema
export const McpToolSchemaSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.object({
    type: z.literal('object'),
    properties: z.record(z.any()),
    required: z.array(z.string()).optional()
  })
});

export type McpToolSchema = z.infer<typeof McpToolSchemaSchema>;

// Generator request
export const GenerateRequestSchema = z.object({
  source: z.object({
    type: z.enum(GENERATOR_SOURCE_TYPES),
    content: z.string().optional(),
    url: z.string().optional()
  }),
  options: z.object({
    name: z.string().optional(),
    transport: z.enum(['auto', 'http', 'stdio', 'streamable-http']).default('auto'),
    testMode: z.boolean().default(false),
    dryRunMode: z.enum(['schema-only', 'real']).default('schema-only'),
    autoRegister: z.boolean().default(true)
  }).optional(),
  auth: z.record(z.string()).optional()
});

export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;

// Validation result
export const ValidationResultSchema = z.object({
  valid: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  dryRunResults: z.object({
    success: z.boolean(),
    response: z.any().optional(),
    latency: z.number(),
    error: z.string().optional()
  }).optional()
});

export type ValidationResult = z.infer<typeof ValidationResultSchema>;

// Generate response
export const GenerateResponseSchema = z.object({
  success: z.boolean(),
  template: z.object({
    name: z.string(),
    config: McpServiceConfigSchema,
    tools: z.array(McpToolSchemaSchema)
  }).optional(),
  validation: ValidationResultSchema.optional(),
  dryRun: z.object({
    success: z.boolean(),
    latency: z.number().optional(),
    error: z.string().optional()
  }).optional(),
  registered: z.boolean().optional(),
  serviceId: z.string().optional(),
  error: z.string().optional()
});

export type GenerateResponse = z.infer<typeof GenerateResponseSchema>;

// Export request
export const ExportRequestSchema = z.object({
  templateName: z.string(),
  format: z.enum(GENERATOR_EXPORT_FORMATS),
  options: z.object({
    includeCode: z.boolean().default(true),
    includeTests: z.boolean().default(true),
    minify: z.boolean().default(false),
    metadata: z.object({
      author: z.string().optional(),
      tags: z.array(z.string()).optional(),
      description: z.string().optional()
    }).optional()
  }).optional()
});

export type ExportRequest = z.infer<typeof ExportRequestSchema>;

// Export response
export const ExportResponseSchema = z.object({
  success: z.boolean(),
  format: z.enum(GENERATOR_EXPORT_FORMATS),
  data: z.any().optional(),
  downloadUrl: z.string().optional(),
  shareUrl: z.string().optional(),
  error: z.string().optional()
});

export type ExportResponse = z.infer<typeof ExportResponseSchema>;

// Import request
export const ImportRequestSchema = z.object({
  source: z.object({
    type: z.enum(['json', 'url', 'gist']),
    content: z.any().optional(),
    url: z.string().optional(),
    gistId: z.string().optional()
  }),
  options: z.object({
    autoRegister: z.boolean().default(true),
    overwrite: z.boolean().default(false)
  }).optional()
});

export type ImportRequest = z.infer<typeof ImportRequestSchema>;

// Import response
export const ImportResponseSchema = z.object({
  success: z.boolean(),
  template: z.object({
    name: z.string(),
    config: McpServiceConfigSchema
  }).optional(),
  registered: z.boolean().optional(),
  conflicts: z.array(z.string()).optional(),
  error: z.string().optional()
});

export type ImportResponse = z.infer<typeof ImportResponseSchema>;

// Marketplace template
export const MarketplaceTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  author: z.string(),
  version: z.string(),
  downloads: z.number().default(0),
  rating: z.number().min(0).max(5).optional(),
  tags: z.array(z.string()),
  preview: z.record(z.any()),
  createdAt: z.string(),
  updatedAt: z.string()
});

export type MarketplaceTemplate = z.infer<typeof MarketplaceTemplateSchema>;

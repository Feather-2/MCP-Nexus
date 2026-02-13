import { z } from 'zod';
import type { Skill } from '../../../../skills/types.js';
import type { Platform } from '../../../../skills/index.js';
import { mergeWithDefaults, validateCapabilities, type SkillCapabilities } from '../../../../security/CapabilityManifest.js';
import { SkillDefinitionSchema } from '../schemas/SkillSchemas.js';

export function normalizeSupportFiles(input?: z.infer<typeof SkillDefinitionSchema>['supportFiles']): Map<string, string> | undefined {
  if (!input) return undefined;
  if (Array.isArray(input)) {
    const entries = input.map((f) => [String(f.path), String(f.content ?? '')] as const);
    return new Map(entries);
  }
  const record = input as Record<string, string>;
  return new Map(Object.entries(record).map(([p, c]) => [String(p), String(c ?? '')]));
}

export function buildSkillFromDefinition(input: z.infer<typeof SkillDefinitionSchema>): Skill {
  const caps = mergeWithDefaults(input.capabilities as Partial<SkillCapabilities> | undefined);
  validateCapabilities(caps);

  const keywords = Array.isArray(input.metadata.keywords) ? input.metadata.keywords.map(String) : [];
  const keywordsAll = Array.isArray(input.metadata.keywordsAll)
    ? input.metadata.keywordsAll.map(String)
    : keywords;

  return {
    metadata: {
      name: String(input.metadata.name),
      description: String(input.metadata.description),
      shortDescription: input.metadata.shortDescription,
      path: input.metadata.path ?? '',
      scope: input.metadata.scope ?? 'remote',
      keywords,
      keywordsAll,
      tags: input.metadata.tags,
      traits: input.metadata.traits,
      allowedTools: input.metadata.allowedTools,
      priority: input.metadata.priority ?? 0
    },
    body: String(input.body),
    capabilities: caps,
    supportFiles: normalizeSupportFiles(input.supportFiles)
  };
}

export function normalizePlatform(input?: string): Platform {
  const normalized = input?.trim().toLowerCase();
  switch (normalized) {
    case 'claude-code':
    case 'codex':
    case 'js-agent':
    case 'generic':
      return normalized;
    default:
      return 'generic';
  }
}

export function normalizePlatforms(input?: string[]): Platform[] | undefined {
  if (!input?.length) {
    return undefined;
  }

  return Array.from(new Set(input.map((value) => normalizePlatform(value))));
}

import type { Skill } from './types.js';
import type { Logger } from '../types/index.js';

export type Platform = 'claude-code' | 'codex' | 'js-agent' | 'generic';

export interface LocalizedSkill {
  platform: Platform;
  content: string;
  metadata: {
    name: string;
    description: string;
    toolHints?: string;
  };
}

export interface PlatformAdapter {
  platform: Platform;
  localize(skill: Skill): LocalizedSkill;
}

export interface SkillLocalizerOptions {
  logger?: Logger;
  adapters?: PlatformAdapter[];
}

const DEFAULT_CLAUDE_TOOL_HINTS = ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'];
const DEFAULT_CODEX_TOOL_HINTS = ['shell', 'file read', 'file write'];

const CLAUDE_TOOL_MAP: Record<string, string[]> = {
  bash: ['Bash'],
  shell: ['Bash'],
  command: ['Bash'],
  terminal: ['Bash'],
  read: ['Read'],
  write: ['Write'],
  edit: ['Edit'],
  patch: ['Edit'],
  grep: ['Grep'],
  search: ['Grep'],
  glob: ['Glob'],
  filesystem: ['Read', 'Write', 'Edit', 'Glob']
};

function parseAllowedTools(allowedTools?: string): string[] {
  if (!allowedTools) return [];

  const values = allowedTools
    .split(/[\n,]/)
    .flatMap((segment) => segment.trim().split(/\s+/))
    .map((tool) => tool.trim().toLowerCase())
    .filter(Boolean);

  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    deduped.push(value);
  }

  return deduped;
}

function mapAllowedToolsForClaude(allowedTools?: string): string[] {
  const mapped: string[] = [];
  const seen = new Set<string>();

  for (const toolId of parseAllowedTools(allowedTools)) {
    const targetTools = CLAUDE_TOOL_MAP[toolId] ?? [toolId];
    for (const target of targetTools) {
      if (seen.has(target)) continue;
      seen.add(target);
      mapped.push(target);
    }
  }

  return mapped;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function simplifyMarkdownForCodex(body: string): string {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];

  for (const line of lines) {
    const heading = line.match(/^\s{0,3}#{1,3}\s+(.+)$/);
    if (heading) {
      const headingText = heading[1]?.trim() || '';
      if (headingText.length) {
        if (out.length && out[out.length - 1] !== '---') {
          out.push('---');
        }
        out.push(headingText);
        out.push('---');
      }
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    if (unordered) {
      out.push(unordered[1]?.trim() || '');
      continue;
    }

    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ordered) {
      out.push(ordered[1]?.trim() || '');
      continue;
    }

    out.push(line);
  }

  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(?:\n---\n){2,}/g, '\n---\n')
    .trim();
}

function buildCapabilitySummary(skill: Skill): string {
  const summary = {
    filesystem: skill.capabilities.filesystem,
    network: skill.capabilities.network,
    env: skill.capabilities.env,
    subprocess: skill.capabilities.subprocess,
    resources: skill.capabilities.resources
  };

  return `Capability summary: ${JSON.stringify(summary)}`;
}

class ClaudeCodeAdapter implements PlatformAdapter {
  readonly platform: Platform = 'claude-code';

  localize(skill: Skill): LocalizedSkill {
    const mappedAllowedTools = mapAllowedToolsForClaude(skill.metadata.allowedTools);
    const metadataBlock = [
      '<skill-metadata>',
      `  <name>${escapeXml(skill.metadata.name)}</name>`,
      `  <description>${escapeXml(skill.metadata.description)}</description>`,
      ...(mappedAllowedTools.length
        ? [`  <allowed-tools>${escapeXml(mappedAllowedTools.join(', '))}</allowed-tools>`]
        : []),
      '</skill-metadata>'
    ].join('\n');

    const toolHints = mappedAllowedTools.length
      ? `Claude Code tools: ${DEFAULT_CLAUDE_TOOL_HINTS.join(', ')}. Preferred for this skill: ${mappedAllowedTools.join(', ')}.`
      : `Claude Code tools: ${DEFAULT_CLAUDE_TOOL_HINTS.join(', ')}.`;

    return {
      platform: this.platform,
      content: `${metadataBlock}\n\n${skill.body}`,
      metadata: {
        name: skill.metadata.name,
        description: skill.metadata.description,
        toolHints
      }
    };
  }
}

class CodexAdapter implements PlatformAdapter {
  readonly platform: Platform = 'codex';

  localize(skill: Skill): LocalizedSkill {
    const simplifiedBody = simplifyMarkdownForCodex(skill.body);
    const preferredTools = parseAllowedTools(skill.metadata.allowedTools);
    const preferredText = preferredTools.length
      ? `Preferred tools: ${preferredTools.join(', ')}.`
      : undefined;

    let content = [
      `Skill: ${skill.metadata.name}`,
      `Description: ${skill.metadata.description}`,
      preferredText,
      '---',
      simplifiedBody
    ].filter((line) => typeof line === 'string' && line.length > 0).join('\n');

    if (content.length > 8000) {
      const capabilitySummary = buildCapabilitySummary(skill);
      content = `${content.slice(0, 7500).trimEnd()}\n...\n${capabilitySummary}`;
    }

    return {
      platform: this.platform,
      content,
      metadata: {
        name: skill.metadata.name,
        description: skill.metadata.description,
        toolHints: `Codex tools: ${DEFAULT_CODEX_TOOL_HINTS.join(', ')}.`
      }
    };
  }
}

class JsAgentAdapter implements PlatformAdapter {
  readonly platform: Platform = 'js-agent';

  localize(skill: Skill): LocalizedSkill {
    const metadataHeader = JSON.stringify({
      metadata: {
        name: skill.metadata.name,
        description: skill.metadata.description,
        allowedTools: parseAllowedTools(skill.metadata.allowedTools)
      },
      capabilities: skill.capabilities
    }, null, 2);

    return {
      platform: this.platform,
      content: `${metadataHeader}\n---\n${skill.body}`,
      metadata: {
        name: skill.metadata.name,
        description: skill.metadata.description,
        toolHints: 'JS Agent tools: use host-registered custom tools and transport adapters.'
      }
    };
  }
}

class GenericAdapter implements PlatformAdapter {
  readonly platform: Platform = 'generic';

  localize(skill: Skill): LocalizedSkill {
    return {
      platform: this.platform,
      content: skill.body,
      metadata: {
        name: skill.metadata.name,
        description: skill.metadata.description
      }
    };
  }
}

export class SkillLocalizer {
  private readonly logger?: Logger;
  private readonly adapters = new Map<Platform, PlatformAdapter>();

  constructor(options?: SkillLocalizerOptions) {
    this.logger = options?.logger;

    const builtinAdapters: PlatformAdapter[] = [
      new ClaudeCodeAdapter(),
      new CodexAdapter(),
      new JsAgentAdapter(),
      new GenericAdapter()
    ];

    for (const adapter of builtinAdapters) {
      this.adapters.set(adapter.platform, adapter);
    }

    if (options?.adapters) {
      for (const adapter of options.adapters) {
        this.registerAdapter(adapter);
      }
    }
  }

  localize(skill: Skill, platform: Platform): LocalizedSkill {
    const adapter = this.adapters.get(platform) ?? this.adapters.get('generic');
    if (!adapter) {
      throw new Error('No generic skill localizer adapter is registered');
    }

    if (!this.adapters.has(platform)) {
      this.logger?.debug('No adapter registered for platform. Falling back to generic adapter.', {
        platform,
        skill: skill.metadata.name
      });
    }

    try {
      return adapter.localize(skill);
    } catch (error) {
      throw new Error(`Failed to localize skill for platform: ${platform}`, { cause: error });
    }
  }

  getSupportedPlatforms(): Platform[] {
    return Array.from(this.adapters.keys());
  }

  registerAdapter(adapter: PlatformAdapter): void {
    this.adapters.set(adapter.platform, adapter);
    this.logger?.debug('Registered skill localization adapter', { platform: adapter.platform });
  }
}

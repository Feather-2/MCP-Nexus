import type { Skill } from './types.js';
import type { Platform, PlatformAdapter } from './SkillLocalizer.js';
import { SkillLocalizer } from './SkillLocalizer.js';

function makeSkill(body?: string): Skill {
  return {
    metadata: {
      name: 'demo-skill',
      description: 'Demo skill for localization',
      path: '/tmp/demo/SKILL.md',
      scope: 'repo',
      keywords: ['demo'],
      keywordsAll: ['demo', 'localize'],
      allowedTools: 'shell filesystem edit',
      priority: 0
    },
    body: body ?? [
      '# Demo Skill',
      '',
      '## Steps',
      '- First do this',
      '- Then do that',
      '',
      '### Notes',
      'Keep structure here.'
    ].join('\n'),
    capabilities: {
      filesystem: {
        read: ['/workspace'],
        write: ['/workspace/out']
      },
      network: {
        allowedHosts: ['api.example.com'],
        allowedPorts: [443]
      },
      env: ['OPENAI_API_KEY'],
      subprocess: {
        allowed: true,
        allowedCommands: ['git']
      },
      resources: {
        maxMemoryMB: 512,
        maxCpuPercent: 50,
        timeoutMs: 60000
      }
    }
  };
}

describe('SkillLocalizer', () => {
  it('localizes the same skill differently for each built-in platform', () => {
    const skill = makeSkill();
    const localizer = new SkillLocalizer();

    const claude = localizer.localize(skill, 'claude-code');
    const codex = localizer.localize(skill, 'codex');
    const jsAgent = localizer.localize(skill, 'js-agent');
    const generic = localizer.localize(skill, 'generic');

    expect(new Set([claude.content, codex.content, jsAgent.content, generic.content]).size).toBe(4);
  });

  it('Claude Code adapter preserves body and injects XML-ish metadata header', () => {
    const skill = makeSkill();
    const localizer = new SkillLocalizer();

    const localized = localizer.localize(skill, 'claude-code');

    expect(localized.platform).toBe('claude-code');
    expect(localized.content).toContain('<skill-metadata>');
    expect(localized.content).toContain(`<name>${skill.metadata.name}</name>`);
    expect(localized.content).toContain(`<description>${skill.metadata.description}</description>`);
    expect(localized.content.endsWith(skill.body)).toBe(true);
    expect(localized.metadata.toolHints).toContain('Bash');
  });

  it('Codex adapter simplifies markdown headings and truncates long content', () => {
    const localizer = new SkillLocalizer();
    const normal = makeSkill();

    const localizedNormal = localizer.localize(normal, 'codex');
    expect(localizedNormal.content).toContain('Demo Skill');
    expect(localizedNormal.content).toContain('---');
    expect(localizedNormal.content).not.toContain('# Demo Skill');

    const longSkill = makeSkill(`# Long\n\n${'x'.repeat(9000)}`);
    const localizedLong = localizer.localize(longSkill, 'codex');

    expect(localizedLong.content).toContain('\n...\n');
    expect(localizedLong.content).toContain('Capability summary:');
    expect(localizedLong.content.length).toBeLessThan(longSkill.body.length);
  });

  it('JS Agent adapter prefixes JSON metadata and embeds capabilities', () => {
    const skill = makeSkill();
    const localizer = new SkillLocalizer();

    const localized = localizer.localize(skill, 'js-agent');
    const separator = '\n---\n';
    const splitIndex = localized.content.indexOf(separator);

    expect(splitIndex).toBeGreaterThan(0);
    const metadataHeader = localized.content.slice(0, splitIndex);
    const parsed = JSON.parse(metadataHeader) as {
      metadata: { name: string; description: string; allowedTools: string[] };
      capabilities: Skill['capabilities'];
    };

    expect(parsed.metadata.name).toBe(skill.metadata.name);
    expect(parsed.metadata.description).toBe(skill.metadata.description);
    expect(parsed.metadata.allowedTools).toEqual(['shell', 'filesystem', 'edit']);
    expect(parsed.capabilities).toEqual(skill.capabilities);
    expect(localized.metadata.toolHints).toContain('JS Agent');
  });

  it('Generic adapter returns original body and metadata unchanged', () => {
    const skill = makeSkill();
    const localizer = new SkillLocalizer();

    const localized = localizer.localize(skill, 'generic');

    expect(localized.platform).toBe('generic');
    expect(localized.content).toBe(skill.body);
    expect(localized.metadata).toEqual({
      name: skill.metadata.name,
      description: skill.metadata.description
    });
  });

  it('getSupportedPlatforms lists the built-in platforms', () => {
    const localizer = new SkillLocalizer();

    const supported = localizer.getSupportedPlatforms().slice().sort();

    expect(supported).toEqual(['claude-code', 'codex', 'generic', 'js-agent']);
  });

  it('registerAdapter allows overriding an existing platform adapter', () => {
    const skill = makeSkill();
    const localizer = new SkillLocalizer();

    const customCodexAdapter: PlatformAdapter = {
      platform: 'codex',
      localize(targetSkill) {
        return {
          platform: 'codex',
          content: `custom:${targetSkill.metadata.name}`,
          metadata: {
            name: targetSkill.metadata.name,
            description: targetSkill.metadata.description,
            toolHints: 'custom'
          }
        };
      }
    };

    localizer.registerAdapter(customCodexAdapter);

    const localized = localizer.localize(skill, 'codex');
    expect(localized.content).toBe('custom:demo-skill');
  });

  it('falls back to generic adapter for unknown runtime platform values', () => {
    const skill = makeSkill();
    const localizer = new SkillLocalizer();

    const localized = localizer.localize(skill, 'unknown-runtime' as Platform);

    expect(localized.platform).toBe('generic');
    expect(localized.content).toBe(skill.body);
  });
});

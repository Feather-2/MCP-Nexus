import os from 'os';
import path from 'path';
import { access, mkdtemp, readFile, rm } from 'fs/promises';
import type { Skill } from './types.js';
import type { Platform, PlatformAdapter, PlatformDirectoryConfig } from './SkillLocalizer.js';
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
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'nexus-skill-localizer-'));
  });

  afterEach(async () => {
    if (tmpRoot) {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  function makePlatformDirs(root: string): PlatformDirectoryConfig[] {
    return [
      {
        platform: 'claude-code',
        directory: path.join(root, 'claude')
      },
      {
        platform: 'codex',
        directory: path.join(root, 'codex')
      },
      {
        platform: 'js-agent',
        directory: path.join(root, 'js-agent')
      },
      {
        platform: 'generic',
        directory: path.join(root, 'generic')
      }
    ];
  }

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

  it('distribute writes localized skill files to platform directories', async () => {
    const skill = makeSkill();
    const localizer = new SkillLocalizer({
      platformDirs: makePlatformDirs(tmpRoot)
    });

    const distributed = await localizer.distribute(skill);
    const distributedByPlatform = new Map(distributed.map((entry) => [entry.platform, entry.path]));

    expect(distributedByPlatform.get('claude-code')).toBe(path.join(tmpRoot, 'claude', `${skill.metadata.name}.md`));
    expect(distributedByPlatform.get('codex')).toBe(path.join(tmpRoot, 'codex', `${skill.metadata.name}.md`));
    expect(distributedByPlatform.get('js-agent')).toBe(path.join(tmpRoot, 'js-agent', `${skill.metadata.name}.json`));
    expect(distributedByPlatform.get('generic')).toBe(path.join(tmpRoot, 'generic', `${skill.metadata.name}.md`));

    for (const platform of localizer.getSupportedPlatforms()) {
      const filePath = distributedByPlatform.get(platform);
      expect(typeof filePath).toBe('string');
      const content = await readFile(filePath as string, 'utf8');
      expect(content).toBe(localizer.localize(skill, platform).content);
    }
  });

  it('undistribute removes files and ignores missing files', async () => {
    const skill = makeSkill();
    const localizer = new SkillLocalizer({
      platformDirs: makePlatformDirs(tmpRoot)
    });

    const [codexResult] = await localizer.distribute(skill, ['codex']);
    expect(codexResult?.path).toBe(path.join(tmpRoot, 'codex', `${skill.metadata.name}.md`));

    await localizer.undistribute(skill.metadata.name, ['codex', 'generic']);
    await localizer.undistribute(skill.metadata.name, ['codex', 'generic']);

    await expect(access(path.join(tmpRoot, 'codex', `${skill.metadata.name}.md`))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

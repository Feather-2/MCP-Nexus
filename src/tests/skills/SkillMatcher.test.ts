import type { Skill } from '../../skills/types.js';
import { SkillMatcher } from '../../skills/SkillMatcher.js';
import { DEFAULT_SKILL_CAPABILITIES } from '../../security/CapabilityManifest.js';

describe('SkillMatcher', () => {
  it('prefers explicit mention and keyword overlap', () => {
    const skills: Skill[] = [
      {
        metadata: {
          name: 'database',
          description: 'SQL and databases',
          path: '/tmp/database/SKILL.md',
          scope: 'repo',
          keywords: ['sql', 'database'],
          keywordsAll: ['database', 'sql', 'table', 'query'],
          priority: 10
        },
        body: 'Use sqlite tool.',
        capabilities: DEFAULT_SKILL_CAPABILITIES
      },
      {
        metadata: {
          name: 'search',
          description: 'Web search',
          path: '/tmp/search/SKILL.md',
          scope: 'repo',
          keywords: ['search'],
          keywordsAll: ['search', 'web', 'query'],
          priority: 0
        },
        body: 'Use brave-search tool.',
        capabilities: DEFAULT_SKILL_CAPABILITIES
      }
    ];

    const matcher = new SkillMatcher();

    {
      const matches = matcher.match('Please use $database to query a table with SQL', skills);
      expect(matches[0]?.skill.metadata.name).toBe('database');
      expect(matches[0]?.result.score).toBe(1);
    }

    {
      const matches = matcher.match('Please use skill:database to query a table with SQL', skills);
      expect(matches[0]?.skill.metadata.name).toBe('database');
      expect(matches[0]?.result.score).toBe(1);
      expect(matches[0]?.result.reason).toContain('explicit skill:name mention');
    }

    {
      const matches = matcher.match('Need to query table with SQL', skills);
      expect(matches[0]?.skill.metadata.name).toBe('database');
      expect(matches[0]?.result.score).toBeGreaterThan(0.25);
    }
  });

  it('formats injection blocks', () => {
    const skills: Skill[] = [
      {
        metadata: {
          name: 'database',
          description: 'SQL and databases',
          path: '/tmp/database/SKILL.md',
          scope: 'repo',
          keywords: ['sql', 'database'],
          keywordsAll: ['database', 'sql', 'table', 'query'],
          allowedTools: 'sqlite',
          priority: 0
        },
        body: 'Use sqlite tool.',
        capabilities: DEFAULT_SKILL_CAPABILITIES
      }
    ];

    const matcher = new SkillMatcher();
    const injection = matcher.formatInjection(skills);
    expect(injection).toContain('## Skill: database');
    expect(injection).toContain('- Description: SQL and databases');
    expect(injection).toContain('- AllowedTools: sqlite');
    expect(injection).toContain('Use sqlite tool.');
  });

  it('handles empty names safely', () => {
    const skills: Skill[] = [
      {
        metadata: {
          name: '   ',
          description: 'no name',
          path: '/tmp/empty/SKILL.md',
          scope: 'repo',
          keywords: [],
          keywordsAll: ['foo'],
          priority: 0
        },
        body: 'noop',
        capabilities: DEFAULT_SKILL_CAPABILITIES
      }
    ];

    const matcher = new SkillMatcher();
    const matches = matcher.match('foo', skills);
    expect(matches[0]?.skill.metadata.description).toBe('no name');
    expect(matches[0]?.result.score).toBeGreaterThan(0);
  });
});

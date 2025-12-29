import type { Skill } from '../../skills/types.js';
import { SkillMatcher } from '../../skills/SkillMatcher.js';

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
        body: 'Use sqlite tool.'
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
        body: 'Use brave-search tool.'
      }
    ];

    const matcher = new SkillMatcher();

    {
      const matches = matcher.match('Please use $database to query a table with SQL', skills);
      expect(matches[0]?.skill.metadata.name).toBe('database');
      expect(matches[0]?.result.score).toBe(1);
    }

    {
      const matches = matcher.match('Need to query table with SQL', skills);
      expect(matches[0]?.skill.metadata.name).toBe('database');
      expect(matches[0]?.result.score).toBeGreaterThan(0.25);
    }
  });
});


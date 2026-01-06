import type { Skill } from '../../skills/types.js';
import { SkillMatcher } from '../../skills/SkillMatcher.js';
import { DEFAULT_SKILL_CAPABILITIES } from '../../security/CapabilityManifest.js';

function makeSkill(i: number, group: number): Skill {
  return {
    metadata: {
      name: `skill-${i}`,
      description: `Skill ${i} in group ${group}`,
      path: `/tmp/skill-${i}/SKILL.md`,
      scope: 'repo',
      keywords: [],
      keywordsAll: [
        `group-${group}`,
        `kw-${i}`
      ],
      priority: 0
    },
    body: `Body for skill ${i}`,
    capabilities: DEFAULT_SKILL_CAPABILITIES
  };
}

describe('SkillMatcher (indexed)', () => {
  it('narrows the candidate set via token index', () => {
    const skills: Skill[] = Array.from({ length: 200 }, (_, i) => makeSkill(i, i % 10));
    const matcher = new SkillMatcher();
    const index = matcher.buildIndex(skills);

    const candidateIds = matcher.getCandidateSkillIds('please handle kw-42 now', index);

    expect(candidateIds.length).toBeLessThan(skills.length);
    expect(candidateIds).toHaveLength(1);
    expect(index.skills[candidateIds[0]!]!.metadata.name).toBe('skill-42');
  });

  it('matches 100+ skills under 5ms (average)', () => {
    const skillCount = 250;
    const skills: Skill[] = Array.from({ length: skillCount }, (_, i) => makeSkill(i, i % 10));
    const matcher = new SkillMatcher();
    const index = matcher.buildIndex(skills);

    const input = 'need help with group-3 today';

    // Warmup (helps reduce JIT noise).
    for (let i = 0; i < 50; i += 1) {
      matcher.match(input, index, { maxResults: 5 });
    }

    const iterations = 500;
    let totalResults = 0;
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i += 1) {
      totalResults += matcher.match(input, index, { maxResults: 5 }).length;
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    const avgMs = elapsedMs / iterations;

    expect(totalResults).toBeGreaterThan(0);
    expect(avgMs).toBeLessThan(5);
  });
});

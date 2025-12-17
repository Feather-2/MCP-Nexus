import type { TaskComplexity, TierRouterConfig } from '../../routing/types.js';
import { DEFAULT_TIER_CONFIG } from '../../routing/types.js';
import { TierRouter } from '../../routing/tier-router.js';

describe('TierRouter', () => {
  const makeComplexity = (overrides: Partial<TaskComplexity>): TaskComplexity => ({
    stepCount: 1,
    toolCount: 1,
    multiFile: false,
    externalApi: false,
    iterative: false,
    score: 0,
    ...overrides
  });

  const makeRouter = (complexity: TaskComplexity, config?: Partial<TierRouterConfig>) => {
    const evaluator = { evaluate: vi.fn().mockReturnValue(complexity) } as any;
    return { router: new TierRouter({ evaluator, config }), evaluator };
  };

  it('exports DEFAULT_TIER_CONFIG with expected defaults', () => {
    expect(DEFAULT_TIER_CONFIG).toEqual(
      expect.objectContaining({
        skillsThreshold: 30,
        subagentThreshold: 60,
        directTools: expect.arrayContaining(['read_file', 'run_command']),
        availableSkills: expect.arrayContaining(['search', 'database']),
        availableDepartments: expect.arrayContaining(['research', 'coding'])
      })
    );
  });

  it('routes score < skillsThreshold to direct', () => {
    const { router } = makeRouter(makeComplexity({ score: 29 }));
    const decision = router.route('read config');

    expect(decision.tier).toBe('direct');
    expect(decision.suggestedTools).toEqual(['read_file']);
  });

  it('routes skillsThreshold <= score < subagentThreshold to skills', () => {
    const { router } = makeRouter(makeComplexity({ score: 30 }));
    const decision = router.route('Use SQL table records');

    expect(decision.tier).toBe('skills');
    expect(decision.suggestedSkill).toBe('database');
  });

  it('routes score >= subagentThreshold to subagent', () => {
    const { router } = makeRouter(makeComplexity({ score: 60 }));
    const decision = router.route('Update README docs');

    expect(decision.tier).toBe('subagent');
    expect(decision.suggestedDepartment).toBe('docs');
  });

  it('applies hard rule: multiFile && stepCount > 3 → subagent', () => {
    const { router } = makeRouter(makeComplexity({ score: 0, multiFile: true, stepCount: 4 }));
    const decision = router.route('read files');

    expect(decision.tier).toBe('subagent');
  });

  it('applies hard rule: externalApi && iterative → subagent', () => {
    const { router } = makeRouter(makeComplexity({ score: 0, externalApi: true, iterative: true }));
    const decision = router.route('fetch API until done');

    expect(decision.tier).toBe('subagent');
  });

  it('routeWithComplexity returns full decision + complexity', () => {
    const complexity = makeComplexity({ score: 30, toolCount: 2, stepCount: 2 });
    const { router, evaluator } = makeRouter(complexity);

    const result = router.routeWithComplexity('search and validate');

    expect(evaluator.evaluate).toHaveBeenCalledOnce();
    expect(result.complexity).toEqual(complexity);
    expect(result.decision).toEqual(
      expect.objectContaining({
        tier: 'skills',
        confidence: expect.any(Number),
        reasoning: expect.stringContaining('complexity score: 30')
      })
    );
  });

  it('suggestDirectTools matches correct tools and de-duplicates', () => {
    const { router } = makeRouter(makeComplexity({ score: 0 }));
    const decision = router.route('Read content then write output and run command in bash');

    expect(decision.tier).toBe('direct');
    expect(decision.suggestedTools).toEqual(['read_file', 'write_file', 'run_command']);
  });

  it('suggestSkill matches correct skill', () => {
    const { router } = makeRouter(makeComplexity({ score: 40 }));
    const decision = router.route('Fetch from API endpoint');

    expect(decision.tier).toBe('skills');
    expect(decision.suggestedSkill).toBe('api');
  });

  it('suggestDepartment matches correct department', () => {
    const { router } = makeRouter(makeComplexity({ score: 90 }));
    const decision = router.route('Investigate and analyze performance');

    expect(decision.tier).toBe('subagent');
    expect(decision.suggestedDepartment).toBe('research');
  });

  it('confidence calculation edge cases are stable', () => {
    {
      const { router } = makeRouter(makeComplexity({ score: 0 }));
      const decision = router.route('read');
      expect(decision.tier).toBe('direct');
      expect(decision.confidence).toBe(1);
    }

    {
      const { router } = makeRouter(makeComplexity({ score: 29 }));
      const decision = router.route('read');
      expect(decision.tier).toBe('direct');
      expect(decision.confidence).toBe(0.52);
    }

    {
      const { router } = makeRouter(makeComplexity({ score: 45 }));
      const decision = router.route('search');
      expect(decision.tier).toBe('skills');
      expect(decision.confidence).toBe(1);
    }

    {
      const { router } = makeRouter(makeComplexity({ score: 30 }));
      const decision = router.route('search');
      expect(decision.tier).toBe('skills');
      expect(decision.confidence).toBe(0.5);
    }

    {
      const { router } = makeRouter(makeComplexity({ score: 60 }));
      const decision = router.route('docs');
      expect(decision.tier).toBe('subagent');
      expect(decision.confidence).toBe(0.6);
    }

    {
      const { router } = makeRouter(makeComplexity({ score: 60, multiFile: true }));
      const decision = router.route('docs');
      expect(decision.tier).toBe('subagent');
      expect(decision.confidence).toBe(0.7);
    }
  });

  it('uses safe defaults when no tool/skill/department patterns match', () => {
    {
      const { router } = makeRouter(makeComplexity({ score: 0 }));
      const decision = router.route('hello');
      expect(decision.tier).toBe('direct');
      expect(decision.suggestedTools).toEqual(['read_file']);
    }

    {
      const { router } = makeRouter(makeComplexity({ score: 40 }));
      const decision = router.route('do stuff');
      expect(decision.tier).toBe('skills');
      expect(decision.suggestedSkill).toBe('search');
    }

    {
      const { router } = makeRouter(makeComplexity({ score: 90 }));
      const decision = router.route('unmatched');
      expect(decision.tier).toBe('subagent');
      expect(decision.suggestedDepartment).toBe('research');
    }
  });

  it('filters suggestions by configured availability lists', () => {
    const { router } = makeRouter(makeComplexity({ score: 40 }), {
      availableSkills: ['database']
    });

    const decision = router.route('Fetch from API endpoint');

    expect(decision.tier).toBe('skills');
    expect(decision.suggestedSkill).toBe('database');
  });

  it('includes key complexity signals in reasoning', () => {
    const { router } = makeRouter(
      makeComplexity({
        score: 90,
        stepCount: 2,
        toolCount: 3,
        multiFile: true,
        externalApi: true,
        iterative: true
      })
    );

    const decision = router.route('anything');

    expect(decision.reasoning).toContain('complexity score: 90');
    expect(decision.reasoning).toContain('~2 steps');
    expect(decision.reasoning).toContain('~3 tools');
    expect(decision.reasoning).toContain('multi-file');
    expect(decision.reasoning).toContain('external API');
    expect(decision.reasoning).toContain('iterative');
  });
});

import type { Skill } from '../../../skills/types.js';
import { DEFAULT_SKILL_CAPABILITIES } from '../../../security/CapabilityManifest.js';
import { PermissionAnalyzer } from '../../../security/analyzers/PermissionAnalyzer.js';

function makeSkill(overrides?: Partial<Skill>): Skill {
  const base: Skill = {
    metadata: {
      name: 'test-skill',
      description: 'test',
      path: '/tmp/test/SKILL.md',
      scope: 'repo',
      keywords: [],
      keywordsAll: [],
      priority: 0
    },
    body: '',
    capabilities: DEFAULT_SKILL_CAPABILITIES
  };

  return {
    ...base,
    ...overrides,
    metadata: { ...base.metadata, ...(overrides?.metadata ?? {}) }
  };
}

describe('PermissionAnalyzer', () => {
  it('marks full-disk write permission as excessive', () => {
    const analyzer = new PermissionAnalyzer();
    const skill = makeSkill({
      capabilities: {
        ...DEFAULT_SKILL_CAPABILITIES,
        filesystem: { read: [], write: [' / '] }
      }
    });

    const result = analyzer.analyzePermissions(skill);

    expect(result.excessive).toBe(true);
    expect(result.sensitiveAccess).toEqual([]);
    expect(result.score).toBeLessThanOrEqual(-30);
  });

  it('detects sensitive locations from both declared capabilities and content (including support files)', () => {
    const analyzer = new PermissionAnalyzer();
    const skill = makeSkill({
      body: 'Please inspect ~/.aws/credentials and read /etc/passwd for verification.',
      capabilities: {
        ...DEFAULT_SKILL_CAPABILITIES,
        filesystem: {
          read: ["'~/.ssh/'"],
          write: []
        }
      },
      supportFiles: new Map<string, string>([['script.ts', 'const p = "~/.ssh/id_rsa";']])
    });

    const result = analyzer.analyzePermissions(skill);

    expect(result.excessive).toBe(false);
    expect(result.sensitiveAccess).toEqual(['/etc/passwd', '~/.aws', '~/.ssh']);
    expect(result.score).toBeLessThan(0);
  });

  it('penalizes implied network access when not declared, but not when declared', () => {
    const analyzer = new PermissionAnalyzer();

    const missing = analyzer.analyzePermissions(
      makeSkill({
        body: "await fetch('https://example.com/api')"
      })
    );
    expect(missing.excessive).toBe(false);
    expect(missing.sensitiveAccess).toEqual([]);
    expect(missing.score).toBe(-10);

    const declared = analyzer.analyzePermissions(
      makeSkill({
        body: "await fetch('https://example.com/api')",
        capabilities: {
          ...DEFAULT_SKILL_CAPABILITIES,
          network: { allowedHosts: ['example.com'], allowedPorts: [443] }
        }
      })
    );
    expect(declared.score).toBe(0);
  });

  it('penalizes env var reads when undeclared and clamps worst-case score', () => {
    const analyzer = new PermissionAnalyzer();

    const result = analyzer.analyzePermissions(
      makeSkill({
        body: `
          // access a bunch of sensitive locations and env vars
          console.log(process.env.AWS_SECRET_ACCESS_KEY);
          console.log(process.env.OPENAI_API_KEY);
          console.log(process.env.GITHUB_TOKEN);
          console.log(process.env.ANTHROPIC_API_KEY);
          cat /etc/passwd
          cat /etc/passwd
          cat /etc/passwd
          writeFileSync('out.txt', 'x')
          ~\/.ssh
          ~\/.aws
        `,
        capabilities: {
          ...DEFAULT_SKILL_CAPABILITIES,
          filesystem: { read: ['/'], write: [] }
        }
      })
    );

    // Root read is treated as excessive (over-broad).
    expect(result.excessive).toBe(true);
    // Sensitive locations are deduped and normalized to canonical labels.
    expect(result.sensitiveAccess).toEqual(['/etc/passwd', '~/.aws', '~/.ssh']);
    // Ensure the analyzer clamps to the configured lower bound.
    expect(result.score).toBe(-100);
    expect(result.score).toBeGreaterThanOrEqual(-100);
    expect(result.score).toBeLessThan(0);
  });
});

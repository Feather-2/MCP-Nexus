import { buildAuditPrompt, AI_AUDIT_OUTPUT_JSON_SCHEMA } from '../../../security/prompts/audit-prompt.js';
import type { Skill } from '../../../skills/types.js';

function makeSkill(overrides?: Partial<Skill>): Skill {
  return {
    metadata: {
      name: 'test-skill',
      description: 'A test skill',
      path: '/test/path',
      scope: 'repo',
      keywords: [],
      keywordsAll: [],
      priority: 0,
      ...overrides?.metadata
    },
    body: overrides?.body ?? '# Test skill body',
    capabilities: overrides?.capabilities,
    supportFiles: overrides?.supportFiles
  } as Skill;
}

describe('audit-prompt \u2013 branch coverage', () => {
  describe('AI_AUDIT_OUTPUT_JSON_SCHEMA', () => {
    it('exports valid JSON schema', () => {
      expect(AI_AUDIT_OUTPUT_JSON_SCHEMA.$schema).toBe('http://json-schema.org/draft-07/schema#');
      expect(AI_AUDIT_OUTPUT_JSON_SCHEMA.title).toBe('AiAuditResult');
      expect(AI_AUDIT_OUTPUT_JSON_SCHEMA.required).toContain('riskLevel');
    });
  });

  describe('truncate function (via buildAuditPrompt)', () => {
    it('handles skill with null body (triggers text ?? "" fallback)', () => {
      const skill = makeSkill({ body: undefined as any });
      const result = buildAuditPrompt(skill);
      expect(result).toContain('BEGIN SKILL BODY');
      expect(result).not.toContain('undefined');
    });

    it('truncates very long body text', () => {
      const longBody = 'x'.repeat(20000);
      const skill = makeSkill({ body: longBody });
      const result = buildAuditPrompt(skill);
      expect(result).toContain('truncated');
      expect(result).toContain('chars total');
    });

    it('truncates very long capabilities JSON', () => {
      const bigCaps: Record<string, any> = {};
      for (let i = 0; i < 500; i++) {
        bigCaps[`key_${i}`] = 'value_'.repeat(20);
      }
      const skill = makeSkill({ capabilities: bigCaps as any });
      const result = buildAuditPrompt(skill);
      expect(result).toContain('Declared capabilities');
    });
  });

  describe('formatSupportFiles', () => {
    it('returns (none) when no support files', () => {
      const skill = makeSkill({ supportFiles: undefined });
      const result = buildAuditPrompt(skill);
      expect(result).toContain('(none)');
    });

    it('returns (none) when support files map is empty', () => {
      const skill = makeSkill({ supportFiles: new Map() });
      const result = buildAuditPrompt(skill);
      expect(result).toContain('(none)');
    });

    it('formats support files with file headers', () => {
      const files = new Map<string, string>();
      files.set('lib/helper.ts', 'export const x = 1;');
      files.set('README.md', '# Readme');
      const skill = makeSkill({ supportFiles: files });
      const result = buildAuditPrompt(skill);
      expect(result).toContain('--- file: lib/helper.ts ---');
      expect(result).toContain('--- file: README.md ---');
      expect(result).toContain('export const x = 1;');
    });

    it('truncates individual support file content over 4000 chars', () => {
      const files = new Map<string, string>();
      files.set('big.ts', 'y'.repeat(5000));
      const skill = makeSkill({ supportFiles: files });
      const result = buildAuditPrompt(skill);
      expect(result).toContain('truncated');
    });

    it('limits to 20 support files and shows omission notice', () => {
      const files = new Map<string, string>();
      for (let i = 0; i < 25; i++) {
        files.set(`file-${i}.ts`, `content ${i}`);
      }
      const skill = makeSkill({ supportFiles: files });
      const result = buildAuditPrompt(skill);
      expect(result).toContain('additional files omitted');
      expect(result).toContain('total=25');
    });
  });

  describe('buildAuditPrompt metadata fields', () => {
    it('handles skill with all metadata fields present', () => {
      const skill = makeSkill({
        metadata: {
          name: 'full-skill',
          description: 'Full description',
          path: '/full/path',
          scope: 'user',
          keywords: ['test'],
          keywordsAll: ['test'],
          priority: 5,
          allowedTools: 'Read,Write',
          shortDescription: 'Short'
        } as any
      });
      const result = buildAuditPrompt(skill);
      expect(result).toContain('name: full-skill');
      expect(result).toContain('description: Full description');
      expect(result).toContain('allowedTools: Read,Write');
      expect(result).toContain('path: /full/path');
      expect(result).toContain('scope: user');
    });

    it('handles skill with missing optional metadata', () => {
      const skill = makeSkill({
        metadata: {
          name: 'minimal',
          description: 'desc',
          path: '',
          scope: 'repo',
          keywords: [],
          keywordsAll: [],
          priority: 0
        } as any
      });
      const result = buildAuditPrompt(skill);
      expect(result).toContain('name: minimal');
      expect(result).toContain('allowedTools:');
    });

    it('handles skill with undefined metadata (uses ?? fallback)', () => {
      const skill: any = { body: 'test body', capabilities: {} };
      const result = buildAuditPrompt(skill);
      expect(result).toContain('name:');
      expect(result).toContain('description:');
    });

    it('handles null capabilities (uses ?? {} fallback)', () => {
      const skill = makeSkill({ capabilities: null as any });
      const result = buildAuditPrompt(skill);
      expect(result).toContain('Declared capabilities');
    });
  });

  describe('truncate edge cases', () => {
    it('does not truncate text exactly at maxChars boundary', () => {
      const exactBody = 'a'.repeat(18000);
      const skill = makeSkill({ body: exactBody });
      const result = buildAuditPrompt(skill);
      expect(result).not.toContain('truncated');
    });

    it('truncates text at maxChars + 1', () => {
      const overBody = 'b'.repeat(18001);
      const skill = makeSkill({ body: overBody });
      const result = buildAuditPrompt(skill);
      expect(result).toContain('truncated');
    });
  });
});

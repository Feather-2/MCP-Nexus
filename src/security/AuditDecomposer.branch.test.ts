import { AuditDecomposer } from './AuditDecomposer.js';
import type { Skill } from '../skills/types.js';

function makeSkill(overrides?: Partial<Skill>): Skill {
  return {
    metadata: {
      name: 'test', description: 'test', path: '/test', scope: 'repo',
      keywords: [], keywordsAll: [], priority: 0,
      ...overrides?.metadata
    },
    body: overrides?.body ?? '',
    capabilities: overrides?.capabilities,
    supportFiles: overrides?.supportFiles
  } as Skill;
}

describe('AuditDecomposer \u2013 branch coverage', () => {
  const decomposer = new AuditDecomposer();

  describe('extractToolUnits', () => {
    it('extracts ## Tool heading sections', () => {
      const skill = makeSkill({ body: '# Main\n## Tool: Search\nUse to search.\n## Other\nNot a tool.' });
      const result = decomposer.decompose(skill);
      const tools = result.units.filter(u => u.type === 'tool_definitions');
      expect(tools.length).toBeGreaterThanOrEqual(1);
    });

    it('extracts ### Tool heading', () => {
      const skill = makeSkill({ body: '# Main\n### Tool Usage\nSome tool info.' });
      const result = decomposer.decompose(skill);
      const tools = result.units.filter(u => u.type === 'tool_definitions');
      expect(tools.length).toBeGreaterThanOrEqual(1);
    });

    it('extracts allowedTools from metadata', () => {
      const skill = makeSkill({ metadata: { allowedTools: 'Read, Write, Bash' } as any });
      const result = decomposer.decompose(skill);
      const tools = result.units.filter(u => u.type === 'tool_definitions');
      expect(tools.find(t => t.content.includes('allowedTools'))).toBeDefined();
    });

    it('handles undefined body', () => {
      const skill = makeSkill({ body: undefined as any });
      const result = decomposer.decompose(skill);
      expect(result.units).toBeDefined();
    });
  });

  describe('extractFencedBlocks', () => {
    it('extracts code blocks with language', () => {
      const skill = makeSkill({ body: 'Text\n```typescript\nconst x = 1;\n```\nMore text' });
      const result = decomposer.decompose(skill);
      const code = result.units.filter(u => u.type === 'code_blocks');
      expect(code.length).toBe(1);
      expect(code[0]?.metadata?.language).toBe('typescript');
    });

    it('extracts code blocks without language', () => {
      const skill = makeSkill({ body: '```\necho hello\n```' });
      const result = decomposer.decompose(skill);
      const code = result.units.filter(u => u.type === 'code_blocks');
      expect(code.length).toBe(1);
    });

    it('skips empty code blocks', () => {
      const skill = makeSkill({ body: '```json\n\n```' });
      const result = decomposer.decompose(skill);
      const code = result.units.filter(u => u.type === 'code_blocks');
      expect(code.length).toBe(0);
    });

    it('extracts JSON blocks as parameter_schemas', () => {
      const skill = makeSkill({ body: '```json\n{"type": "string"}\n```' });
      const result = decomposer.decompose(skill);
      const schemas = result.units.filter(u => u.type === 'parameter_schemas');
      expect(schemas.length).toBe(1);
    });

    it('extracts yaml blocks as parameter_schemas', () => {
      const skill = makeSkill({ body: '```yaml\nkey: value\n```' });
      const result = decomposer.decompose(skill);
      const schemas = result.units.filter(u => u.type === 'parameter_schemas');
      expect(schemas.length).toBe(1);
    });

    it('extracts yml blocks as parameter_schemas', () => {
      const skill = makeSkill({ body: '```yml\nkey: value\n```' });
      const result = decomposer.decompose(skill);
      const schemas = result.units.filter(u => u.type === 'parameter_schemas');
      expect(schemas.length).toBe(1);
    });
  });

  describe('supportFiles', () => {
    it('extracts code blocks from support files', () => {
      const files = new Map<string, string>();
      files.set('lib/helper.ts', '```js\nconst y = 2;\n```');
      const skill = makeSkill({ supportFiles: files });
      const result = decomposer.decompose(skill);
      const code = result.units.filter(u => u.type === 'code_blocks');
      expect(code.length).toBeGreaterThanOrEqual(1);
    });

    it('uses fallback for support files without fenced blocks (.ts)', () => {
      const files = new Map<string, string>();
      files.set('lib/helper.ts', 'const z = 3;');
      const skill = makeSkill({ supportFiles: files });
      const result = decomposer.decompose(skill);
      const code = result.units.filter(u => u.type === 'code_blocks');
      expect(code.length).toBe(1);
    });

    it('uses fallback for .py files', () => {
      const files = new Map<string, string>();
      files.set('script.py', 'print("hello")');
      const skill = makeSkill({ supportFiles: files });
      const result = decomposer.decompose(skill);
      const code = result.units.filter(u => u.type === 'code_blocks');
      expect(code.length).toBe(1);
    });

    it('skips non-code files (.md)', () => {
      const files = new Map<string, string>();
      files.set('README.md', '# Readme');
      const skill = makeSkill({ supportFiles: files });
      const result = decomposer.decompose(skill);
      const code = result.units.filter(u => u.type === 'code_blocks');
      expect(code.length).toBe(0);
    });

    it('uses fallback for .sh files', () => {
      const files = new Map<string, string>();
      files.set('setup.sh', '#!/bin/bash\necho hi');
      const skill = makeSkill({ supportFiles: files });
      const result = decomposer.decompose(skill);
      const code = result.units.filter(u => u.type === 'code_blocks');
      expect(code.length).toBe(1);
    });
  });

  describe('detectDataFlows', () => {
    it('detects fetch() calls', () => {
      const skill = makeSkill({ body: '```js\nfetch("https://api.example.com")\n```' });
      const result = decomposer.decompose(skill);
      const flows = result.units.filter(u => u.type === 'data_flows');
      expect(flows.find(f => (f.metadata?.kind as string) === 'network')).toBeDefined();
    });

    it('detects axios calls', () => {
      const skill = makeSkill({ body: '```js\naxios.get("/api")\n```' });
      const result = decomposer.decompose(skill);
      const flows = result.units.filter(u => u.type === 'data_flows');
      expect(flows.find(f => (f.metadata?.kind as string) === 'network')).toBeDefined();
    });

    it('detects process.env access', () => {
      const skill = makeSkill({ body: '```js\nconst key = process.env.API_KEY;\n```' });
      const result = decomposer.decompose(skill);
      const flows = result.units.filter(u => u.type === 'data_flows');
      expect(flows.find(f => (f.metadata?.kind as string) === 'env')).toBeDefined();
    });

    it('detects process.env bracket access', () => {
      const skill = makeSkill({ body: '```js\nconst key = process.env["SECRET"];\n```' });
      const result = decomposer.decompose(skill);
      const flows = result.units.filter(u => u.type === 'data_flows');
      expect(flows.find(f => (f.metadata?.kind as string) === 'env')).toBeDefined();
    });

    it('detects fs.readFile', () => {
      const skill = makeSkill({ body: '```js\nfs.readFile("/etc/passwd", cb)\n```' });
      const result = decomposer.decompose(skill);
      const flows = result.units.filter(u => u.type === 'data_flows');
      expect(flows.find(f => (f.metadata?.kind as string) === 'file_io')).toBeDefined();
    });

    it('detects fs.writeFileSync', () => {
      const skill = makeSkill({ body: '```js\nfs.writeFileSync("/tmp/out", data)\n```' });
      const result = decomposer.decompose(skill);
      const flows = result.units.filter(u => u.type === 'data_flows');
      expect(flows.find(f => (f.metadata?.kind as string) === 'file_io')).toBeDefined();
    });
  });

  describe('detectImports', () => {
    it('detects ES import from', () => {
      const skill = makeSkill({ body: '```js\nimport { foo } from "bar";\n```' });
      const result = decomposer.decompose(skill);
      const imports = result.units.filter(u => u.type === 'imports');
      expect(imports[0]?.metadata?.target).toBe('bar');
    });

    it('detects require()', () => {
      const skill = makeSkill({ body: '```js\nconst x = require("fs");\n```' });
      const result = decomposer.decompose(skill);
      const imports = result.units.filter(u => u.type === 'imports');
      expect(imports[0]?.metadata?.target).toBe('fs');
    });

    it('detects bare import (side-effect)', () => {
      const skill = makeSkill({ body: '```js\nimport "./polyfill";\n```' });
      const result = decomposer.decompose(skill);
      const imports = result.units.filter(u => u.type === 'imports');
      expect(imports[0]?.metadata?.target).toBe('./polyfill');
    });

    it('handles import with no recognizable target', () => {
      const skill = makeSkill({ body: '```js\nimport * as x from "module";\n```' });
      const result = decomposer.decompose(skill);
      const imports = result.units.filter(u => u.type === 'imports');
      expect(imports[0]?.metadata?.target).toBe('module');
    });
  });

  describe('buildSummary', () => {
    it('produces summary string', () => {
      const skill = makeSkill({
        body: '## Tool: X\nDesc\n```json\n{}\n```\n```js\nfetch("x")\nimport "y"\n```',
        metadata: { allowedTools: 'Read' } as any
      });
      const result = decomposer.decompose(skill);
      expect(result.summary).toContain('tool definitions');
      expect(result.summary).toContain('code blocks');
    });
  });

  describe('lineAt edge cases', () => {
    it('handles offset 0', () => {
      const skill = makeSkill({ body: '```js\nline1\n```' });
      const result = decomposer.decompose(skill);
      expect(result.units.length).toBeGreaterThan(0);
    });
  });

  describe('no supportFiles', () => {
    it('handles skill with no supportFiles', () => {
      const skill = makeSkill({ supportFiles: undefined });
      const result = decomposer.decompose(skill);
      expect(result.units).toBeDefined();
    });
  });
});

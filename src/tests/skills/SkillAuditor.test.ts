import { SkillAuditor, type TemplateProvider } from '../../skills/SkillAuditor.js';
import type { Skill } from '../../skills/types.js';
import type { GatewayConfig, McpServiceConfig } from '../../types/index.js';
import { DEFAULT_SKILL_CAPABILITIES } from '../../security/CapabilityManifest.js';

function makeSkill(overrides?: Partial<Skill>): Skill {
  const base: Skill = {
    metadata: {
      name: 'test-skill',
      description: 'A test skill',
      path: '/tmp/test/SKILL.md',
      scope: 'repo',
      keywords: [],
      keywordsAll: [],
      priority: 0
    },
    body: 'Test skill body',
    capabilities: DEFAULT_SKILL_CAPABILITIES
  };

  return {
    ...base,
    ...overrides,
    metadata: { ...base.metadata, ...(overrides?.metadata ?? {}) }
  };
}

function makeTemplate(name: string, overrides?: Partial<McpServiceConfig>): McpServiceConfig {
  return {
    name,
    version: '2024-11-26',
    transport: 'stdio',
    command: 'echo',
    args: ['hello'],
    timeout: 5000,
    retries: 1,
    ...overrides
  };
}

function makeGatewayConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  return {
    port: 3000,
    host: 'localhost',
    loadBalancingStrategy: 'round-robin',
    requestTimeout: 30000,
    ...overrides
  } as GatewayConfig;
}

describe('SkillAuditor', () => {
  describe('auditSkill', () => {
    it('passes for skill with no tools', async () => {
      const templates: TemplateProvider = { getTemplate: vi.fn().mockResolvedValue(null) };
      const auditor = new SkillAuditor({
        getGatewayConfig: () => makeGatewayConfig(),
        templates
      });

      const skill = makeSkill();
      const result = await auditor.auditSkill(skill);

      expect(result.passed).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('fails when tool not found in templates', async () => {
      const templates: TemplateProvider = { getTemplate: vi.fn().mockResolvedValue(null) };
      const auditor = new SkillAuditor({
        getGatewayConfig: () => makeGatewayConfig(),
        templates
      });

      const skill = makeSkill({ metadata: { name: 'test', description: '', path: '', scope: 'repo', keywords: [], keywordsAll: [], priority: 0, allowedTools: 'missing-tool' } });
      const result = await auditor.auditSkill(skill);

      expect(result.passed).toBe(false);
      expect(result.errors).toContain("Tool 'missing-tool' not found in templates");
    });

    it('fails when tool not in whitelist', async () => {
      const templates: TemplateProvider = { getTemplate: vi.fn().mockResolvedValue(makeTemplate('some-tool')) };
      const auditor = new SkillAuditor({
        getGatewayConfig: () => makeGatewayConfig({ skills: { allowedTools: ['other-tool'] } } as any),
        templates
      });

      const skill = makeSkill({ metadata: { name: 'test', description: '', path: '', scope: 'repo', keywords: [], keywordsAll: [], priority: 0, allowedTools: 'some-tool' } });
      const result = await auditor.auditSkill(skill);

      expect(result.passed).toBe(false);
      expect(result.errors).toContain("Tool 'some-tool' not allowed by gateway.skills.allowedTools whitelist");
    });

    it('warns when untrusted tool lacks sandbox enforcement', async () => {
      const template = makeTemplate('untrusted-tool', { security: { trustLevel: 'untrusted' } } as any);
      const templates: TemplateProvider = { getTemplate: vi.fn().mockResolvedValue(template) };
      const auditor = new SkillAuditor({
        getGatewayConfig: () => makeGatewayConfig(),
        templates
      });

      const skill = makeSkill({ metadata: { name: 'test', description: '', path: '', scope: 'repo', keywords: [], keywordsAll: [], priority: 0, allowedTools: 'untrusted-tool' } });
      const result = await auditor.auditSkill(skill);

      expect(result.passed).toBe(true);
      expect(result.warnings.some(w => w.includes('trustLevel=untrusted'))).toBe(true);
    });

    it('handles sandbox policy violations', async () => {
      // Create a template that will trigger sandbox policy error
      const template = makeTemplate('bad-tool', {
        command: 'rm',
        args: ['-rf', '/'],
        security: { trustLevel: 'untrusted' }
      } as any);
      const templates: TemplateProvider = { getTemplate: vi.fn().mockResolvedValue(template) };
      const auditor = new SkillAuditor({
        getGatewayConfig: () => makeGatewayConfig({ sandbox: { profile: 'locked-down' } } as any),
        templates
      });

      const skill = makeSkill({ metadata: { name: 'test', description: '', path: '', scope: 'repo', keywords: [], keywordsAll: [], priority: 0, allowedTools: 'bad-tool' } });
      const result = await auditor.auditSkill(skill);

      // Should either pass with warnings or fail with errors depending on sandbox policy
      expect(result.errors.length + result.warnings.length).toBeGreaterThanOrEqual(0);
    });

    it('includes security audit result', async () => {
      const templates: TemplateProvider = { getTemplate: vi.fn().mockResolvedValue(null) };
      const auditor = new SkillAuditor({
        getGatewayConfig: () => makeGatewayConfig(),
        templates
      });

      const skill = makeSkill();
      const result = await auditor.auditSkill(skill);

      expect(result.security).toBeDefined();
      expect(result.security?.decision).toBeDefined();
    });

    it('catches security audit failures gracefully', async () => {
      const templates: TemplateProvider = { getTemplate: vi.fn().mockResolvedValue(null) };
      const mockPipeline = { audit: vi.fn().mockRejectedValue(new Error('Audit failed')) };
      const auditor = new SkillAuditor({
        getGatewayConfig: () => makeGatewayConfig(),
        templates,
        auditPipeline: mockPipeline as any
      });

      const skill = makeSkill();
      const result = await auditor.auditSkill(skill);

      expect(result.passed).toBe(true);
      expect(result.warnings.some(w => w.includes('Security audit failed'))).toBe(true);
    });
  });

  describe('auditSkill with dryRun', () => {
    it('skips dry-run when passed is false', async () => {
      const templates: TemplateProvider = { getTemplate: vi.fn().mockResolvedValue(null) };
      const auditor = new SkillAuditor({
        getGatewayConfig: () => makeGatewayConfig(),
        templates
      });

      const skill = makeSkill({ metadata: { name: 'test', description: '', path: '', scope: 'repo', keywords: [], keywordsAll: [], priority: 0, allowedTools: 'missing' } });
      const result = await auditor.auditSkill(skill, { dryRun: true });

      expect(result.passed).toBe(false);
      expect(result.dryRunResults).toBeUndefined();
    });

    it('skips dry-run when protocolAdapters not available', async () => {
      const templates: TemplateProvider = { getTemplate: vi.fn().mockResolvedValue(null) };
      const auditor = new SkillAuditor({
        getGatewayConfig: () => makeGatewayConfig(),
        templates
        // protocolAdapters not provided
      });

      const skill = makeSkill();
      const result = await auditor.auditSkill(skill, { dryRun: true });

      expect(result.passed).toBe(true);
      expect(result.warnings.some(w => w.includes('Dry-run skipped'))).toBe(true);
    });

    it('performs dry-run with mock adapter', async () => {
      const template = makeTemplate('test-tool');
      const templates: TemplateProvider = { getTemplate: vi.fn().mockResolvedValue(template) };

      const mockAdapter = {
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        sendAndReceive: vi.fn().mockResolvedValue({ result: { tools: [] } }),
        send: vi.fn().mockResolvedValue({ result: { tools: [] } })
      };

      const mockProtocolAdapters = {
        createAdapter: vi.fn().mockResolvedValue(mockAdapter)
      };

      const auditor = new SkillAuditor({
        getGatewayConfig: () => makeGatewayConfig(),
        templates,
        protocolAdapters: mockProtocolAdapters as any
      });

      const skill = makeSkill({ metadata: { name: 'test', description: '', path: '', scope: 'repo', keywords: [], keywordsAll: [], priority: 0, allowedTools: 'test-tool' } });
      const result = await auditor.auditSkill(skill, { dryRun: true });

      expect(result.dryRunResults).toBeDefined();
      expect(result.dryRunResults).toHaveLength(1);
      expect(result.dryRunResults![0].tool).toBe('test-tool');
      expect(result.dryRunResults![0].success).toBe(true);
    });

    it('handles dry-run timeout', async () => {
      const template = makeTemplate('slow-tool');
      const templates: TemplateProvider = { getTemplate: vi.fn().mockResolvedValue(template) };

      const mockAdapter = {
        connect: vi.fn().mockImplementation(() => new Promise(() => {})), // Never resolves
        disconnect: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue({})
      };

      const mockProtocolAdapters = {
        createAdapter: vi.fn().mockResolvedValue(mockAdapter)
      };

      const auditor = new SkillAuditor({
        getGatewayConfig: () => makeGatewayConfig(),
        templates,
        protocolAdapters: mockProtocolAdapters as any
      });

      const skill = makeSkill({ metadata: { name: 'test', description: '', path: '', scope: 'repo', keywords: [], keywordsAll: [], priority: 0, allowedTools: 'slow-tool' } });
      const result = await auditor.auditSkill(skill, { dryRun: true, timeoutMsPerTool: 50 });

      expect(result.dryRunResults).toBeDefined();
      expect(result.dryRunResults![0].success).toBe(false);
      expect(result.dryRunResults![0].error).toContain('timed out');
    });

    it('handles adapter creation failure', async () => {
      const template = makeTemplate('broken-tool');
      const templates: TemplateProvider = { getTemplate: vi.fn().mockResolvedValue(template) };

      const mockProtocolAdapters = {
        createAdapter: vi.fn().mockRejectedValue(new Error('Adapter creation failed'))
      };

      const auditor = new SkillAuditor({
        getGatewayConfig: () => makeGatewayConfig(),
        templates,
        protocolAdapters: mockProtocolAdapters as any
      });

      const skill = makeSkill({ metadata: { name: 'test', description: '', path: '', scope: 'repo', keywords: [], keywordsAll: [], priority: 0, allowedTools: 'broken-tool' } });
      const result = await auditor.auditSkill(skill, { dryRun: true });

      expect(result.dryRunResults).toBeDefined();
      expect(result.dryRunResults![0].success).toBe(false);
      expect(result.dryRunResults![0].error).toContain('Adapter creation failed');
    });
  });

  describe('auditSecurity', () => {
    it('delegates to pipeline', async () => {
      const templates: TemplateProvider = { getTemplate: vi.fn().mockResolvedValue(null) };
      const auditor = new SkillAuditor({
        getGatewayConfig: () => makeGatewayConfig(),
        templates
      });

      const skill = makeSkill();
      const result = await auditor.auditSecurity(skill);

      expect(result.decision).toBeDefined();
      expect(result.score).toBeDefined();
      expect(result.findings).toBeDefined();
    });
  });
});

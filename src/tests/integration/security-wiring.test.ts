import { spawn } from 'child_process';
import { SkillAuditor, type TemplateProvider } from '../../skills/SkillAuditor.js';
import { StdioTransportAdapter } from '../../adapters/StdioTransportAdapter.js';
import { CommandValidator, DEFAULT_BANNED_COMMANDS } from '../../security/command-validator.js';
import { DEFAULT_SKILL_CAPABILITIES } from '../../security/CapabilityManifest.js';
import type { Skill } from '../../skills/types.js';
import type { GatewayConfig, Logger, McpServiceConfig } from '../../types/index.js';

vi.mock('child_process');

function createLogger(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

function makeGatewayConfig(): GatewayConfig {
  return {
    port: 3000,
    host: 'localhost',
    loadBalancingStrategy: 'round-robin',
    requestTimeout: 30_000
  } as GatewayConfig;
}

function makeTemplate(name: string): McpServiceConfig {
  return {
    name,
    version: '2024-11-26',
    transport: 'stdio',
    command: process.execPath,
    args: ['--version'],
    timeout: 5000,
    retries: 1
  };
}

function makeSkill(allowedTools: string): Skill {
  return {
    metadata: {
      name: 'security-wiring-skill',
      description: 'Integration test skill',
      path: '/tmp/security-wiring/SKILL.md',
      scope: 'repo',
      keywords: [],
      keywordsAll: [],
      priority: 0,
      allowedTools
    },
    body: 'integration test body',
    capabilities: DEFAULT_SKILL_CAPABILITIES
  };
}

describe('security wiring integration', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('integrates CanarySystem with SkillAuditor dryRun', async () => {
    const template = makeTemplate('canary-tool');
    const templates: TemplateProvider = {
      getTemplate: vi.fn().mockResolvedValue(template)
    };

    const mockAdapter = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      sendAndReceive: vi.fn().mockResolvedValue({ result: { tools: [] } }),
      send: vi.fn().mockResolvedValue({ result: { tools: [] } })
    };

    const mockProtocolAdapters = {
      createAdapter: vi.fn().mockResolvedValue(mockAdapter),
      releaseAdapter: vi.fn()
    };

    const auditor = new SkillAuditor({
      logger: createLogger(),
      getGatewayConfig: () => makeGatewayConfig(),
      templates,
      protocolAdapters: mockProtocolAdapters as any
    });

    const result = await auditor.auditSkill(makeSkill('canary-tool'), { dryRun: true });

    expect(mockProtocolAdapters.createAdapter).toHaveBeenCalledTimes(1);
    expect(mockAdapter.connect).toHaveBeenCalledTimes(1);
    expect(mockAdapter.sendAndReceive).toHaveBeenCalledTimes(1);
    expect(mockProtocolAdapters.releaseAdapter).toHaveBeenCalledTimes(1);
    expect(result.dryRunResults).toBeDefined();
    expect(result.dryRunResults).toHaveLength(1);
    expect(result.dryRunResults?.[0]?.success).toBe(true);
  });

  it('integrates CommandValidator with StdioTransportAdapter', async () => {
    vi.mocked(spawn).mockReturnValue({} as any);

    const adapter = new StdioTransportAdapter(
      {
        name: 'blocked-command-service',
        version: '2024-11-26',
        transport: 'stdio',
        command: 'dd',
        args: [],
        timeout: 1000,
        retries: 0
      },
      createLogger()
    );

    await expect(adapter.connect()).rejects.toThrow(/Command blocked/i);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it('checks CommandValidator defaults and behavior', () => {
    expect(DEFAULT_BANNED_COMMANDS).toMatchObject({
      dd: expect.any(String),
      mkfs: expect.any(String),
      fdisk: expect.any(String),
      shutdown: expect.any(String),
      reboot: expect.any(String),
      halt: expect.any(String),
      sudo: expect.any(String),
      mount: expect.any(String)
    });

    const validator = new CommandValidator();

    expect(() => validator.validate('node')).not.toThrow();
    expect(() => validator.validate('dd')).toThrow(/banned command/i);
  });
});

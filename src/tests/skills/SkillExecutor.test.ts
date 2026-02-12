import { SkillExecutor } from '../../skills/SkillExecutor.js';
import type { Skill } from '../../skills/types.js';

function makeSkill(): Skill {
  return {
    metadata: {
      name: 'runtime-guard',
      description: 'Runtime guard test',
      path: '/tmp/runtime/SKILL.md',
      scope: 'repo',
      keywords: [],
      keywordsAll: [],
      priority: 0
    },
    body: 'test',
    capabilities: {
      filesystem: {
        read: ['/workspace'],
        write: ['/workspace/output']
      },
      network: {
        allowedHosts: ['api.example.com'],
        allowedPorts: [443]
      },
      env: [],
      subprocess: {
        allowed: true,
        allowedCommands: ['git']
      },
      resources: {
        maxMemoryMB: 256,
        maxCpuPercent: 50,
        timeoutMs: 30_000
      }
    }
  };
}

describe('SkillExecutor', () => {
  it('allows whitelisted filesystem/network/subprocess requests', async () => {
    const executor = new SkillExecutor();
    const skill = makeSkill();

    expect(() =>
      executor.validate(skill, { type: 'filesystem', operation: 'read', path: '/workspace/file.txt' })
    ).not.toThrow();
    expect(() =>
      executor.validate(skill, { type: 'network', host: 'api.example.com', port: 443 })
    ).not.toThrow();
    expect(() =>
      executor.validate(skill, { type: 'subprocess', command: '/usr/bin/git', argv: ['status'] })
    ).not.toThrow();

    const result = await executor.execute(
      skill,
      { type: 'filesystem', operation: 'write', path: '/workspace/output/result.txt' },
      async () => 'ok'
    );
    expect(result).toBe('ok');
  });

  it('blocks filesystem access outside whitelist', () => {
    const executor = new SkillExecutor();
    const skill = makeSkill();

    expect(() =>
      executor.validate(skill, { type: 'filesystem', operation: 'read', path: '/etc/passwd' })
    ).toThrow('not allowed');
  });

  it('blocks network access outside whitelist', () => {
    const executor = new SkillExecutor();
    const skill = makeSkill();

    expect(() =>
      executor.validate(skill, { type: 'network', host: 'evil.example.net', port: 443 })
    ).toThrow('not allowed');
  });

  it('blocks subprocess commands outside whitelist and prevents execution', async () => {
    const executor = new SkillExecutor();
    const skill = makeSkill();
    const run = vi.fn(async () => 'unexpected');

    await expect(
      executor.execute(skill, { type: 'subprocess', command: 'curl', argv: ['https://example.com'] }, run)
    ).rejects.toThrow('not allowed');
    expect(run).not.toHaveBeenCalled();
  });
});

import type { Skill } from '../../skills/types.js';
import { DEFAULT_SKILL_CAPABILITIES } from '../../security/CapabilityManifest.js';
import { AiAuditor, type LlmCallEvent } from '../../security/AiAuditor.js';

function makeSkill(body: string): Skill {
  return {
    metadata: {
      name: 'test-skill', description: 'test', path: '/tmp/test/SKILL.md',
      scope: 'repo', keywords: [], keywordsAll: [], priority: 0,
      allowedTools: 'filesystem'
    },
    body,
    capabilities: DEFAULT_SKILL_CAPABILITIES
  };
}

describe('AiAuditor LLM call observability', () => {
  it('fires onLlmCall with success=true on successful audit', async () => {
    const events: LlmCallEvent[] = [];
    const client = {
      generate: vi.fn(async () => ({
        text: JSON.stringify({
          riskLevel: 'safe', confidence: 0.9, findings: [],
          recommendation: 'approve', explanation: 'ok'
        })
      }))
    };

    const auditor = new AiAuditor(client as any, {
      model: 'test-model',
      maxTokens: 500,
      onLlmCall: (evt) => { events.push(evt); }
    });

    await auditor.auditSkill(makeSkill('Read a file.'));

    expect(events.length).toBe(1);
    expect(events[0].operation).toBe('auditSkill');
    expect(events[0].model).toBe('test-model');
    expect(events[0].maxTokens).toBe(500);
    expect(events[0].success).toBe(true);
    expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(events[0].error).toBeUndefined();
  });

  it('fires onLlmCall with success=false when client throws', async () => {
    const events: LlmCallEvent[] = [];
    const client = {
      generate: vi.fn(async () => { throw new Error('network-fail'); })
    };

    const auditor = new AiAuditor(client as any, {
      onLlmCall: (evt) => { events.push(evt); }
    });

    const result = await auditor.auditSkill(makeSkill('Do something.'));

    expect(result.riskLevel).toBe('suspicious');
    expect(result.confidence).toBe(0);
    expect(events.length).toBe(1);
    expect(events[0].success).toBe(false);
    expect(events[0].error).toBe('network-fail');
    expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('works without onLlmCall callback (no crash)', async () => {
    const client = {
      generate: vi.fn(async () => ({
        text: JSON.stringify({
          riskLevel: 'safe', confidence: 0.5, findings: [],
          recommendation: 'approve', explanation: ''
        })
      }))
    };

    const auditor = new AiAuditor(client as any);
    const result = await auditor.auditSkill(makeSkill('Hello'));
    expect(result.riskLevel).toBe('safe');
  });

  it('records durationMs accurately', async () => {
    const events: LlmCallEvent[] = [];
    const client = {
      generate: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return {
          text: JSON.stringify({
            riskLevel: 'safe', confidence: 0.8, findings: [],
            recommendation: 'approve', explanation: ''
          })
        };
      })
    };

    const auditor = new AiAuditor(client as any, {
      onLlmCall: (evt) => { events.push(evt); }
    });

    await auditor.auditSkill(makeSkill('Slow call'));

    expect(events.length).toBe(1);
    expect(events[0].durationMs).toBeGreaterThanOrEqual(40);
  });
});

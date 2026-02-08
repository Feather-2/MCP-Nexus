import { describe, expect, it, vi } from 'vitest';
import type { Skill } from '../../skills/types.js';
import { DEFAULT_SKILL_CAPABILITIES } from '../../security/CapabilityManifest.js';
import { AuditPipeline } from '../../security/AuditPipeline.js';
import { AuditResultCache } from '../../security/AuditResultCache.js';

function makeSkill(body: string, overrides?: Partial<Skill>): Skill {
  return {
    metadata: { name: 'test-skill', description: 'test', path: '/tmp/test/SKILL.md', scope: 'repo', keywords: [], keywordsAll: [], priority: 0 },
    body,
    capabilities: DEFAULT_SKILL_CAPABILITIES,
    ...overrides
  };
}

function baseMocks(overrides?: any) {
  return {
    hardRuleEngine: { evaluate: vi.fn().mockReturnValue({ rejected: false }) },
    entropyAnalyzer: { analyzeContent: vi.fn().mockReturnValue({ highEntropyBlocks: [], averageEntropy: 1, suspicious: false }) },
    permissionAnalyzer: { analyzePermissions: vi.fn().mockReturnValue({ excessive: false, sensitiveAccess: [], score: 0 }) },
    riskScorer: { score: vi.fn().mockReturnValue({ decision: 'approve', score: 100, reviewRequired: false, reason: 'ok' }) },
    ...overrides
  };
}

describe('AuditPipeline – extended coverage', () => {
  // ── auditSync ──────────────────────────────────────

  it('auditSync returns reject when hard rule hits', () => {
    const mocks = baseMocks({ hardRuleEngine: { evaluate: vi.fn().mockReturnValue({ rejected: true, reason: 'bad' }) } });
    const p = new AuditPipeline(mocks as any);
    const r = p.auditSync(makeSkill('x'));
    expect(r.decision).toBe('reject');
    expect(r.score).toBe(0);
  });

  it('auditSync returns reject when hard rule hits without reason', () => {
    const mocks = baseMocks({ hardRuleEngine: { evaluate: vi.fn().mockReturnValue({ rejected: true }) } });
    const p = new AuditPipeline(mocks as any);
    const r = p.auditSync(makeSkill('x'));
    expect(r.decision).toBe('reject');
    expect(r.findings).toEqual([]);
  });

  it('auditSync returns approve for clean skill', () => {
    const p = new AuditPipeline(baseMocks() as any);
    const r = p.auditSync(makeSkill('safe'));
    expect(r.decision).toBe('approve');
    expect(r.score).toBe(100);
  });

  it('auditSync returns provisional_approve for mid-range score', () => {
    const mocks = baseMocks({
      riskScorer: { score: vi.fn().mockReturnValue({ decision: 'review', score: 55, reviewRequired: true, reason: 'mid' }) }
    });
    const p = new AuditPipeline(mocks as any);
    const r = p.auditSync(makeSkill('suspicious'));
    // Score 55 is between 40 and 70 => provisional_approve
    expect(r.decision).toBe('provisional_approve');
  });

  it('auditSync returns reject for very low score', () => {
    const mocks = baseMocks({
      riskScorer: { score: vi.fn().mockReturnValue({ decision: 'reject', score: 20, reviewRequired: false, reason: 'low' }) }
    });
    const p = new AuditPipeline(mocks as any);
    const r = p.auditSync(makeSkill('bad'));
    expect(r.decision).toBe('reject');
  });

  it('auditSync includes entropy findings when suspicious', () => {
    const mocks = baseMocks({
      entropyAnalyzer: { analyzeContent: vi.fn().mockReturnValue({ highEntropyBlocks: [{ value: 'x', entropy: 5 }], averageEntropy: 5, suspicious: true }) }
    });
    const p = new AuditPipeline(mocks as any);
    const r = p.auditSync(makeSkill('encoded'));
    expect(r.findings.some(f => f.source === 'entropy')).toBe(true);
  });

  it('auditSync includes permission findings when score < 0', () => {
    const mocks = baseMocks({
      permissionAnalyzer: { analyzePermissions: vi.fn().mockReturnValue({ excessive: true, sensitiveAccess: ['~/.ssh'], score: -30 }) }
    });
    const p = new AuditPipeline(mocks as any);
    const r = p.auditSync(makeSkill('fs access'));
    expect(r.findings.some(f => f.source === 'permission')).toBe(true);
  });

  it('auditSync applies surgical audit when decomposer and router provided', () => {
    const decomposer = { decompose: vi.fn().mockReturnValue({ units: [], summary: 'test' }) };
    const auditRouter = { route: vi.fn().mockReturnValue({ findings: [{ auditSkill: 'test', severity: 'low', message: 'ok' }], score: 80 }) };
    const mocks = baseMocks({ decomposer, auditRouter });
    const p = new AuditPipeline({ ...mocks, decomposer, auditRouter } as any);
    const r = p.auditSync(makeSkill('body'));
    expect(r.findings.some(f => f.source.startsWith('audit_skill'))).toBe(true);
  });

  it('auditSync handles surgical audit failure gracefully', () => {
    const decomposer = { decompose: vi.fn().mockImplementation(() => { throw new Error('decompose fail'); }) };
    const auditRouter = { route: vi.fn() };
    const mocks = baseMocks({ decomposer, auditRouter });
    const p = new AuditPipeline({ ...mocks, decomposer, auditRouter } as any);
    const r = p.auditSync(makeSkill('body'));
    expect(r.findings.some(f => f.message === 'Surgical audit failed')).toBe(true);
  });

  it('auditSync adds surgical audit signal when score < 50', () => {
    const decomposer = { decompose: vi.fn().mockReturnValue({ units: [], summary: 'low' }) };
    const auditRouter = { route: vi.fn().mockReturnValue({ findings: [], score: 30 }) };
    const mocks = baseMocks({ decomposer, auditRouter });
    const p = new AuditPipeline({ ...mocks, decomposer, auditRouter } as any);
    p.auditSync(makeSkill('body'));
    expect(mocks.riskScorer.score).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ source: 'audit_skill' })])
    );
  });

  // ── collectTextSources with supportFiles ────────────

  it('auditSync handles skill with supportFiles', () => {
    const supportFiles = new Map([['helper.ts', 'export const x = 1;']]);
    const skill = makeSkill('main body', { supportFiles });
    const p = new AuditPipeline(baseMocks() as any);
    const r = p.auditSync(skill);
    expect(r.decision).toBe('approve');
  });

  it('auditSync handles skill with allowedTools in metadata', () => {
    const skill = makeSkill('body');
    skill.metadata.allowedTools = 'Read,Write,Bash';
    const p = new AuditPipeline(baseMocks() as any);
    const r = p.auditSync(skill);
    expect(r.decision).toBe('approve');
  });

  // ── auditAsync ──────────────────────────────────────

  it('auditAsync returns cached result if available', () => {
    const cache = new AuditResultCache();
    const skill = makeSkill('cached');
    const cachedResult = { decision: 'approve' as const, score: 95, findings: [], reviewRequired: false };
    const hash = (new AuditPipeline(baseMocks() as any) as any).hashSkillContent(skill);
    cache.set(AuditResultCache.makeKey('test-skill', hash), cachedResult);

    const p = new AuditPipeline({ ...baseMocks(), resultCache: cache } as any);
    const result = p.auditAsync(skill);
    expect(result.syncResult.decision).toBe('approve');
    expect(result.asyncHandle).toBeUndefined();
  });

  it('auditAsync caches non-provisional result', () => {
    const p = new AuditPipeline(baseMocks() as any);
    const result = p.auditAsync(makeSkill('clean'));
    expect(result.syncResult.decision).toBe('approve');
    expect(result.asyncHandle).toBeUndefined();
    // Result should be cached
    expect(p.getResultCache().size()).toBe(1);
  });

  it('auditAsync converts provisional to review when no AI auditor', () => {
    const mocks = baseMocks({
      riskScorer: { score: vi.fn().mockReturnValue({ decision: 'review', score: 55, reviewRequired: true, reason: 'mid' }) }
    });
    const p = new AuditPipeline(mocks as any);
    const result = p.auditAsync(makeSkill('mid'));
    expect(result.syncResult.decision).toBe('review');
    expect(result.asyncHandle).toBeUndefined();
  });

  it('auditAsync creates async handle when AI auditor available and provisional', () => {
    const aiAuditor = {
      auditSkill: vi.fn().mockResolvedValue({
        riskLevel: 'safe', confidence: 1, findings: [], recommendation: 'approve', explanation: 'ok'
      })
    };
    const mocks = baseMocks({
      aiAuditor,
      riskScorer: { score: vi.fn().mockReturnValue({ decision: 'review', score: 55, reviewRequired: true, reason: 'mid' }) }
    });
    const p = new AuditPipeline(mocks as any);
    const result = p.auditAsync(makeSkill('mid'));
    expect(result.asyncHandle).toBeDefined();
    expect(result.asyncHandle!.status).toBe('pending');
    expect(result.asyncHandle!.requestId).toMatch(/^audit-/);
  });

  it('auditAsync resolves async handle with full audit result', async () => {
    const aiAuditor = {
      auditSkill: vi.fn().mockResolvedValue({
        riskLevel: 'safe', confidence: 1, findings: [], recommendation: 'approve', explanation: 'ok'
      })
    };
    const mocks = baseMocks({
      aiAuditor,
      riskScorer: { score: vi.fn().mockReturnValue({ decision: 'approve', score: 55, reviewRequired: true, reason: 'mid' }) }
    });
    // First call returns score 55 (provisional), second call (full audit) returns 100
    mocks.riskScorer.score
      .mockReturnValueOnce({ decision: 'review', score: 55, reviewRequired: true, reason: 'mid' })
      .mockReturnValueOnce({ decision: 'approve', score: 100, reviewRequired: false, reason: 'ok' });
    const p = new AuditPipeline(mocks as any);
    const result = p.auditAsync(makeSkill('mid'));
    expect(result.asyncHandle).toBeDefined();

    const fullResult = await result.asyncHandle!.getResult();
    expect(fullResult.decision).toBe('approve');
  });

  // ── getAsyncAuditStatus ──────────────────────────────

  it('getAsyncAuditStatus returns not_found for unknown ID', () => {
    const p = new AuditPipeline(baseMocks() as any);
    expect(p.getAsyncAuditStatus('nope')).toEqual({ status: 'not_found' });
  });

  it('getAsyncAuditStatus returns pending then completed', async () => {
    const aiAuditor = {
      auditSkill: vi.fn().mockResolvedValue({
        riskLevel: 'safe', confidence: 1, findings: [], recommendation: 'approve', explanation: 'ok'
      })
    };
    const mocks = baseMocks({
      aiAuditor,
      riskScorer: { score: vi.fn().mockReturnValue({ decision: 'review', score: 55, reviewRequired: true, reason: 'mid' }) }
    });
    mocks.riskScorer.score
      .mockReturnValueOnce({ decision: 'review', score: 55, reviewRequired: true, reason: 'mid' })
      .mockReturnValueOnce({ decision: 'approve', score: 100, reviewRequired: false, reason: 'ok' });
    const p = new AuditPipeline(mocks as any);
    const result = p.auditAsync(makeSkill('mid'));
    const reqId = result.asyncHandle!.requestId;

    await result.asyncHandle!.getResult();
    const status = p.getAsyncAuditStatus(reqId);
    expect(status.status).toBe('completed');
    expect(status.result).toBeDefined();
  });

  // ── getResultCache ──────────────────────────────────

  it('getResultCache returns the cache instance', () => {
    const cache = new AuditResultCache();
    const p = new AuditPipeline({ ...baseMocks(), resultCache: cache } as any);
    expect(p.getResultCache()).toBe(cache);
  });

  // ── AI audit failure in runAiAudit ──────────────────

  it('auditAsync handles AI audit failure', async () => {
    const aiAuditor = { auditSkill: vi.fn().mockRejectedValue(new Error('ai down')) };
    const mocks = baseMocks({
      aiAuditor,
      riskScorer: { score: vi.fn().mockReturnValue({ decision: 'review', score: 55, reviewRequired: true, reason: 'mid' }) }
    });
    mocks.riskScorer.score
      .mockReturnValueOnce({ decision: 'review', score: 55, reviewRequired: true, reason: 'mid' });
    const p = new AuditPipeline(mocks as any);
    const result = p.auditAsync(makeSkill('mid'));
    expect(result.asyncHandle).toBeDefined();

    // The full audit catches AI errors gracefully, so it resolves with findings
    const fullResult = await result.asyncHandle!.getResult();
    expect(fullResult.findings.some((f: any) => f.source === 'ai' && f.message === 'AI auditor failed')).toBe(true);
    const status = p.getAsyncAuditStatus(result.asyncHandle!.requestId);
    expect(status.status).toBe('completed');
  });
});

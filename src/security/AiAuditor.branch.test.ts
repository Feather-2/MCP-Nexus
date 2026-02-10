import { computeAiSignalImpact, AiAuditor } from './AiAuditor.js';
import type { AiAuditorClient, AiRequest } from './AiAuditor.js';

describe('AiAuditor \u2013 branch coverage', () => {
  describe('computeAiSignalImpact', () => {
    it('safe risk returns zero impact', () => {
      const result = computeAiSignalImpact({ riskLevel: 'safe', confidence: 1 });
      expect(result.impact).toBe(0);
      expect(result.weight).toBe(0);
    });

    it('suspicious risk with confidence', () => {
      const result = computeAiSignalImpact({ riskLevel: 'suspicious', confidence: 0.8 });
      expect(result.impact).toBeLessThan(0);
      expect(result.weight).toBe(0.3);
    });

    it('malicious risk with full confidence', () => {
      const result = computeAiSignalImpact({ riskLevel: 'malicious', confidence: 1 });
      expect(result.impact).toBe(-50 * 0.5 * 1);
    });

    it('handles NaN confidence', () => {
      const result = computeAiSignalImpact({ riskLevel: 'suspicious', confidence: NaN });
      expect(result.impact).toBe(0);
    });

    it('handles negative confidence', () => {
      const result = computeAiSignalImpact({ riskLevel: 'suspicious', confidence: -1 });
      expect(result.impact).toBe(0);
    });

    it('handles confidence > 1', () => {
      const result = computeAiSignalImpact({ riskLevel: 'suspicious', confidence: 2 });
      expect(result.impact).toBe(-30 * 0.3 * 1);
    });
  });

  describe('AiAuditor.auditSkill', () => {
    const makeClient = (text: string): AiAuditorClient => ({
      generate: vi.fn().mockResolvedValue({ text })
    });

    const makeSkill = () => ({
      metadata: { name: 'test', description: 'test', path: '/test', scope: 'repo' as const, keywords: [], keywordsAll: [], priority: 0 },
      body: '# Test\nDo something safe.'
    });

    it('parses valid JSON response', async () => {
      const json = JSON.stringify({
        riskLevel: 'safe', confidence: 0.95,
        findings: [], recommendation: 'approve', explanation: 'No issues'
      });
      const auditor = new AiAuditor(makeClient(json));
      const result = await auditor.auditSkill(makeSkill() as any);
      expect(result.riskLevel).toBe('safe');
      expect(result.recommendation).toBe('approve');
    });

    it('parses JSON in code fence', async () => {
      const text = 'Here is the result:\n```json\n' + JSON.stringify({
        riskLevel: 'suspicious', confidence: 0.7,
        findings: [{ category: 'obfuscation', severity: 'medium', evidence: 'test', reasoning: 'test' }],
        recommendation: 'review', explanation: 'Some issues'
      }) + '\n```\n';
      const auditor = new AiAuditor(makeClient(text));
      const result = await auditor.auditSkill(makeSkill() as any);
      expect(result.riskLevel).toBe('suspicious');
    });

    it('extracts JSON object from mixed text', async () => {
      const json = JSON.stringify({
        riskLevel: 'malicious', confidence: 0.9,
        findings: [], recommendation: 'reject', explanation: 'Bad'
      });
      const text = 'Some preamble text ' + json + ' and more text';
      const auditor = new AiAuditor(makeClient(text));
      const result = await auditor.auditSkill(makeSkill() as any);
      expect(result.riskLevel).toBe('malicious');
    });

    it('handles escaped strings in JSON extraction', async () => {
      const json = JSON.stringify({
        riskLevel: 'safe', confidence: 0.8,
        findings: [], recommendation: 'approve', explanation: 'Contains \\"escaped\\" quotes'
      });
      const text = 'prefix ' + json;
      const auditor = new AiAuditor(makeClient(text));
      const result = await auditor.auditSkill(makeSkill() as any);
      expect(result.riskLevel).toBe('safe');
    });

    it('falls back when AI client throws', async () => {
      const client: AiAuditorClient = {
        generate: vi.fn().mockRejectedValue(new Error('API error'))
      };
      const auditor = new AiAuditor(client);
      const result = await auditor.auditSkill(makeSkill() as any);
      expect(result.riskLevel).toBe('suspicious');
      expect(result.confidence).toBe(0);
      expect(result.explanation).toContain('AI audit failed');
    });

    it('falls back on empty response', async () => {
      const client: AiAuditorClient = {
        generate: vi.fn().mockResolvedValue({ text: '' })
      };
      const auditor = new AiAuditor(client);
      const result = await auditor.auditSkill(makeSkill() as any);
      expect(result.riskLevel).toBe('suspicious');
    });

    it('falls back on invalid JSON', async () => {
      const auditor = new AiAuditor(makeClient('not json at all'));
      const result = await auditor.auditSkill(makeSkill() as any);
      expect(result.riskLevel).toBe('suspicious');
    });

    it('handles Chinese category names', async () => {
      const json = JSON.stringify({
        riskLevel: 'suspicious', confidence: 0.6,
        findings: [{ category: '\u6df7\u6dc6\u68c0\u6d4b', severity: 'high', evidence: 'test', reasoning: 'test' }],
        recommendation: 'review', explanation: 'Chinese categories'
      });
      const auditor = new AiAuditor(makeClient(json));
      const result = await auditor.auditSkill(makeSkill() as any);
      expect(result.findings[0]?.category).toBe('obfuscation');
    });

    it('handles confidence as string', async () => {
      const text = '{"riskLevel":"safe","confidence":"0.85","findings":[],"recommendation":"approve","explanation":"ok"}';
      const auditor = new AiAuditor(makeClient(text));
      const result = await auditor.auditSkill(makeSkill() as any);
      expect(result.confidence).toBe(0.85);
    });

    it('handles unclosed JSON object', async () => {
      const text = 'prefix {"riskLevel": "safe", "confidence": 0.5';
      const auditor = new AiAuditor(makeClient(text));
      const result = await auditor.auditSkill(makeSkill() as any);
      expect(result.riskLevel).toBe('suspicious');
    });

    it('uses custom options', async () => {
      const json = JSON.stringify({
        riskLevel: 'safe', confidence: 1, findings: [], recommendation: 'approve', explanation: 'ok'
      });
      const client = makeClient(json);
      const auditor = new AiAuditor(client, { channelId: 'test', model: 'gpt-4', temperature: 0.5, maxTokens: 500 });
      const result = await auditor.auditSkill(makeSkill() as any);
      expect(result.riskLevel).toBe('safe');
      expect(client.generate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-4', temperature: 0.5, maxTokens: 500 }),
        'test'
      );
    });

    it('handles findings as non-array', async () => {
      const text = '{"riskLevel":"safe","confidence":1,"findings":"not-array","recommendation":"approve","explanation":"ok"}';
      const auditor = new AiAuditor(makeClient(text));
      const result = await auditor.auditSkill(makeSkill() as any);
      expect(result.findings).toEqual([]);
    });

    it('handles hyphenated category names', async () => {
      const json = JSON.stringify({
        riskLevel: 'suspicious', confidence: 0.5,
        findings: [{ category: 'data-exfiltration', severity: 'high', evidence: 'x', reasoning: 'y' }],
        recommendation: 'review', explanation: 'test'
      });
      const auditor = new AiAuditor(makeClient(json));
      const result = await auditor.auditSkill(makeSkill() as any);
      expect(result.findings[0]?.category).toBe('data_exfiltration');
    });

    it('handles error without message property', async () => {
      const client: AiAuditorClient = {
        generate: vi.fn().mockRejectedValue('string error')
      };
      const auditor = new AiAuditor(client);
      const result = await auditor.auditSkill(makeSkill() as any);
      expect(result.riskLevel).toBe('suspicious');
    });
  });
});

